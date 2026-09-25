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

// A Minor member's guardian (migration 0107), against real migrations:
// while the guardian is demised no money leaves the minor's accounts but
// money still comes in; a new guardian is recorded by one officer and
// approved by another, and only then does the guardian block change.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `guardian_test_${Date.now()}`;
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
  return {
    guardian: await import('./guardian'),
    deposits: await import('../ledger/deposits'),
    withdrawals: await import('../ledger/withdrawals'),
    depositor: await import('../applications/depositor'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function principalFor(userId: string, email: string, permissions: string[]) {
  return {
    userId,
    entraSubject: `sub-${email}`,
    email,
    displayName: email,
    roles: ['account_officer'],
    roleNames: ['account officer'],
    permissions: new Set(permissions),
  } satisfies Principal;
}

let officer: Principal;
let manager: Principal;
let clerk: Principal;
let minor: { id: string; msa: string; applicationId: string };
let firstGuardian: { id: string; memberNo: string };
let secondGuardian: { id: string; memberNo: string };
let company: { id: string; memberNo: string };

async function newMember(
  typeCode: string,
  parties: Record<string, Record<string, string>>
) {
  const typeId = (
    await run(appUrl, `select id from membership_type where code = $1`, [
      typeCode,
    ])
  ).rows[0].id;
  const application = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [typeId, officer.userId]
  );
  const applicationId = application.rows[0].id;
  for (const [subject, values] of Object.entries(parties)) {
    await run(
      appUrl,
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, $2, 1, $3)`,
      [applicationId, subject, JSON.stringify(values)]
    );
  }
  const m = await run(
    appUrl,
    `insert into member (application_id, membership_type_id)
     values ($1, $2) returning id, member_no`,
    [applicationId, typeId]
  );
  const msa = await run(
    appUrl,
    `insert into account (member_id, account_type_id, is_membership_default, status)
     values ($1, (select id from account_type where code = 'msa'), true, 'active')
     returning id`,
    [m.rows[0].id]
  );
  return {
    id: m.rows[0].id as string,
    memberNo: m.rows[0].member_no as string,
    msa: msa.rows[0].id as string,
    applicationId: applicationId as string,
  };
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('officer@albarakah.mu', 'Officer'),
            ('manager@albarakah.mu', 'Manager'),
            ('clerk@albarakah.mu', 'Clerk')
     returning id, email`
  );
  const byEmail = new Map(users.rows.map(r => [r.email, r.id]));
  const money = ['transaction.capture', 'transaction.post', 'transaction.view'];
  officer = principalFor(
    byEmail.get('officer@albarakah.mu'),
    'officer@albarakah.mu',
    [...money, 'member.guardian_change']
  );
  manager = principalFor(
    byEmail.get('manager@albarakah.mu'),
    'manager@albarakah.mu',
    [...money, 'member.guardian_change', 'member.guardian_approve']
  );
  clerk = principalFor(
    byEmail.get('clerk@albarakah.mu'),
    'clerk@albarakah.mu',
    money
  );

  const g1 = await newMember('individual', {
    applicant: {
      name: 'Irfan',
      surname: 'Test',
      nic: 'I1111111111111',
      mobile: '+23057000001',
    },
  });
  const g2 = await newMember('individual', {
    applicant: {
      name: 'Salma',
      surname: 'Test',
      nic: 'S2222222222222',
      mobile: '+23057000002',
    },
  });
  const co = await newMember('corporate', {
    applicant: { name: 'Test Trading Ltd' },
  });
  firstGuardian = { id: g1.id, memberNo: g1.memberNo };
  secondGuardian = { id: g2.id, memberNo: g2.memberNo };
  company = { id: co.id, memberNo: co.memberNo };
  const m = await newMember('minor', {
    applicant: { name: 'Zara', surname: 'Test' },
    guardian: {
      name: 'Irfan',
      surname: 'Test',
      nic: 'I1111111111111',
      member_id: g1.memberNo,
      relationship: 'Father',
      mobile: '+23057000001',
    },
  });
  minor = { id: m.id, msa: m.msa, applicationId: m.applicationId };

  const { deposits } = await load();
  await deposits.recordDeposit(
    { accountId: minor.msa, amount: '5000', method: 'cash' },
    officer
  );
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe("a Minor's guardian", () => {
  it('holds nothing back, and cannot be changed, while the guardian is alive', async () => {
    const { guardian, withdrawals } = await load();
    expect(await guardian.guardianGoneMessage(minor.id)).toBeNull();
    expect(await guardian.guardianGoneMessage(firstGuardian.id)).toBeNull();
    const w = await withdrawals.recordWithdrawal(
      { accountId: minor.msa, amount: '100', method: 'cash' },
      officer
    );
    expect(w.status).toBe('posted');
    await expect(
      guardian.recordGuardianChange(
        minor.id,
        { guardianMemberNo: secondGuardian.memberNo, relationship: 'Mother' },
        officer
      )
    ).rejects.toThrowError(
      'The guardian can be changed only once they are demised.'
    );
  });

  it('stops money leaving, but not arriving, once the guardian is demised', async () => {
    await run(ownerUrl, `update member set status = 'demised' where id = $1`, [
      firstGuardian.id,
    ]);
    const { guardian, withdrawals, deposits, depositor } = await load();
    const message = await guardian.guardianGoneMessage(minor.id);
    expect(message).toBe(
      `The guardian, Irfan Test · ${firstGuardian.memberNo}, is demised. Record a new guardian first.`
    );
    await expect(
      withdrawals.recordWithdrawal(
        { accountId: minor.msa, amount: '100', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(message!);
    const d = await deposits.recordDeposit(
      { accountId: minor.msa, amount: '200', method: 'cash' },
      officer
    );
    expect(d.status).toBe('posted');
    // Whoever pays in now is not the guardian who died.
    expect(
      await depositor.depositorForApplication(minor.applicationId)
    ).toEqual({
      name: '',
      nic: '',
    });
    expect(await depositor.collectorForApplication(minor.applicationId)).toBe(
      ''
    );
  });

  it('refuses a new guardian who cannot be one', async () => {
    const { guardian } = await load();
    const input = (memberNo: string) => ({
      guardianMemberNo: memberNo,
      relationship: 'Mother',
    });
    await expect(
      guardian.recordGuardianChange(
        minor.id,
        input(secondGuardian.memberNo),
        clerk
      )
    ).rejects.toThrowError(/permission/);
    await expect(
      guardian.recordGuardianChange(
        firstGuardian.id,
        input(secondGuardian.memberNo),
        officer
      )
    ).rejects.toThrowError(/Only a minor has a guardian/);
    await expect(
      guardian.recordGuardianChange(
        minor.id,
        input(firstGuardian.memberNo),
        officer
      )
    ).rejects.toThrowError(/is demised, so cannot be a guardian/);
    await expect(
      guardian.recordGuardianChange(minor.id, input(company.memberNo), officer)
    ).rejects.toThrowError(/not an Individual member/);
    await expect(
      guardian.recordGuardianChange(
        minor.id,
        { guardianMemberNo: secondGuardian.memberNo, relationship: ' ' },
        officer
      )
    ).rejects.toThrowError(/relationship/);
  });

  it('changes only once a second person approves it', async () => {
    const { guardian, withdrawals, depositor } = await load();
    const change = await guardian.recordGuardianChange(
      minor.id,
      { guardianMemberNo: secondGuardian.memberNo, relationship: 'Mother' },
      officer
    );
    expect(change.status).toBe('submitted');
    expect(change.newValues).toEqual({
      surname: 'Test',
      name: 'Salma',
      nic: 'S2222222222222',
      member_id: secondGuardian.memberNo,
      relationship: 'Mother',
      mobile: '+23057000002',
    });
    expect(change.previousValues.member_id).toBe(firstGuardian.memberNo);
    // Nothing moves yet.
    expect((await guardian.currentGuardian(minor.id))?.memberNo).toBe(
      firstGuardian.memberNo
    );
    expect(await guardian.guardianGoneMessage(minor.id)).not.toBeNull();
    await expect(
      guardian.recordGuardianChange(
        minor.id,
        { guardianMemberNo: secondGuardian.memberNo, relationship: 'Aunt' },
        manager
      )
    ).rejects.toThrowError(/already waiting/);
    expect(await guardian.guardianChangesWaitingOn(officer)).toEqual([]);
    expect(await guardian.guardianChangesWaitingOn(manager)).toEqual([
      { memberId: minor.id, memberNo: expect.any(String), name: 'Zara Test' },
    ]);

    await expect(
      guardian.decideGuardianChange(change.id, 'approve', '', officer)
    ).rejects.toThrowError(/permission/);
    const recorder = { ...manager, userId: officer.userId };
    await expect(
      guardian.decideGuardianChange(change.id, 'approve', '', recorder)
    ).rejects.toThrowError(/Someone other than the officer/);
    await expect(
      guardian.decideGuardianChange(change.id, 'reject', ' ', manager)
    ).rejects.toThrowError(/reason/);

    const decided = await guardian.decideGuardianChange(
      change.id,
      'approve',
      '',
      manager
    );
    expect(decided.status).toBe('approved');
    const now = await guardian.currentGuardian(minor.id);
    expect(now).toMatchObject({
      memberId: secondGuardian.id,
      memberNo: secondGuardian.memberNo,
      name: 'Salma Test',
      status: 'active',
    });
    expect(await guardian.guardianGoneMessage(minor.id)).toBeNull();
    const w = await withdrawals.recordWithdrawal(
      { accountId: minor.msa, amount: '100', method: 'cash' },
      officer
    );
    expect(w.status).toBe('posted');
    expect(await depositor.collectorForApplication(minor.applicationId)).toBe(
      'Salma Test'
    );
    const audit = await run(
      appUrl,
      `select action from audit_event
        where action like 'member.guardian%' order by id`
    );
    expect(audit.rows.map(r => r.action)).toEqual([
      'member.guardian_change.recorded',
      'member.guardian_changed',
    ]);
  });

  it('lets the recorder withdraw a change, and nobody else', async () => {
    const { guardian } = await load();
    // The second guardian is alive, so nobody replaces them yet.
    await run(ownerUrl, `update member set status = 'active' where id = $1`, [
      firstGuardian.id,
    ]);
    await expect(
      guardian.recordGuardianChange(
        minor.id,
        { guardianMemberNo: firstGuardian.memberNo, relationship: 'Father' },
        officer
      )
    ).rejects.toThrowError(/only once they are demised/);
    await run(ownerUrl, `update member set status = 'demised' where id = $1`, [
      secondGuardian.id,
    ]);
    const second = await guardian.recordGuardianChange(
      minor.id,
      { guardianMemberNo: firstGuardian.memberNo, relationship: 'Father' },
      officer
    );
    await expect(
      guardian.cancelGuardianChange(second.id, manager)
    ).rejects.toThrowError(/Only the officer who recorded it/);
    await guardian.cancelGuardianChange(second.id, officer);
    expect(await guardian.openGuardianChange(minor.id)).toBeNull();
    expect(
      (await guardian.guardianChanges(minor.id)).map(c => c.status)
    ).toEqual(['cancelled', 'approved']);
  });
  it('holds back and changes the guardian of a minor who is not a member, the same way', async () => {
    // At this point the second guardian is demised (the test above) and the
    // first is active again.
    const typeId = (
      await run(appUrl, `select id from membership_type where code = 'minor'`)
    ).rows[0].id;
    const application = await run(
      appUrl,
      `insert into membership_application (membership_type_id, captured_by, status)
       values ($1, $2, 'approved') returning id`,
      [typeId, officer.userId]
    );
    await run(
      appUrl,
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'applicant', 1, '{"name": "Adam", "surname": "Test"}'),
              ($1, 'guardian', 1, $2)`,
      [
        application.rows[0].id,
        JSON.stringify({
          name: 'Salma',
          surname: 'Test',
          member_id: secondGuardian.memberNo,
          relationship: 'Mother',
        }),
      ]
    );
    const customer = (
      await run(
        appUrl,
        `insert into customer (application_id) values ($1) returning id`,
        [application.rows[0].id]
      )
    ).rows[0].id;
    const hsa = (
      await run(
        appUrl,
        `insert into account
           (customer_id, account_type_id, is_membership_default, status, account_no)
         values ($1, (select id from account_type where code = 'msa'), false,
                 'active', 'HSA0444')
         returning id`,
        [customer]
      )
    ).rows[0].id;
    const { guardian, deposits, withdrawals } = await load();
    await deposits.recordDeposit(
      { accountId: hsa, amount: '3000', method: 'cash' },
      officer
    );
    expect(await guardian.guardianGoneMessage(customer)).toMatch(
      /Record a new guardian first/
    );
    await expect(
      withdrawals.recordWithdrawal(
        { accountId: hsa, amount: '100', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/Record a new guardian first/);

    const change = await guardian.recordGuardianChange(
      customer,
      { guardianMemberNo: firstGuardian.memberNo, relationship: 'Father' },
      officer
    );
    expect(change.memberId).toBe(customer);
    expect(await guardian.guardianChangesWaitingOn(manager)).toEqual([
      { memberId: customer, memberNo: '', name: 'Adam Test' },
    ]);
    await guardian.decideGuardianChange(change.id, 'approve', '', manager);
    expect((await guardian.currentGuardian(customer))?.memberNo).toBe(
      firstGuardian.memberNo
    );
    expect(await guardian.guardianGoneMessage(customer)).toBeNull();
    const w = await withdrawals.recordWithdrawal(
      { accountId: hsa, amount: '100', method: 'cash' },
      officer
    );
    expect(w.status).toBe('posted');
  });
});
