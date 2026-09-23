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

// Resigning from the Society (S-1703), against real migrations: the
// pre-checks and their switches, the request's life before its chain, the
// chain, and the one disbursement that empties both core accounts, closes
// them and ends the membership.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `resignations_test_${Date.now()}`;
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
    `begin; set local albarakah.actor_description = 'resignations.test'; ${sql}; commit;`
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
    resignations: await import('./resignations'),
    closures: await import('./closures'),
    deposits: await import('./deposits'),
    review: await import('./review'),
    ledger: await import('./ledger'),
    timeline: await import('../workflow/timeline'),
    config: await import('../config/reference'),
    cache: await import('../config/cache'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let clerk: Principal;
let officer: Principal;
let treasurer: Principal;
let secretary: Principal;
let president: Principal;
let member: { id: string; shares: string; msa: string; hsa: string };
let requestTypeId: string;
let bankAccountId: string;

function principalFor(
  userId: string,
  email: string,
  roles: string[],
  permissions: string[]
) {
  return {
    userId,
    entraSubject: `sub-${email}`,
    email,
    displayName: email,
    roles,
    roleNames: roles.map(r => r.replace('_', ' ')),
    permissions: new Set(permissions),
  } satisfies Principal;
}

async function fileRequest(transactionId: string, by: Principal) {
  const doc = await run(
    appUrl,
    `insert into document (document_type_id, subject, transaction_id, state)
     values ($1, 'applicant', $2, 'under_review') returning id`,
    [requestTypeId, transactionId]
  );
  await run(
    appUrl,
    `insert into document_version
       (document_id, version_no, state, file_name, content_type, size_bytes,
        sharepoint_path, uploaded_by, committed_at)
     values ($1, 1, 'committed', 'Resignation request.pdf',
             'application/pdf', 1234, '/test/resignation.pdf', $2, now())`,
    [doc.rows[0].id, by.userId]
  );
}

async function accountStatus(id: string) {
  return (
    await run(appUrl, `select status, closed_at from account where id = $1`, [
      id,
    ])
  ).rows[0];
}

async function memberStatus() {
  return (
    await run(
      appUrl,
      `select status, status_changed_at from member where id = $1`,
      [member.id]
    )
  ).rows[0];
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('clerk@albarakah.mu', 'Clerk'),
            ('officer@albarakah.mu', 'Officer'),
            ('treasurer@albarakah.mu', 'Treasurer'),
            ('secretary@albarakah.mu', 'Secretary'),
            ('president@albarakah.mu', 'President')
     returning id, email`
  );
  const byEmail = new Map(users.rows.map(r => [r.email, r.id]));
  clerk = principalFor(
    byEmail.get('clerk@albarakah.mu'),
    'clerk@albarakah.mu',
    ['clerk'],
    ['transaction.capture', 'transaction.view']
  );
  officer = principalFor(
    byEmail.get('officer@albarakah.mu'),
    'officer@albarakah.mu',
    ['account_officer'],
    [
      'transaction.capture',
      'transaction.post',
      'transaction.disburse',
      'transaction.view',
    ]
  );
  treasurer = principalFor(
    byEmail.get('treasurer@albarakah.mu'),
    'treasurer@albarakah.mu',
    ['treasurer'],
    ['transaction.post', 'transaction.disburse', 'transaction.view']
  );
  secretary = principalFor(
    byEmail.get('secretary@albarakah.mu'),
    'secretary@albarakah.mu',
    ['secretary'],
    ['transaction.review', 'transaction.view']
  );
  president = principalFor(
    byEmail.get('president@albarakah.mu'),
    'president@albarakah.mu',
    ['president'],
    ['transaction.approve', 'transaction.view']
  );

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
    [membershipTypeId, officer.userId]
  );
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, '{"name": "Amina", "surname": "Test"}')`,
    [application.rows[0].id]
  );
  const m = await run(
    appUrl,
    `insert into member (application_id, membership_type_id)
     values ($1, $2) returning id`,
    [application.rows[0].id, membershipTypeId]
  );
  const types = Object.fromEntries(
    (await run(appUrl, `select code, id from account_type`)).rows.map(r => [
      r.code,
      r.id,
    ])
  );
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
    shares: await open('shares', null),
    msa: await open('msa', null),
    hsa: await open('hsa', 'HSA0001'),
  };
  requestTypeId = (
    await run(
      appUrl,
      `select id from document_type where code = 'resignation_request'`
    )
  ).rows[0].id;

  await configure(
    `insert into bank_account (code, name, bank_name, account_number)
     values ('mcb', 'MCB current', 'MCB', '000123456789')`
  );
  bankAccountId = (
    await run(appUrl, `select id from bank_account where code = 'mcb'`)
  ).rows[0].id;

  // Money on every account: Shares 8,000, MSA 12,000, HSA 1,000.
  const { deposits } = await load();
  for (const [accountId, amount] of [
    [member.shares, '8000'],
    [member.msa, '12000'],
    [member.hsa, '1000'],
  ] as const) {
    await deposits.recordDeposit(
      { accountId, amount, method: 'cash' },
      officer
    );
  }
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('the pre-checks (S-1703)', () => {
  it('are configuration, each named when it blocks, and the financing hook passes', async () => {
    const { resignations, config, cache, deposits, review } = await load();
    expect(await config.resignationChecks()).toEqual({
      pendingTransactions: true,
      unpaidFees: true,
      financing: false,
    });

    // A large deposit on the MSA waits on its chain: the resignation waits
    // too, and says on what.
    const pending = await deposits.recordDeposit(
      {
        accountId: member.msa,
        amount: '150000',
        method: 'bank_transfer',
        methodReference: 'MCB 1',
        bankAccountId,
      },
      officer
    );
    // Nothing has been paid against the founding application either.
    let checks = await resignations.checksFor(member.id);
    expect(checks.map(c => [c.code, c.enabled, c.passed])).toEqual([
      ['pending_transactions', true, false],
      ['unpaid_fees', true, false],
      ['financing', false, true],
      ['guardian', true, true],
    ]);
    expect(checks[0].detail).toBe(`${pending.reference} still on its way.`);
    expect(resignations.blockingChecks(checks).map(c => c.code)).toEqual([
      'pending_transactions',
      'unpaid_fees',
    ]);

    // Switched off, a check no longer blocks — the Society's call.
    await config.setResignationChecks(
      { pendingTransactions: false, unpaidFees: false, financing: true },
      { userId: officer.userId, email: officer.email }
    );
    cache.clearReferenceCache();
    checks = await resignations.checksFor(member.id);
    expect(resignations.blockingChecks(checks)).toEqual([]);
    expect(checks[2].enabled).toBe(true);

    await config.setResignationChecks(
      { pendingTransactions: true, unpaidFees: true, financing: false },
      { userId: officer.userId, email: officer.email }
    );
    cache.clearReferenceCache();
    await review.reviewTransaction(
      pending.id,
      { outcome: 'reject', comment: 'Not now' },
      secretary
    );
    expect(
      resignations
        .blockingChecks(await resignations.checksFor(member.id))
        .map(c => c.code)
    ).toEqual(['unpaid_fees']);
  });

  it('name the joining fees still unpaid', async () => {
    const { resignations } = await load();
    // Nothing has been paid against the founding application, and its
    // type's schedule charges a joining fee.
    const checks = await resignations.checksFor(member.id);
    const fees = checks.find(c => c.code === 'unpaid_fees')!;
    expect(fees.passed).toBe(false);
    expect(fees.detail).toMatch(/^Rs [\d,.]+ of the joining fees unpaid\.$/);
  });

  it('ask nothing of a migrated member, who paid before migration', async () => {
    const { resignations } = await load();
    // As the legacy import leaves them: the core accounts opened, as
    // migrated, by the application on file.
    await run(
      appUrl,
      `update account a set opened_via_migration = true,
              opened_by_application_id = m.application_id
         from member m
        where a.member_id = m.id and m.id = $1
          and a.id = any($2::uuid[])`,
      [member.id, [member.shares, member.msa]]
    );
    try {
      const fees = (await resignations.checksFor(member.id)).find(
        c => c.code === 'unpaid_fees'
      )!;
      expect(fees).toMatchObject({
        passed: true,
        detail: 'Paid before migration.',
      });
    } finally {
      await run(
        appUrl,
        `update account set opened_via_migration = false,
                opened_by_application_id = null
          where id = any($1::uuid[])`,
        [[member.shares, member.msa]]
      );
    }
  });
});

