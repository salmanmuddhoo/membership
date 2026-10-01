import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { migrate } from '../../../scripts/migrate';

// listMembers' own paging and status filter (officer request), against real
// migrations rather than mocked SQL — the filter is a handful of ANDed
// conditions on has_open/status/kind that are easy to get subtly wrong, and
// only a real query catches that. Records are inserted directly (as
// rejoin.test.ts does), skipping the capture/approval flow neither of these
// two things touches.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `members_list_test_${Date.now()}`;
const ownerUrl = `postgresql://postgres@127.0.0.1:5433/${dbName}`;
const appUrl = `postgresql://albarakah_app:devpassword@127.0.0.1:5433/${dbName}`;

async function run(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

let openPool: typeof import('../db/pool') | null = null;

async function closeOpenPool() {
  if (openPool) {
    await openPool.closePool();
    openPool = null;
  }
}

async function load() {
  await closeOpenPool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  openPool = await import('../db/pool');
  return { create: await import('./create') };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let membershipTypeId: string;
let sharesTypeId: string;
let msaTypeId: string;

// A member or customer's applicant party, and (for a member) the member
// row's own status — everything listMembers reads that this suite cares
// about, none of the rest (capture, documents, fees) any of it touches.
async function application(): Promise<string> {
  const actor = (await run(appUrl, `select id from app_user limit 1`)).rows[0]
    .id;
  const app = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [membershipTypeId, actor]
  );
  return app.rows[0].id;
}

async function party(applicationId: string, name: string): Promise<void> {
  const [first, ...rest] = name.split(' ');
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2)`,
    [applicationId, JSON.stringify({ name: first, surname: rest.join(' ') })]
  );
}

async function account(
  ownerColumn: 'member_id' | 'customer_id',
  ownerId: string,
  typeId: string,
  status: string,
  accountNo?: string
): Promise<void> {
  await run(
    appUrl,
    `insert into account
       (${ownerColumn}, account_type_id, status, account_no, closed_at)
     values ($1, $2, $3, $4, case when $3 = 'closed' then now() end)`,
    [ownerId, typeId, status, accountNo ?? null]
  );
}

// A member with the given stored status and accounts (each 'active' or
// 'closed'), returned with its id and name so a test can find it back in
// listMembers' results.
async function insertMember(
  name: string,
  status: string,
  accounts: { typeId: string; status: string }[]
): Promise<{ id: string; name: string }> {
  const applicationId = await application();
  await party(applicationId, name);
  const member = await run(
    appUrl,
    `insert into member (application_id, membership_type_id, status)
     values ($1, $2, $3) returning id`,
    [applicationId, membershipTypeId, status]
  );
  const id = member.rows[0].id;
  for (const a of accounts) {
    await account('member_id', id, a.typeId, a.status);
  }
  return { id, name };
}

let accountNoSeq = 0;

// A customer (S-614) with the given stored status and accounts, each
// getting its own HSA0001-style number since a customer's accounts share
// none, unlike a member's.
async function insertCustomer(
  name: string,
  status: string,
  accounts: { typeId: string; status: string }[]
): Promise<{ id: string; name: string }> {
  const applicationId = await application();
  await run(
    appUrl,
    `update membership_application set application_kind = 'customer_account',
            existing_member_id = null
      where id = $1`,
    [applicationId]
  );
  await party(applicationId, name);
  const customer = await run(
    appUrl,
    `insert into customer (application_id, status) values ($1, $2) returning id`,
    [applicationId, status]
  );
  const id = customer.rows[0].id;
  for (const a of accounts) {
    accountNoSeq += 1;
    await account(
      'customer_id',
      id,
      a.typeId,
      a.status,
      `TST${String(accountNoSeq).padStart(4, '0')}`
    );
  }
  return { id, name };
}

let active: { id: string; name: string };
let dormant: { id: string; name: string };
let inactive: { id: string; name: string };
let resignedOpen: { id: string; name: string };
let resignedClosed: { id: string; name: string };
let demised: { id: string; name: string };
let customerOpen: { id: string; name: string };
let customerClosed: { id: string; name: string };

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('officer@albarakah.mu', 'Officer')`
  );

  membershipTypeId = (
    await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    )
  ).rows[0].id;
  const types = Object.fromEntries(
    (await run(appUrl, `select code, id from account_type`)).rows.map(r => [
      r.code,
      r.id,
    ])
  );
  sharesTypeId = types.shares;
  msaTypeId = types.msa;

  active = await insertMember('Ayesha Active', 'active', [
    { typeId: sharesTypeId, status: 'active' },
    { typeId: msaTypeId, status: 'active' },
  ]);
  dormant = await insertMember('Bilal Dormant', 'dormant', [
    { typeId: sharesTypeId, status: 'active' },
    { typeId: msaTypeId, status: 'active' },
  ]);
  inactive = await insertMember('Chand Inactive', 'inactive', [
    { typeId: sharesTypeId, status: 'active' },
    { typeId: msaTypeId, status: 'active' },
  ]);
  // Resigned, Shares and the MSA closed as a resignation leaves them, but
  // one further account (an HSA-style one this member kept) still open —
  // the Status column shows this as an active non-member.
  resignedOpen = await insertMember('Dinesh Resigned-Open', 'resigned', [
    { typeId: sharesTypeId, status: 'closed' },
    { typeId: msaTypeId, status: 'closed' },
    { typeId: sharesTypeId, status: 'active' },
  ]);
  // Resigned with nothing left open at all.
  resignedClosed = await insertMember('Elvis Resigned-Closed', 'resigned', [
    { typeId: sharesTypeId, status: 'closed' },
    { typeId: msaTypeId, status: 'closed' },
  ]);
  demised = await insertMember('Farida Demised', 'demised', [
    { typeId: sharesTypeId, status: 'closed' },
    { typeId: msaTypeId, status: 'closed' },
  ]);
  // A customer (never a member), one account still open.
  customerOpen = await insertCustomer('Grace Customer-Open', 'active', [
    { typeId: sharesTypeId, status: 'active' },
  ]);
  // A customer whose every account has closed — markCustomerClosedOnceAllClosed
  // keeps customer.status = 'closed' in step with that, so the filter reads
  // the stored status rather than re-deriving it.
  customerClosed = await insertCustomer('Hassan Customer-Closed', 'closed', [
    { typeId: sharesTypeId, status: 'closed' },
  ]);
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('listMembers paging', () => {
  it('takes limit/offset instead of a fixed page of 100', async () => {
    const { create } = await load();
    const first = await create.listMembers({ limit: 3, offset: 0 });
    const second = await create.listMembers({ limit: 3, offset: 3 });
    const third = await create.listMembers({ limit: 3, offset: 6 });

    expect(first.members).toHaveLength(3);
    expect(second.members).toHaveLength(3);
    expect(third.members).toHaveLength(2);
    // Every row, once each, across the pages — the same total on every page.
    expect(first.total).toBe(8);
    expect(second.total).toBe(8);
    expect(third.total).toBe(8);
    const ids = [...first.members, ...second.members, ...third.members].map(
      m => m.id
    );
    expect(new Set(ids).size).toBe(8);
  });

  it('caps the limit at the largest page size an officer may choose', async () => {
    const { create } = await load();
    expect(create.MEMBER_LIST_PAGE_SIZE).toBe(50);
    const result = await create.listMembers({ limit: 10_000 });
    expect(result.pageSize).toBe(50);
  });
});

