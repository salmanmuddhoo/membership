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

// After an exit (M26), against real migrations: a resigned member rejoins
// through a membership application that names them, and comes back as the
// member they were — same row, same AB number, the Shares and MSA the
// resignation closed reactivated under their own ids; a closed additional
// account reopens through an additional-account application for its type,
// under the number it had.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `rejoin_test_${Date.now()}`;
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

const configure = (sql: string) =>
  run(
    appUrl,
    `begin; set local albarakah.actor_description = 'rejoin.test'; ${sql}; commit;`
  );

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
  return {
    pool: openPool,
    capture: await import('../applications/capture'),
    create: await import('./create'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let actor: { userId: string; email: string };
let member: {
  id: string;
  memberNo: string;
  applicationId: string;
  shares: string;
  msa: string;
  hsa: string;
};
let hsaTypeId: string;

async function memberRow() {
  return (
    await run(
      appUrl,
      `select status, rejoined_at, application_id, member_no
         from member where id = $1`,
      [member.id]
    )
  ).rows[0];
}

async function accountRow(id: string) {
  return (
    await run(
      appUrl,
      `select status, closed_at, reopened_at, account_no from account
        where id = $1`,
      [id]
    )
  ).rows[0];
}

async function audits(entityId: string) {
  return (
    await run(
      appUrl,
      `select action from audit_event where entity_id = $1 order by id`,
      [entityId]
    )
  ).rows.map(r => r.action);
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('officer@albarakah.mu', 'Officer') returning id`
  );
  actor = { userId: user.rows[0].id, email: 'officer@albarakah.mu' };

  await configure(
    `insert into account_type
       (code, name, category, number_prefix, sort_order, allows_withdrawal)
     values ('hsa', 'Hajj Savings', 'savings', 'HSA', 5, false)`
  );

  const membershipTypeId = (
    await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    )
  ).rows[0].id;
  const application = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [membershipTypeId, actor.userId]
  );
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1,
             '{"name": "Amina", "surname": "Test", "nic": "A1234567890123"}')`,
    [application.rows[0].id]
  );
  const m = await run(
    appUrl,
    `insert into member (application_id, membership_type_id)
     values ($1, $2) returning id, member_no`,
    [application.rows[0].id, membershipTypeId]
  );
  await run(
    appUrl,
    `update membership_application set reference = $2 where id = $1`,
    [application.rows[0].id, m.rows[0].member_no]
  );
  const types = Object.fromEntries(
    (await run(appUrl, `select code, id from account_type`)).rows.map(r => [
      r.code,
      r.id,
    ])
  );
  hsaTypeId = types.hsa;
  const open = async (code: string, accountNo: string | null) =>
    (
      await run(
        appUrl,
        `insert into account
           (member_id, account_type_id, is_membership_default, status, account_no)
         values ($1, $2, $3, 'active', $4) returning id`,
        [m.rows[0].id, types[code], accountNo === null, accountNo]
      )
    ).rows[0].id;
  member = {
    id: m.rows[0].id,
    memberNo: m.rows[0].member_no,
    applicationId: application.rows[0].id,
    shares: await open('shares', null),
    msa: await open('msa', null),
    hsa: await open('hsa', 'HSA0001'),
  };
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

// What a resignation leaves behind (resignations.test.ts proves the
// disbursement does exactly this): the two core accounts closed, the
// membership ended.
async function resign() {
  await run(
    appUrl,
    `update account set status = 'closed', closed_at = now()
      where id = any($1::uuid[])`,
    [[member.shares, member.msa]]
  );
  await run(
    appUrl,
    `update member set status = 'resigned', status_changed_at = now()
      where id = $1`,
    [member.id]
  );
}

describe('rejoining (M26)', () => {
  it('is only for a resigned member, and only one application at a time', async () => {
    const { capture } = await load();
    await expect(
      capture.startRejoinApplication(member.id, actor)
    ).rejects.toThrowError(/Only a resigned member can rejoin/);

    await resign();
    expect(await capture.rejoinInFlightFor(member.id)).toBeNull();

    const started = await capture.startRejoinApplication(member.id, actor);
    expect(started.reference).toMatch(/^APP-/);
    expect(await capture.rejoinInFlightFor(member.id)).toMatchObject({
      id: started.id,
      status: 'draft',
    });
    await expect(
      capture.startRejoinApplication(member.id, actor)
    ).rejects.toThrowError(/already on its way/);

    // The application names the member, files into their founding folder,
    // and starts from the parties on file rather than blank.
    const application = await capture.loadApplication(started.id);
    expect(application).toMatchObject({
      applicationKind: 'membership',
      rejoinsMemberId: member.id,
      rejoinsMemberNo: member.memberNo,
      membershipTypeCode: 'individual',
    });
    const applicant = application!.parties.find(
      p => p.subject === 'applicant' && p.ordinal === 1
    );
    expect(applicant?.values).toMatchObject({ name: 'Amina', surname: 'Test' });
    // Their own NIC, on file for them, is not someone else's: the rejoin
    // application is not refused as a duplicate of the member it re-admits.
    const problems = await capture.problemsBlockingSubmission(application!);
    expect(problems.map(p => p.label).join(' ')).not.toMatch(/already on file/);
    const folder = await run(
      appUrl,
      `select folder_application_id from membership_application where id = $1`,
      [started.id]
    );
    expect(folder.rows[0].folder_application_id).toBe(member.applicationId);
  });

  it('brings the member back as themselves on approval, with the core accounts', async () => {
    const { capture, create, pool } = await load();
    const inFlight = (await capture.rejoinInFlightFor(member.id))!;
    const application = (await capture.loadApplication(inFlight.id))!;

    const created = await pool.withTransaction(client =>
      create.createMemberFromApplication(client, application, actor)
    );
    // The same member, the same number — not a second one.
    expect(created).toMatchObject({ id: member.id, memberNo: member.memberNo });
    expect(created.accounts.map(a => a.id).sort()).toEqual(
      [member.shares, member.msa].sort()
    );
    expect(
      (await run(appUrl, `select count(*)::int as n from member`)).rows[0].n
    ).toBe(1);

    expect(await memberRow()).toMatchObject({
      status: 'active',
      rejoined_at: expect.any(Date),
      application_id: inFlight.id,
      member_no: member.memberNo,
    });
    for (const id of [member.shares, member.msa]) {
      expect(await accountRow(id)).toMatchObject({
        status: 'active',
        closed_at: null,
        reopened_at: expect.any(Date),
      });
      expect(await audits(id)).toContain('account.reopened');
    }
    expect(await audits(member.id)).toContain('member.rejoined');
    // The rejoin application keeps its own reference: the AB number already
    // belongs to the founding application.
    const reference = await run(
      appUrl,
      `select reference from membership_application where id = $1`,
      [inFlight.id]
    );
    expect(reference.rows[0].reference).toBe(inFlight.reference);

    // The page reads it back: rejoined on, and each account's reopening.
    const detail = (await create.loadMember(member.id))!;
    expect(detail.rejoinedAt).toEqual(expect.any(Date));
    expect(
      detail.accounts.find(a => a.id === member.shares)?.reopenedAt
    ).toEqual(expect.any(Date));
    expect(detail.accounts.find(a => a.id === member.hsa)?.reopenedAt).toBe(
      null
    );

    // Approving it twice cannot re-admit a member who is already back.
    await expect(
      pool.withTransaction(client =>
        create.createMemberFromApplication(client, application, actor)
      )
    ).rejects.toThrowError(/not resigned/);
  });
});

describe('reopening a closed account (M26)', () => {
  it('goes through an additional-account application for the type, and comes back under its own number', async () => {
    const { capture, create, pool } = await load();
    await run(
      appUrl,
      `update account set status = 'closed', closed_at = now() where id = $1`,
      [member.hsa]
    );

    const started = await capture.startAdditionalAccountApplication(
      member.id,
      [hsaTypeId],
      actor
    );
    const inFlight = await capture.accountApplicationsInFlightFor(member.id);
    expect(inFlight.get(hsaTypeId)).toMatchObject({ id: started.id });

    const application = (await capture.loadApplication(started.id))!;
    const opened = await pool.withTransaction(client =>
      create.openAccountsForApplication(client, application, actor)
    );
    expect(opened.accounts).toEqual([
      expect.objectContaining({ id: member.hsa, accountNo: 'HSA0001' }),
    ]);
    expect(await accountRow(member.hsa)).toMatchObject({
      status: 'active',
      closed_at: null,
      reopened_at: expect.any(Date),
      account_no: 'HSA0001',
    });
    expect(await audits(member.hsa)).toContain('account.reopened');
    expect(
      (
        await run(
          appUrl,
          `select count(*)::int as n from account where member_id = $1`,
          [member.id]
        )
      ).rows[0].n
    ).toBe(3);

    // Open again, a second application for the type is refused at approval
    // exactly as before.
    await run(
      appUrl,
      `update membership_application set status = 'approved' where id = $1`,
      [started.id]
    );
    const again = await capture.startAdditionalAccountApplication(
      member.id,
      [hsaTypeId],
      actor
    );
    const second = (await capture.loadApplication(again.id))!;
    await expect(
      pool.withTransaction(client =>
        create.openAccountsForApplication(client, second, actor)
      )
    ).rejects.toThrowError(/already has Hajj Savings open/);
  });
});

describe('a resigned member opening a further account', () => {
  it('opens through the same application, under their existing record, and the list shows only what they hold', async () => {
    const { capture, create, pool } = await load();
    await configure(
      `insert into account_type
         (code, name, category, number_prefix, sort_order)
       values ('inv', 'Investment', 'investment', 'INV', 6)`
    );
    const invTypeId = (
      await run(appUrl, `select id from account_type where code = 'inv'`)
    ).rows[0].id;
    await resign();

    // The list: a closed account has no badge.
    const listed = (await create.listMembers({ search: member.memberNo }))
      .members[0];
    expect(listed.accountBadges.map((b: { code: string }) => b.code)).toEqual([
      'hsa',
    ]);
    // Resigned, with an account still open: a non-member now.
    expect(listed.nonMember).toBe(true);

    const started = await capture.startAdditionalAccountApplication(
      member.id,
      [invTypeId],
      actor
    );
    const application = (await capture.loadApplication(started.id))!;
    const opened = await pool.withTransaction(client =>
      create.openAccountsForApplication(client, application, actor)
    );
    expect(opened).toMatchObject({ id: member.id, memberNo: member.memberNo });
    expect(opened.accounts).toEqual([
      expect.objectContaining({ typeCode: 'inv', accountNo: 'INV0001' }),
    ]);
    // Still resigned: a further account is not a rejoin.
    expect((await memberRow()).status).toBe('resigned');
    const after = (await create.listMembers({ search: member.memberNo }))
      .members[0];
    expect(
      after.accountBadges.map((b: { code: string }) => b.code).sort()
    ).toEqual(['hsa', 'inv']);

    // Shares and the MSA are not opened this way: that is a rejoin.
    const sharesTypeId = (
      await run(appUrl, `select id from account_type where code = 'shares'`)
    ).rows[0].id;
    await expect(
      capture.startAdditionalAccountApplication(
        member.id,
        [sharesTypeId],
        actor
      )
    ).rejects.toThrowError(/no longer available to open this way/);
  });
});