describe('a guardian (officer direction)', () => {
  it('may not resign while a minor depends on them, whatever the switches say', async () => {
    const { resignations } = await load();
    const memberNo = (
      await run(appUrl, `select member_no from member where id = $1`, [
        member.id,
      ])
    ).rows[0].member_no;
    const typeId = async (code: string) =>
      (
        await run(appUrl, `select id from membership_type where code = $1`, [
          code,
        ])
      ).rows[0].id;
    const minorType = await typeId('minor');
    const guardianCheck = async () =>
      (await resignations.checksFor(member.id)).find(
        c => c.code === 'guardian'
      )!;
    expect(await guardianCheck()).toMatchObject({
      enabled: true,
      passed: true,
    });

    // A minor member naming them by number.
    const minorApp = await run(
      appUrl,
      `insert into membership_application
         (membership_type_id, captured_by, status)
       values ($1, $2, 'approved') returning id`,
      [minorType, officer.userId]
    );
    await run(
      appUrl,
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'applicant', 1, '{"name": "Yusuf", "surname": "Test"}'),
              ($1, 'guardian', 1, $2)`,
      [minorApp.rows[0].id, JSON.stringify({ member_id: memberNo })]
    );
    const minor = await run(
      appUrl,
      `insert into member (application_id, membership_type_id)
       values ($1, $2) returning id, member_no`,
      [minorApp.rows[0].id, minorType]
    );
    const minorNo = minor.rows[0].member_no;
    let check = await guardianCheck();
    expect(check.passed).toBe(false);
    expect(check.detail).toBe(`Guardian of ${minorNo} · Yusuf Test.`);
    expect(
      resignations
        .blockingChecks(await resignations.checksFor(member.id))
        .map(c => c.code)
    ).toContain('guardian');

    // Of age and moved to an adult type (S-610): no longer a ward.
    await run(
      appUrl,
      `update member set membership_type_id = $2 where id = $1`,
      [minor.rows[0].id, await typeId('individual')]
    );
    expect((await guardianCheck()).passed).toBe(true);

    // A minor's application still on its way counts too.
    const pendingApp = await run(
      appUrl,
      `insert into membership_application
         (membership_type_id, captured_by, status)
       values ($1, $2, 'new') returning id, reference`,
      [minorType, officer.userId]
    );
    await run(
      appUrl,
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'applicant', 1, '{"name": "Maryam", "surname": "Test"}'),
              ($1, 'guardian', 1, $2)`,
      [pendingApp.rows[0].id, JSON.stringify({ member_id: memberNo })]
    );
    check = await guardianCheck();
    expect(check.passed).toBe(false);
    expect(check.detail).toBe(
      `Guardian of ${pendingApp.rows[0].reference} · Maryam Test.`
    );

    // Decided against, it no longer does.
    await run(
      appUrl,
      `update membership_application set status = 'rejected' where id = $1`,
      [pendingApp.rows[0].id]
    );
    expect((await guardianCheck()).passed).toBe(true);
  });
});

