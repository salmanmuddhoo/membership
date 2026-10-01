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
import type { Principal } from '../access/principal';
import type { MemberPrincipal } from './identity';

// A guardian reading the minors in their care (member/dependents): who the
// guardian block names, and only them, and only their accounts.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `member_dependents_test_${Date.now()}`;
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

async function load() {
  if (openPool) await openPool.closePool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  delete process.env.NOTIFY_EMAIL_DELIVERY;
  delete process.env.NOTIFY_WHATSAPP_DELIVERY;
  openPool = await import('../db/pool');
  return {
    dependents: await import('./dependents'),
    deposits: await import('../ledger/deposits'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function memberPrincipal(memberId: string | null, mobile: string) {
  return {
    sessionId: `session-${mobile}`,
    mobile,
    memberId,
    customerId: null,
    kind: memberId ? 'member' : 'applicant',
  } as MemberPrincipal;
}

let officer: Principal;

// An individual member, with an NIC on their applicant party so a guardian
// block can name them either way.
async function individual(memberNo: string, name: string, nic: string) {
  const type = await run(
    appUrl,
    `select id from membership_type where code = 'individual'`
  );
  const app = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [type.rows[0].id, officer.userId]
  );
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb)`,
    [app.rows[0].id, JSON.stringify({ name, surname: 'Test', nic })]
  );
  const member = await run(
    appUrl,
    `insert into member (member_no, application_id, membership_type_id)
     values ($1, $2, $3) returning id`,
    [memberNo, app.rows[0].id, type.rows[0].id]
  );
  return member.rows[0].id as string;
}

// A minor member with an MSA account and a guardian block. `guardian` is the
// block written at capture: whatever names the guardian (member_id, nic, or
// both), plus the relationship.
async function minorWithMsa(
  memberNo: string,
  name: string,
  guardian: Record<string, string>
) {
  const type = await run(
    appUrl,
    `select id from membership_type where code = 'minor'`
  );
  const app = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [type.rows[0].id, officer.userId]
  );
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb), ($1, 'guardian', 1, $3::jsonb)`,
    [
      app.rows[0].id,
      JSON.stringify({ name, surname: 'Test' }),
      JSON.stringify(guardian),
    ]
  );
  const member = await run(
    appUrl,
    `insert into member (member_no, application_id, membership_type_id)
     values ($1, $2, $3) returning id`,
    [memberNo, app.rows[0].id, type.rows[0].id]
  );
  const account = await run(
    appUrl,
    `insert into account (member_id, account_type_id, is_membership_default, status)
     select $1, id, true, 'active' from account_type where code = 'msa'
     returning id`,
    [member.rows[0].id]
  );
  return {
    memberId: member.rows[0].id as string,
    msa: account.rows[0].id as string,
  };
}

let guardian: MemberPrincipal;
let stranger: MemberPrincipal;
let applicant: MemberPrincipal;
let zainab: { memberId: string; msa: string }; // guarded by member no
let bilal: { memberId: string; msa: string }; // guarded by NIC only
let unrelated: { memberId: string; msa: string }; // guarded by someone else

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('test-officer', 'officer@albarakah.mu', 'Officer') returning id`
  );
  officer = {
    userId: user.rows[0].id,
    entraSubject: 'test-officer',
    email: 'officer@albarakah.mu',
    displayName: 'Officer',
    roles: ['account_officer'],
    roleNames: ['Account Officer'],
    permissions: new Set([
      'transaction.capture',
      'transaction.post',
      'transaction.disburse',
      'transaction.view',
    ]),
  };

  const guardianId = await individual('AB0100', 'Aisha', 'G1234567890123');
  const strangerId = await individual('AB0200', 'Omar', 'S9999999999999');
  guardian = memberPrincipal(guardianId, '+23057800100');
  stranger = memberPrincipal(strangerId, '+23057800200');
  applicant = memberPrincipal(null, '+23057800000');

  // Named by the guardian's Member No.
  zainab = await minorWithMsa('AB0101', 'Zainab', {
    member_id: 'AB0100',
    nic: 'G1234567890123',
    relationship: 'Mother',
  });
  // Named only by NIC — capture did not record the guardian's Member No.
  bilal = await minorWithMsa('AB0102', 'Bilal', {
    nic: 'G1234567890123',
    relationship: 'Mother',
  });
  // A minor guarded by someone else entirely.
  unrelated = await minorWithMsa('AB0103', 'Yusuf', {
    member_id: 'AB0200',
    nic: 'S9999999999999',
    relationship: 'Father',
  });

  const { deposits } = await load();
  await deposits.recordDeposit(
    { accountId: zainab.msa, amount: '750', method: 'cash' },
    officer
  );
}, 60_000);

afterAll(async () => {
  if (openPool) await openPool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('the minors a guardian may read', () => {
  it('lists the minors the block names, by Member No. or NIC, with balances', async () => {
    const { dependents } = await load();
    const list = await dependents.listDependents(guardian);
    // Both minors that name the guardian, and not the one that names another.
    expect(list.map(d => d.memberNo).sort()).toEqual(['AB0101', 'AB0102']);
    expect(list.every(d => d.relationship === 'Mother')).toBe(true);

    const z = list.find(d => d.memberNo === 'AB0101')!;
    expect(z.name).toBe('Zainab Test');
    expect(z.kind).toBe('member');
    expect(z.accounts).toHaveLength(1);
    expect(z.accounts[0].balance).toBe('750.00');

    // Named by NIC alone, still found — with its own (untouched) balance.
    const b = list.find(d => d.memberNo === 'AB0102')!;
    expect(b.accounts[0].balance).toBeNull();
  });

  it('is empty for a member who guards nobody, and for an applicant', async () => {
    const { dependents } = await load();
    expect(await dependents.listDependents(stranger)).not.toContainEqual(
      expect.objectContaining({ memberNo: 'AB0101' })
    );
    // Omar guards only Yusuf; he does not see Aisha's minors.
    expect(
      (await dependents.listDependents(stranger)).map(d => d.memberNo)
    ).toEqual(['AB0103']);
    expect(await dependents.listDependents(applicant)).toEqual([]);
  });

  it("reads a guarded minor's transactions, and refuses everything else alike", async () => {
    const { dependents } = await load();
    const tx = await dependents.dependentAccountTransactions(
      guardian,
      zainab.memberId,
      zainab.msa
    );
    expect(tx.map(t => t.amount)).toEqual(['750.00']);

    // A minor they do not guard; that minor's own account; an account that is
    // not this minor's; a non-uuid; an applicant caller — all not_found.
    for (const [who, dep, acc] of [
      [guardian, unrelated.memberId, unrelated.msa],
      [guardian, zainab.memberId, unrelated.msa],
      [guardian, zainab.memberId, '00000000-0000-0000-0000-000000000000'],
      [guardian, zainab.memberId, 'not-an-id'],
      [stranger, zainab.memberId, zainab.msa],
      [applicant, zainab.memberId, zainab.msa],
    ] as const) {
      await expect(
        dependents.dependentAccountTransactions(who, dep, acc)
      ).rejects.toMatchObject({ code: 'not_found' });
    }
  });
});