describe('listMembers status filter', () => {
  it('matches what the Status column shows, not the raw stored status', async () => {
    const { create } = await load();

    // Active: an active member, plus a resigned member still holding an
    // open account (shown as an active non-member).
    const activeFilter = await create.listMembers({ status: 'active' });
    expect(activeFilter.members.map(m => m.id).sort()).toEqual(
      [active.id, resignedOpen.id].sort()
    );

    const dormantFilter = await create.listMembers({ status: 'dormant' });
    expect(dormantFilter.members.map(m => m.id)).toEqual([dormant.id]);

    const inactiveFilter = await create.listMembers({ status: 'inactive' });
    expect(inactiveFilter.members.map(m => m.id)).toEqual([inactive.id]);

    // Resigned: only one with nothing left open — the one still holding an
    // account is under 'active'/'non_member' instead.
    const resignedFilter = await create.listMembers({ status: 'resigned' });
    expect(resignedFilter.members.map(m => m.id)).toEqual([resignedClosed.id]);

    const demisedFilter = await create.listMembers({ status: 'demised' });
    expect(demisedFilter.members.map(m => m.id)).toEqual([demised.id]);

    // Non-member: a customer, or a resigned member, still holding an open
    // account.
    const nonMemberFilter = await create.listMembers({ status: 'non_member' });
    expect(nonMemberFilter.members.map(m => m.id).sort()).toEqual(
      [resignedOpen.id, customerOpen.id].sort()
    );

    // Closed: a customer with every account closed.
    const closedFilter = await create.listMembers({ status: 'closed' });
    expect(closedFilter.members.map(m => m.id)).toEqual([customerClosed.id]);

    // An unrecognised value is treated the same as no filter at all.
    const allFilter = await create.listMembers({ status: 'not-a-status' });
    expect(allFilter.total).toBe(8);
  });

  it('filters before counting and paging, so the counts follow it', async () => {
    const { create } = await load();
    const result = await create.listMembers({ status: 'active', limit: 1 });
    expect(result.total).toBe(2);
    expect(result.members).toHaveLength(1);
  });
});