describe('a resignation (S-1703)', () => {
  it('is a draft on the core accounts, submits with the signed request once every check passes, and posting pays out both, closes both and ends the membership', async () => {
    const {
      resignations,
      closures,
      deposits,
      review,
      ledger,
      timeline,
      config,
      cache,
    } = await load();
    // The founding application's fees are unpaid (above), and the check is
    // the Society's to switch off.
    await config.setResignationChecks(
      { pendingTransactions: true, unpaidFees: false, financing: false },
      { userId: officer.userId, email: officer.email }
    );
    cache.clearReferenceCache();

    // Only a member with core accounts, only once at a time, only by an
    // officer who may capture.
    await expect(
      resignations.startResignation(
        { memberId: member.id, reason: 'Leaving', method: 'cash' },
        secretary
      )
    ).rejects.toThrowError(/permission/);
    await expect(
      resignations.startResignation(
        { memberId: member.id, reason: ' ', method: 'cash' },
        clerk
      )
    ).rejects.toThrowError(/Say why the member is leaving/);

    const draft = await resignations.startResignation(
      {
        memberId: member.id,
        reason: 'Moving abroad',
        method: 'bank_transfer',
        methodReference: 'MCB 4471',
        bankAccountId,
      },
      clerk
    );
    expect(draft).toMatchObject({
      kind: 'resignation',
      status: 'draft',
      amount: '20000.00',
      accountId: member.shares,
    });
    expect(await resignations.resignationInFlightFor(member.id)).toMatchObject({
      id: draft.id,
      status: 'draft',
    });
    await expect(
      resignations.startResignation(
        { memberId: member.id, reason: 'Again', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/is already resigning this member/);
    // The HSA is not part of it, and closing it is its own request.
    expect((await resignations.coreAccounts(member.id)).map(a => a.id)).toEqual(
      [member.shares, member.msa]
    );

    await expect(
      resignations.submitResignation(draft.id, clerk)
    ).rejects.toThrowError(/File the signed resignation request/);
    await fileRequest(draft.id, clerk);
    expect(
      (await timeline.chainTimeline('transaction', draft.id))!.map(s => [
        s.key,
        s.label,
        s.state,
      ])
    ).toEqual([
      ['details', 'Details', 'done'],
      ['signature', 'Signature', 'done'],
      ['documents', 'Documents', 'done'],
      ['capture', 'Submitted', 'current'],
      ['secretary_review', 'Secretary review', 'todo'],
      ['president_decision', 'President decision', 'todo'],
      ['posted', 'Disbursement', 'todo'],
    ]);

    const submitted = await resignations.submitResignation(draft.id, clerk);
    expect(submitted.status).toBe('submitted');
    expect(submitted.workflowCode).toBe('transaction_resignation');
    expect(submitted.amount).toBe('20000.00');
    expect((await accountStatus(member.shares)).status).toBe('closing');
    expect((await accountStatus(member.msa)).status).toBe('closing');
    expect((await accountStatus(member.hsa)).status).toBe('active');
    await expect(
      deposits.recordDeposit(
        { accountId: member.msa, amount: '10', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/This account is closing/);
    // The HSA can still take money, and can still close on its own.
    await deposits.recordDeposit(
      { accountId: member.hsa, amount: '10', method: 'cash' },
      officer
    );
    const hsaClosure = await closures.startClosure(
      { accountId: member.hsa, reason: 'Done', method: 'cash' },
      officer
    );
    expect(hsaClosure.status).toBe('draft');

    // Returned, resubmitted, approved.
    await review.reviewTransaction(
      draft.id,
      { outcome: 'return', comment: 'Reason?' },
      secretary
    );
    await resignations.updateResignation(
      draft.id,
      {
        reason: 'Moving abroad in October',
        method: 'bank_transfer',
        methodReference: 'MCB 4471',
        bankAccountId,
      },
      clerk
    );
    await resignations.submitResignation(draft.id, clerk);
    await review.reviewTransaction(
      draft.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    await review.reviewTransaction(
      draft.id,
      { outcome: 'forward', comment: 'Agreed' },
      president
    );

    const posted = await review.postApprovedTransaction(draft.id, treasurer, {
      method: 'bank_transfer',
      methodReference: 'MCB 4471',
      bankAccountId,
    });
    expect(posted.status).toBe('posted');
    expect(posted.amount).toBe('20000.00');
    expect(posted.receiptNo).toMatch(/^RCT-/);
    expect(await accountStatus(member.shares)).toMatchObject({
      status: 'closed',
      closed_at: expect.any(Date),
    });
    expect((await accountStatus(member.msa)).status).toBe('closed');
    expect((await accountStatus(member.hsa)).status).toBe('active');
    expect((await ledger.accountBalance(member.shares))?.balance).toBe('0.00');
    expect((await ledger.accountBalance(member.msa))?.balance).toBe('0.00');
    expect((await ledger.accountBalance(member.hsa))?.balance).toBe('1010.00');
    const entries = await run(
      appUrl,
      `select account_id, direction, amount from account_entry
        where transaction_id = $1 order by sequence_no`,
      [draft.id]
    );
    expect(entries.rows).toEqual([
      { account_id: member.shares, direction: 'debit', amount: '8000.00' },
      { account_id: member.msa, direction: 'debit', amount: '12000.00' },
    ]);
    expect(await memberStatus()).toMatchObject({
      status: 'resigned',
      status_changed_at: expect.any(Date),
    });
    const event = await run(
      appUrl,
      `select payload from financial_event where transaction_id = $1`,
      [draft.id]
    );
    expect(event.rows[0].payload).toMatchObject({
      kind: 'resignation',
      account_closed: true,
      membership_ended: true,
      amount: 20000,
    });

    // Resigned, they deal as a non-member on what is left open (officer
    // direction): the HSA still takes a deposit, the closed core accounts
    // do not, and there is no membership left to resign.
    const onHsa = await deposits.recordDeposit(
      { accountId: member.hsa, amount: '10', method: 'cash' },
      officer
    );
    expect(onHsa.status).toBe('posted');
    await expect(
      deposits.recordDeposit(
        { accountId: member.shares, amount: '10', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/This account is closed/);
    await expect(
      resignations.startResignation(
        { memberId: member.id, reason: 'Again', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/This member is resigned/);
  });

  it('reopens both accounts when the chain rejects it, and when the officer withdraws it', async () => {
    const { resignations, review, config, cache } = await load();
    await config.setResignationChecks(
      { pendingTransactions: true, unpaidFees: false, financing: false },
      { userId: officer.userId, email: officer.email }
    );
    cache.clearReferenceCache();
    // A second member, to leave and come back.
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
      [membershipTypeId, officer.userId]
    );
    await run(
      appUrl,
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'applicant', 1, '{"name": "Bilal", "surname": "Test"}')`,
      [application.rows[0].id]
    );
    const m = await run(
      appUrl,
      `insert into member (application_id, membership_type_id)
       values ($1, $2) returning id`,
      [application.rows[0].id, membershipTypeId]
    );
    const types = Object.fromEntries(
      (await run(appUrl, `select code, id from account_type`)).rows.map(r => [
        r.code,
        r.id,
      ])
    );
    const accounts: string[] = [];
    for (const code of ['shares', 'msa']) {
      accounts.push(
        (
          await run(
            appUrl,
            `insert into account (member_id, account_type_id, is_membership_default, status)
             values ($1, $2, true, 'active') returning id`,
            [m.rows[0].id, types[code]]
          )
        ).rows[0].id
      );
    }

    // Only the reason is asked when it starts: the payout is recorded when
    // the approved request is posted, and a stand-in method holds its place.
    const first = await resignations.startResignation(
      { memberId: m.rows[0].id, reason: 'Leaving' },
      clerk
    );
    expect(first.amount).toBe('0.00');
    expect(first.method).not.toBe('');
    const edited = await resignations.updateResignation(
      first.id,
      { reason: 'Leaving for good' },
      clerk
    );
    expect(edited).toMatchObject({
      reason: 'Leaving for good',
      method: first.method,
    });
    await fileRequest(first.id, clerk);
    await resignations.submitResignation(first.id, clerk);
    for (const id of accounts) {
      expect((await accountStatus(id)).status).toBe('closing');
    }
    await review.reviewTransaction(
      first.id,
      { outcome: 'reject', comment: 'Stay' },
      secretary
    );
    for (const id of accounts) {
      expect((await accountStatus(id)).status).toBe('active');
    }

    const second = await resignations.startResignation(
      { memberId: m.rows[0].id, reason: 'Leaving after all', method: 'cash' },
      clerk
    );
    await fileRequest(second.id, clerk);
    await resignations.submitResignation(second.id, clerk);
    await expect(
      resignations.cancelResignation(second.id, clerk)
    ).rejects.toThrowError(/is submitted, so it cannot be changed/);
    await review.reviewTransaction(
      second.id,
      { outcome: 'return', comment: 'Sign again' },
      secretary
    );
    const cancelled = await resignations.cancelResignation(second.id, clerk);
    expect(cancelled.status).toBe('cancelled');
    for (const id of accounts) {
      expect((await accountStatus(id)).status).toBe('active');
    }
    expect(await resignations.resignationInFlightFor(m.rows[0].id)).toBeNull();
  });
});
