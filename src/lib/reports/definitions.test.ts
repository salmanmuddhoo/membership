// The Applications report (S-905/S-906/S-907 follow-up): who applied and
// where the application currently sits, read the same way the Applications
// list page reads it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../scripts/migrate';
import type { Principal } from '../access/principal';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `reports_applications_test_${Date.now()}`;
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
  // db/pool's own pool is a module-level singleton, shared with whatever
  // else in this file last pointed it at a database (the transactions
  // report's own fixture, below) — closed unconditionally, not only when
  // this describe's own last-seen reference says one is open, so the next
  // query always opens fresh against DATABASE_URL as just set.
  openPool = await import('../db/pool');
  await openPool.closePool();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  return { reports: await import('./definitions') };
}

let officerId: string;
let individualTypeId: string;
let corporateTypeId: string;

// With the Secretary (default chain, migration 0011): capture takes a draft
// to 'new', and the Secretary acts on 'new' directly.
let withSecretary: string; // individual, status 'new'
// Nothing waits on an approved application any more — it is a member from
// here on, not a row this report's "With" column still names anyone against.
let approvedCorporate: string;
// No party captured at all, sent back for correction.
let returnedNoParty: string;

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('test-officer', 'officer@albarakah.mu', 'Officer')
     returning id`
  );
  officerId = user.rows[0].id;

  const types = await run(
    appUrl,
    `select code, id from membership_type where code in ('individual', 'corporate')`
  );
  individualTypeId = types.rows.find(r => r.code === 'individual')!.id;
  corporateTypeId = types.rows.find(r => r.code === 'corporate')!.id;

  const app1 = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'new') returning id`,
    [individualTypeId, officerId]
  );
  withSecretary = app1.rows[0].id;
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb)`,
    [withSecretary, JSON.stringify({ name: 'John', surname: 'Doe' })]
  );

  const app2 = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [corporateTypeId, officerId]
  );
  approvedCorporate = app2.rows[0].id;
  // A corporate applicant's whole name is captured under 'name' alone — no
  // 'surname' field exists for that type (migration 0010) — so the same
  // trim(name || ' ' || surname) the report shares with the Members report
  // already reads it correctly.
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb)`,
    [approvedCorporate, JSON.stringify({ name: 'Al Barakah Trading Ltd' })]
  );

  const app3 = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'returned') returning id`,
    [individualTypeId, officerId]
  );
  returnedNoParty = app3.rows[0].id;
  await run(
    appUrl,
    `insert into application_transition
       (application_id, from_status, to_status, actor_user_id, actor_role)
     values ($1, 'new', 'returned', $2, 'Regional Manager')`,
    [returnedNoParty, officerId]
  );
}, 60_000);

afterAll(async () => {
  if (openPool) await openPool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('applications report', () => {
  it('names the applicant, the human status, and where it currently sits', async () => {
    const { reports } = await load();
    const report = reports.reportByCode('applications')!;
    const result = await report.run({});

    const byId = new Map(result.rows.map(r => [r.Reference as string, r]));
    // Reference isn't known ahead of the insert (it's generated), so match
    // rows by the fields the test itself set instead.
    const john = result.rows.find(r => r.Applicant === 'John Doe')!;
    expect(john.Status).toBe('New');
    expect(john.With).toBe('With the Secretary');

    const corporate = result.rows.find(
      r => r.Applicant === 'Al Barakah Trading Ltd'
    )!;
    expect(corporate.Status).toBe('Approved');
    expect(corporate.With).toBe('');

    const returned = result.rows.find(
      r => r.Status === 'Returned for Correction'
    )!;
    expect(returned.Applicant).toBe('');
    expect(returned.With).toBe('Returned by the Regional Manager');

    expect(byId.size).toBeGreaterThan(0); // rows are keyed by Reference
  });

  it('filters by where an application stands, with Approved offered although the Applications list omits it', async () => {
    const { reports } = await load();
    const report = reports.reportByCode('applications')!;
    const statusFilter = report.filters.find(f => f.name === 'status')!;
    expect(statusFilter.kind).toBe('choice');
    const choices = await statusFilter.choices!();
    expect(choices).toContainEqual({ value: 'approved', label: 'Approved' });
    // Officer feedback: a stage per step of the chain in place of the raw
    // 'new' / 'submitted_for_approval', which say nothing about who holds it.
    expect(choices).toContainEqual({
      value: 'with:secretary_review',
      label: 'With the Secretary',
    });
    expect(choices.map(c => c.value)).not.toContain('new');
    expect(choices.map(c => c.value)).not.toContain('submitted_for_review');

    const onlyApproved = await report.run({ status: 'approved' });
    expect(onlyApproved.rows.map(r => r.Applicant)).toEqual([
      'Al Barakah Trading Ltd',
    ]);
    const withSecretary = await report.run({ status: 'with:secretary_review' });
    expect(withSecretary.rows.map(r => r.Applicant)).toEqual(['John Doe']);
    const withRegional = await report.run({ status: 'with:regional_review' });
    expect(withRegional.rows).toEqual([]);
  });
});

// A separate database: one withdrawal on its chain, at the Secretary step,
// is enough to show the Status column reads where it is and the filter
// finds it by role.
describe('transactions report', () => {
  const txDbName = `reports_transactions_test_${Date.now()}`;
  const txOwnerUrl = `postgresql://postgres@127.0.0.1:5433/${txDbName}`;
  const txAppUrl = `postgresql://albarakah_app:devpassword@127.0.0.1:5433/${txDbName}`;

  let txPool: typeof import('../db/pool') | null = null;
  async function loadTx() {
    // See load()'s own comment: closed unconditionally, since the pool this
    // reaches may be the applications describe's, not this one's.
    txPool = await import('../db/pool');
    await txPool.closePool();
    process.env.DATABASE_URL = txAppUrl;
    process.env.DATABASE_ALLOW_INSECURE = 'true';
    process.env.PUBLIC_APP_ENV = 'test';
    return { reports: await import('./definitions') };
  }

  let atSecretaryReference: string;

  beforeAll(async () => {
    await run(ADMIN_URL, `create database ${txDbName}`);
    await run(txOwnerUrl, 'revoke all on schema public from public');
    await run(
      txOwnerUrl,
      `grant connect on database ${txDbName} to albarakah_app`
    );
    await migrate(txOwnerUrl, MIGRATIONS_DIR);

    const user = await run(
      txAppUrl,
      `insert into app_user (entra_subject, email, display_name)
       values ('test-officer-tx', 'officer-tx@albarakah.mu', 'Officer')
       returning id`
    );
    const txOfficerId = user.rows[0].id;

    const membershipTypeId = (
      await run(
        txAppUrl,
        `select id from membership_type where code = 'individual'`
      )
    ).rows[0].id;
    const msaTypeId = (
      await run(txAppUrl, `select id from account_type where code = 'msa'`)
    ).rows[0].id;
    // The default chain every transaction kind is seeded with (migration
    // 0070): Secretary review, then President decision.
    const withdrawalDefinitionId = (
      await run(
        txAppUrl,
        `select id from workflow_definition where code = 'transaction_withdrawal'`
      )
    ).rows[0].id;

    const application = await run(
      txAppUrl,
      `insert into membership_application (membership_type_id, captured_by, status)
       values ($1, $2, 'approved') returning id`,
      [membershipTypeId, txOfficerId]
    );
    const member = await run(
      txAppUrl,
      `insert into member (application_id, membership_type_id)
       values ($1, $2) returning id`,
      [application.rows[0].id, membershipTypeId]
    );
    const memberId = member.rows[0].id;
    const accountId = (
      await run(
        txAppUrl,
        `insert into account (member_id, account_type_id, is_membership_default)
         values ($1, $2, true) returning id`,
        [memberId, msaTypeId]
      )
    ).rows[0].id;

    const transaction = await run(
      txAppUrl,
      `insert into transaction
         (kind, member_id, account_id, amount, method, status, captured_by,
          workflow_definition_id, current_step_code)
       values ('withdrawal', $1, $2, 500, 'cash', 'submitted', $3, $4,
               'secretary_review')
       returning reference`,
      [memberId, accountId, txOfficerId, withdrawalDefinitionId]
    );
    atSecretaryReference = transaction.rows[0].reference;
  }, 60_000);

  afterAll(async () => {
    if (txPool) await txPool.closePool();
    await run(ADMIN_URL, `drop database if exists ${txDbName} with (force)`);
  });

  it('reads Status as where the transaction is now, not its bare workflow status', async () => {
    const { reports } = await loadTx();
    const report = reports.reportByCode('transactions')!;
    const result = await report.run({});
    const row = result.rows.find(r => r.Reference === atSecretaryReference)!;
    expect(row.Status).toBe('With Secretary');
  });

  it('offers a Status choice per role on a transaction chain, and finds one by it', async () => {
    const { reports } = await loadTx();
    const report = reports.reportByCode('transactions')!;
    const statusFilter = report.filters.find(f => f.name === 'status')!;
    expect(statusFilter.kind).toBe('choice');
    const choices = await statusFilter.choices!();
    expect(choices).toContainEqual({
      value: 'with:secretary',
      label: 'With Secretary',
    });
    expect(choices).toContainEqual({
      value: 'with:president',
      label: 'With President / Chairperson',
    });
    expect(choices).toContainEqual({ value: 'approved', label: 'To disburse' });
    expect(choices).toContainEqual({ value: 'returned', label: 'Returned' });
    expect(choices).toContainEqual({
      value: 'done',
      label: 'Disbursed',
    });
    expect(choices).toContainEqual({ value: 'rejected', label: 'Rejected' });
    expect(choices).toContainEqual({ value: 'cancelled', label: 'Cancelled' });

    const atSecretary = await report.run({ status: 'with:secretary' });
    expect(atSecretary.rows.map(r => r.Reference)).toEqual([
      atSecretaryReference,
    ]);
    const atPresident = await report.run({ status: 'with:president' });
    expect(atPresident.rows).toEqual([]);
  });
});

// A separate database: one bank account with an opening balance, a deposit
// into it by bank transfer and a withdrawal out of it by cheque — enough to
// show the per-account summary (opening/in/out/closing), the per-account
// statement with its running balance and brought-forward row, and that a
// period filter keeps a movement out of the period it falls outside.
describe('bank accounts report', () => {
  const bankDbName = `reports_bank_accounts_test_${Date.now()}`;
  const bankOwnerUrl = `postgresql://postgres@127.0.0.1:5433/${bankDbName}`;
  const bankAppUrl = `postgresql://albarakah_app:devpassword@127.0.0.1:5433/${bankDbName}`;

  async function configure(sql: string) {
    await run(
      bankAppUrl,
      `begin; set local albarakah.actor_description = 'definitions.test'; ${sql}; commit;`
    );
  }

  let bankPool: typeof import('../db/pool') | null = null;
  async function loadBank() {
    // See load()'s own comment: closed unconditionally, since the pool this
    // reaches may be an earlier describe's, not this one's.
    bankPool = await import('../db/pool');
    await bankPool.closePool();
    process.env.DATABASE_URL = bankAppUrl;
    process.env.DATABASE_ALLOW_INSECURE = 'true';
    process.env.PUBLIC_APP_ENV = 'test';
    return {
      reports: await import('./definitions'),
      deposits: await import('../ledger/deposits'),
      withdrawals: await import('../ledger/withdrawals'),
    };
  }

  let officer: Principal;
  let bankAccountId: string;

  beforeAll(async () => {
    await run(ADMIN_URL, `create database ${bankDbName}`);
    await run(bankOwnerUrl, 'revoke all on schema public from public');
    await run(
      bankOwnerUrl,
      `grant connect on database ${bankDbName} to albarakah_app`
    );
    await migrate(bankOwnerUrl, MIGRATIONS_DIR);

    const user = await run(
      bankAppUrl,
      `insert into app_user (email, display_name)
       values ('officer-bank@albarakah.mu', 'Officer')
       returning id`
    );
    officer = {
      userId: user.rows[0].id,
      entraSubject: 'sub-officer-bank',
      email: 'officer-bank@albarakah.mu',
      displayName: 'Officer',
      roles: ['account_officer'],
      roleNames: ['Account Officer'],
      permissions: new Set(['transaction.capture', 'transaction.post']),
    };

    const membershipTypeId = (
      await run(
        bankAppUrl,
        `select id from membership_type where code = 'individual'`
      )
    ).rows[0].id;
    const application = await run(
      bankAppUrl,
      `insert into membership_application (membership_type_id, captured_by, status)
       values ($1, $2, 'approved') returning id`,
      [membershipTypeId, officer.userId]
    );
    await run(
      bankAppUrl,
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'applicant', 1, $2::jsonb)`,
      [
        application.rows[0].id,
        JSON.stringify({ name: 'Amina', surname: 'Beeharry' }),
      ]
    );
    const member = await run(
      bankAppUrl,
      `insert into member (application_id, membership_type_id)
       values ($1, $2) returning id`,
      [application.rows[0].id, membershipTypeId]
    );
    const msaTypeId = (
      await run(bankAppUrl, `select id from account_type where code = 'msa'`)
    ).rows[0].id;
    const msa = (
      await run(
        bankAppUrl,
        `insert into account (member_id, account_type_id, is_membership_default, status)
         values ($1, $2, true, 'active') returning id`,
        [member.rows[0].id, msaTypeId]
      )
    ).rows[0].id;

    // Opening balance dated well before any transaction this suite posts,
    // so "opening" always means the configured figure unless a test asks
    // for a period that starts later.
    await configure(
      `insert into bank_account
         (code, name, bank_name, account_number, opening_balance, opening_date)
       values ('mcb', 'MCB current', 'MCB', '000123456789', 10000, '2020-01-01')`
    );
    bankAccountId = (
      await run(bankAppUrl, `select id from bank_account where code = 'mcb'`)
    ).rows[0].id;

    const { deposits, withdrawals } = await loadBank();
    const deposit = await deposits.recordDeposit(
      {
        accountId: msa,
        amount: '3000',
        method: 'bank_transfer',
        methodReference: 'BT-1',
        bankAccountId,
      },
      officer
    );
    expect(deposit.status).toBe('posted');

    const withdrawal = await withdrawals.recordWithdrawal(
      {
        accountId: msa,
        amount: '1000',
        method: 'cheque',
        methodReference: 'CHQ-1',
        bankAccountId,
        reason: 'Test',
      },
      officer
    );
    expect(withdrawal.status).toBe('posted');
  }, 60_000);

  afterAll(async () => {
    if (bankPool) await bankPool.closePool();
    await run(ADMIN_URL, `drop database if exists ${bankDbName} with (force)`);
  });

  it('offers every bank account by name as a filter choice', async () => {
    const { reports } = await loadBank();
    const report = reports.reportByCode('bank-accounts')!;
    const bankFilter = report.filters.find(f => f.name === 'bank')!;
    expect(bankFilter.kind).toBe('choice');
    const choices = await bankFilter.choices!();
    expect(choices).toContainEqual({
      value: bankAccountId,
      label: 'MCB current',
    });
  });

  it('with no account chosen, answers opening, in, out and closing per account', async () => {
    const { reports } = await loadBank();
    const report = reports.reportByCode('bank-accounts')!;
    const result = await report.run({});

    const row = result.rows.find(r => r['Bank account'] === 'MCB current')!;
    expect(row.Bank).toBe('MCB');
    expect(row.Opening).toBe('10000.00');
    expect(row.In).toBe('3000.00');
    expect(row.Out).toBe('1000.00');
    expect(row.Closing).toBe('12000.00');
    expect(result.summary).toMatch(
      /^1 bank account\(s\) — MUR 12,000\.00 in total/
    );
    // No account number anywhere on the page — name and bank only (S-1901).
    expect(result.columns.map(c => c.label)).not.toContain('Account number');
    expect(JSON.stringify(result.rows)).not.toContain('000123456789');

    // A row opens that account's own ins and outs, for the same period.
    const rowIndex = result.rows.indexOf(row);
    const href = result.rowHrefs?.[rowIndex];
    expect(href).toContain(`bank=${bankAccountId}`);
  });

  it('a row href keeps the period that was asked for', async () => {
    const { reports } = await loadBank();
    const report = reports.reportByCode('bank-accounts')!;
    const result = await report.run({
      from: '2026-01-01',
      to: '2026-12-31',
    });

    const rowIndex = result.rows.findIndex(
      r => r['Bank account'] === 'MCB current'
    );
    const href = result.rowHrefs?.[rowIndex];
    expect(href).toContain(`bank=${bankAccountId}`);
    expect(href).toContain('from=2026-01-01');
    expect(href).toContain('to=2026-12-31');
  });

  it('one account chosen shows its statement, oldest first, with a running balance', async () => {
    const { reports } = await loadBank();
    const report = reports.reportByCode('bank-accounts')!;
    const result = await report.run({ bank: bankAccountId });

    expect(result.rows).toHaveLength(3);
    const [broughtForward, deposit, withdrawal] = result.rows;

    expect(broughtForward.Kind).toBe('Balance brought forward');
    // No `from` was asked for, so there is no date to show it against.
    expect(broughtForward.Date).toBe('');
    expect(broughtForward.In).toBeNull();
    expect(broughtForward.Out).toBeNull();
    expect(broughtForward.Balance).toBe('10000.00');

    expect(deposit.Kind).toBe('Deposit');
    expect(deposit.Holder).toBe('Amina Beeharry');
    expect(deposit.Method).toBe('Bank transfer');
    expect(deposit['Method reference']).toBe('BT-1');
    expect(deposit.In).toBe('3000.00');
    expect(deposit.Out).toBeNull();
    expect(deposit.Balance).toBe('13000.00');

    expect(withdrawal.Kind).toBe('Withdrawal');
    expect(withdrawal.Method).toBe('Cheque');
    expect(withdrawal['Method reference']).toBe('CHQ-1');
    expect(withdrawal.In).toBeNull();
    expect(withdrawal.Out).toBe('1000.00');
    expect(withdrawal.Balance).toBe('12000.00');

    expect(result.summary).toBe(
      'Opening MUR 10,000.00 · in MUR 3,000.00 · out MUR 1,000.00 · ' +
        'closing MUR 12,000.00.'
    );

    // Every figure reads as money on screen, the running balance included.
    for (const key of ['In', 'Out', 'Balance']) {
      expect(result.columns.find(c => c.key === key)!.money).toBe(true);
    }
  });

  it('a period filter keeps a movement out of a period it falls outside', async () => {
    const { reports } = await loadBank();
    const report = reports.reportByCode('bank-accounts')!;

    const isoDate = (d: Date) => d.toISOString().slice(0, 10);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    // A period that ends before today: both movements (posted today)
    // fall outside it, and with no `from` the opening is the account's
    // own configured figure.
    const before = await report.run({ to: isoDate(yesterday) });
    const beforeRow = before.rows.find(
      r => r['Bank account'] === 'MCB current'
    )!;
    expect(beforeRow.Opening).toBe('10000.00');
    expect(beforeRow.In).toBe('0.00');
    expect(beforeRow.Out).toBe('0.00');
    expect(beforeRow.Closing).toBe('10000.00');

    // A period starting tomorrow: both movements now fall BEFORE it, so
    // they count toward the opening rather than within the period.
    const after = await report.run({ from: isoDate(tomorrow) });
    const afterRow = after.rows.find(r => r['Bank account'] === 'MCB current')!;
    expect(afterRow.Opening).toBe('12000.00');
    expect(afterRow.In).toBe('0.00');
    expect(afterRow.Out).toBe('0.00');
    expect(afterRow.Closing).toBe('12000.00');

    // The per-account view agrees: no movement rows, just what carried
    // forward.
    const afterOne = await report.run({
      bank: bankAccountId,
      from: isoDate(tomorrow),
    });
    expect(afterOne.rows).toHaveLength(1);
    expect(afterOne.rows[0].Kind).toBe('Balance brought forward');
    expect(afterOne.rows[0].Balance).toBe('12000.00');
    // The brought-forward row shows the From date it was struck on, read
    // the same way every other date on the report is.
    const MONTHS = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const [y, m, d] = isoDate(tomorrow).split('-').map(Number);
    expect(afterOne.rows[0].Date).toBe(
      `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`
    );
  });
});

// Officer request: admissions, resignations, withdrawals, transfers and
// demised — one database, since the fixture is one member's whole
// lifecycle plus the people who move through it with her.
describe('membership movements reports', () => {
  const mvDbName = `reports_movements_test_${Date.now()}`;
  const mvOwnerUrl = `postgresql://postgres@127.0.0.1:5433/${mvDbName}`;
  const mvAppUrl = `postgresql://albarakah_app:devpassword@127.0.0.1:5433/${mvDbName}`;

  let mvPool: typeof import('../db/pool') | null = null;
  async function loadMv() {
    // See load()'s own comment: closed unconditionally, since the pool this
    // reaches may be an earlier describe's, not this one's.
    mvPool = await import('../db/pool');
    await mvPool.closePool();
    process.env.DATABASE_URL = mvAppUrl;
    process.env.DATABASE_ALLOW_INSECURE = 'true';
    process.env.PUBLIC_APP_ENV = 'test';
    return { reports: await import('./definitions') };
  }

  const IN_PERIOD_FROM = '2026-03-01';
  const IN_PERIOD_TO = '2026-03-31';
  const OUTSIDE_DATE = '2026-01-05';

  let officerId: string;

  // Admissions
  let bobMemberNo: string;
  let caraMemberNo: string;
  let caraRejoinReference: string;

  // Resignations / withdrawals (Farah's own account carries both)
  let farahMemberNo: string;
  let resignationDisbursedRef: string;
  let resignationInProgressRef: string;
  let resignationRejectedRef: string;
  let resignationOutsideRef: string;
  let withdrawalDisbursedRef: string;
  let withdrawalInProgressRef: string;
  let withdrawalOutsideRef: string;

  // Transfers
  let internalTransferReference: string;
  let externalTransferReference: string;
  let transferOutsideReference: string;

  // Demised
  let ibrahimMemberNo: string;
  let demiseReference: string;
  let demiseOutsideReference: string;
  let closureOnDeathReference: string;
  let ordinaryClosureReference: string;

  beforeAll(async () => {
    await run(ADMIN_URL, `create database ${mvDbName}`);
    await run(mvOwnerUrl, 'revoke all on schema public from public');
    await run(
      mvOwnerUrl,
      `grant connect on database ${mvDbName} to albarakah_app`
    );
    await migrate(mvOwnerUrl, MIGRATIONS_DIR);

    const user = await run(
      mvAppUrl,
      `insert into app_user (entra_subject, email, display_name)
       values ('test-officer-mv', 'officer-mv@albarakah.mu', 'Officer')
       returning id`
    );
    officerId = user.rows[0].id;

    const types = await run(
      mvAppUrl,
      `select code, id from membership_type where code in ('individual', 'corporate')`
    );
    const individualTypeId = types.rows.find(
      (r: { code: string }) => r.code === 'individual'
    )!.id;
    const corporateTypeId = types.rows.find(
      (r: { code: string }) => r.code === 'corporate'
    )!.id;

    const msaTypeId = (
      await run(mvAppUrl, `select id from account_type where code = 'msa'`)
    ).rows[0].id;
    await run(
      mvAppUrl,
      `begin;
       set local albarakah.actor_description = 'definitions.test';
       insert into account_type (code, name, number_prefix)
       values ('hsa', 'Hajj Savings Account', 'HSA');
       commit;`
    );
    const hsaTypeId = (
      await run(mvAppUrl, `select id from account_type where code = 'hsa'`)
    ).rows[0].id;

    const withdrawalDefinitionId = (
      await run(
        mvAppUrl,
        `select id from workflow_definition where code = 'transaction_withdrawal'`
      )
    ).rows[0].id;
    const transferDefinitionId = (
      await run(
        mvAppUrl,
        `select id from workflow_definition where code = 'transaction_transfer'`
      )
    ).rows[0].id;
    const resignationDefinitionId = (
      await run(
        mvAppUrl,
        `select id from workflow_definition where code = 'transaction_resignation'`
      )
    ).rows[0].id;

    async function createMember(
      typeId: string,
      name: string,
      surname: string,
      joinedAt: string
    ) {
      const application = await run(
        mvAppUrl,
        `insert into membership_application (membership_type_id, captured_by, status)
         values ($1, $2, 'approved') returning id, reference`,
        [typeId, officerId]
      );
      await run(
        mvAppUrl,
        `insert into application_party (application_id, subject, ordinal, values)
         values ($1, 'applicant', 1, $2::jsonb)`,
        [application.rows[0].id, JSON.stringify({ name, surname })]
      );
      const member = await run(
        mvAppUrl,
        `insert into member (application_id, membership_type_id, joined_at, status)
         values ($1, $2, $3, 'active') returning id, member_no`,
        [application.rows[0].id, typeId, joinedAt]
      );
      return {
        memberId: member.rows[0].id as string,
        memberNo: member.rows[0].member_no as string,
      };
    }

    // A row this suite passes directly into `transaction`, bypassing the
    // capture/review/post flow those live elsewhere for — the reports read
    // the table, not the flow that filled it, and the fixtures above and
    // below already cover that flow's own rules.
    async function insertTransaction(opts: {
      kind: string;
      memberId?: string | null;
      customerId?: string | null;
      accountId: string;
      amount: string;
      method?: string;
      reason?: string | null;
      status: string;
      submittedAt?: string | null;
      postedAt?: string | null;
      createdAt?: string | null;
      definitionId?: string | null;
      stepCode?: string | null;
      payeeName?: string | null;
      transferId?: string | null;
      legDirection?: string | null;
      claimantKind?: string | null;
      claimant?: Record<string, string> | null;
      takafulBenefit?: string;
    }) {
      const result = await run(
        mvAppUrl,
        `insert into transaction
           (kind, member_id, customer_id, account_id, amount, method, reason,
            status, captured_by, submitted_at, posted_at, posted_by,
            created_at, workflow_definition_id, current_step_code,
            payee_name, transfer_id, leg_direction, claimant_kind, claimant,
            takaful_benefit)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17, $18, $19, $20::jsonb, $21)
         returning id, reference`,
        [
          opts.kind,
          opts.memberId ?? null,
          opts.customerId ?? null,
          opts.accountId,
          opts.amount,
          opts.method ?? 'cash',
          opts.reason ?? null,
          opts.status,
          officerId,
          opts.submittedAt ?? null,
          opts.postedAt ?? null,
          opts.status === 'posted' ? officerId : null,
          opts.createdAt ?? opts.submittedAt ?? new Date().toISOString(),
          opts.definitionId ?? null,
          opts.stepCode ?? null,
          opts.payeeName ?? null,
          opts.transferId ?? null,
          opts.legDirection ?? null,
          opts.claimantKind ?? null,
          opts.claimant ? JSON.stringify(opts.claimant) : null,
          opts.takafulBenefit ?? '0',
        ]
      );
      return result.rows[0] as { id: string; reference: string };
    }

    // ---- admissions --------------------------------------------------
    // Before the test period — an admission the period must not return.
    await createMember(
      individualTypeId,
      'Alice',
      'Admitted-Early',
      '2025-01-10'
    );

    // Inside the period — an ordinary, first-time admission.
    const bob = await createMember(
      individualTypeId,
      'Bob',
      'Newmember',
      `${IN_PERIOD_FROM} 09:00:00+04`
    );
    bobMemberNo = bob.memberNo;

    // A corporate member inside the period, to prove the type filter
    // narrows.
    await createMember(
      corporateTypeId,
      'Al Barakah Trading Ltd',
      '',
      `${IN_PERIOD_FROM} 08:00:00+04`
    );

    // Founded long ago; a second membership application re-admits the same
    // member row inside the period (0090) — the rejoin's own reference,
    // not the founding one.
    const cara = await createMember(
      individualTypeId,
      'Cara',
      'Rejoiner',
      '2020-06-01'
    );
    const rejoinApplication = await run(
      mvAppUrl,
      `insert into membership_application
         (membership_type_id, captured_by, status, rejoins_member_id)
       values ($1, $2, 'approved', $3) returning id, reference`,
      [individualTypeId, officerId, cara.memberId]
    );
    await run(
      mvAppUrl,
      `update member
          set status = 'active', application_id = $2, rejoined_at = $3
        where id = $1`,
      [
        cara.memberId,
        rejoinApplication.rows[0].id,
        `${IN_PERIOD_FROM} 10:00:00+04`,
      ]
    );
    caraMemberNo = cara.memberNo;
    caraRejoinReference = rejoinApplication.rows[0].reference;

    // ---- resignations / withdrawals -----------------------------------
    const farah = await createMember(
      individualTypeId,
      'Farah',
      'Test',
      '2024-01-01'
    );
    farahMemberNo = farah.memberNo;
    const farahMsa = (
      await run(
        mvAppUrl,
        `insert into account (member_id, account_type_id, is_membership_default, status)
         values ($1, $2, true, 'active') returning id`,
        [farah.memberId, msaTypeId]
      )
    ).rows[0].id;

    resignationDisbursedRef = (
      await insertTransaction({
        kind: 'resignation',
        memberId: farah.memberId,
        accountId: farahMsa,
        amount: '5000',
        reason: 'Relocating abroad',
        status: 'posted',
        submittedAt: `${IN_PERIOD_FROM} 09:00:00+04`,
        postedAt: `${IN_PERIOD_FROM} 12:00:00+04`,
      })
    ).reference;

    resignationInProgressRef = (
      await insertTransaction({
        kind: 'resignation',
        memberId: farah.memberId,
        accountId: farahMsa,
        amount: '3000',
        reason: 'Health',
        status: 'submitted',
        submittedAt: `${IN_PERIOD_FROM} 09:30:00+04`,
        definitionId: resignationDefinitionId,
        stepCode: 'secretary_review',
      })
    ).reference;

    resignationRejectedRef = (
      await insertTransaction({
        kind: 'resignation',
        memberId: farah.memberId,
        accountId: farahMsa,
        amount: '2000',
        reason: 'Duplicate request',
        status: 'rejected',
        submittedAt: `${IN_PERIOD_FROM} 10:00:00+04`,
      })
    ).reference;

    resignationOutsideRef = (
      await insertTransaction({
        kind: 'resignation',
        memberId: farah.memberId,
        accountId: farahMsa,
        amount: '1000',
        reason: 'Outside period',
        status: 'posted',
        submittedAt: `${OUTSIDE_DATE} 09:00:00+04`,
        postedAt: `${OUTSIDE_DATE} 12:00:00+04`,
      })
    ).reference;

    withdrawalDisbursedRef = (
      await insertTransaction({
        kind: 'withdrawal',
        memberId: farah.memberId,
        accountId: farahMsa,
        amount: '500',
        method: 'cash',
        status: 'posted',
        createdAt: `${IN_PERIOD_FROM} 09:00:00+04`,
        postedAt: `${IN_PERIOD_FROM} 09:05:00+04`,
      })
    ).reference;

    withdrawalInProgressRef = (
      await insertTransaction({
        kind: 'withdrawal',
        memberId: farah.memberId,
        accountId: farahMsa,
        amount: '200',
        method: 'cash',
        status: 'submitted',
        createdAt: `${IN_PERIOD_FROM} 09:10:00+04`,
        definitionId: withdrawalDefinitionId,
        stepCode: 'secretary_review',
      })
    ).reference;

    withdrawalOutsideRef = (
      await insertTransaction({
        kind: 'withdrawal',
        memberId: farah.memberId,
        accountId: farahMsa,
        amount: '100',
        method: 'cash',
        status: 'posted',
        createdAt: `${OUTSIDE_DATE} 09:00:00+04`,
        postedAt: `${OUTSIDE_DATE} 09:05:00+04`,
      })
    ).reference;

    // ---- transfers ------------------------------------------------------
    const grace = await createMember(
      individualTypeId,
      'Grace',
      'Recipient',
      '2024-01-01'
    );
    const graceMsa = (
      await run(
        mvAppUrl,
        `insert into account (member_id, account_type_id, is_membership_default, status)
         values ($1, $2, true, 'active') returning id`,
        [grace.memberId, msaTypeId]
      )
    ).rows[0].id;

    // Internal: Farah to Grace, both on the system — two legs, one row.
    const internalTransfer = await run(
      mvAppUrl,
      `insert into transfer (member_id, status, captured_by, created_at)
       values ($1, 'posted', $2, $3) returning id, reference`,
      [farah.memberId, officerId, `${IN_PERIOD_FROM} 11:00:00+04`]
    );
    internalTransferReference = internalTransfer.rows[0].reference;
    await insertTransaction({
      kind: 'transfer_leg',
      memberId: farah.memberId,
      accountId: farahMsa,
      amount: '1500',
      method: 'internal_transfer',
      status: 'posted',
      createdAt: `${IN_PERIOD_FROM} 11:00:00+04`,
      postedAt: `${IN_PERIOD_FROM} 11:01:00+04`,
      transferId: internalTransfer.rows[0].id,
      legDirection: 'debit',
    });
    await insertTransaction({
      kind: 'transfer_leg',
      memberId: grace.memberId,
      accountId: graceMsa,
      amount: '1500',
      method: 'internal_transfer',
      status: 'posted',
      createdAt: `${IN_PERIOD_FROM} 11:00:00+04`,
      postedAt: `${IN_PERIOD_FROM} 11:01:00+04`,
      transferId: internalTransfer.rows[0].id,
      legDirection: 'credit',
    });

    // External: Farah to a payee off the system — debit leg only.
    const externalTransfer = await run(
      mvAppUrl,
      `insert into transfer (member_id, status, captured_by, created_at)
       values ($1, 'submitted', $2, $3) returning id, reference`,
      [farah.memberId, officerId, `${IN_PERIOD_FROM} 12:00:00+04`]
    );
    externalTransferReference = externalTransfer.rows[0].reference;
    await insertTransaction({
      kind: 'transfer_leg',
      memberId: farah.memberId,
      accountId: farahMsa,
      amount: '750',
      method: 'cheque',
      status: 'submitted',
      createdAt: `${IN_PERIOD_FROM} 12:00:00+04`,
      transferId: externalTransfer.rows[0].id,
      legDirection: 'debit',
      payeeName: 'Harold Estate',
      definitionId: transferDefinitionId,
      stepCode: 'secretary_review',
    });

    // Outside the period.
    const transferOutside = await run(
      mvAppUrl,
      `insert into transfer (member_id, status, captured_by, created_at)
       values ($1, 'posted', $2, $3) returning id, reference`,
      [farah.memberId, officerId, `${OUTSIDE_DATE} 11:00:00+04`]
    );
    transferOutsideReference = transferOutside.rows[0].reference;
    await insertTransaction({
      kind: 'transfer_leg',
      memberId: farah.memberId,
      accountId: farahMsa,
      amount: '50',
      method: 'internal_transfer',
      status: 'posted',
      createdAt: `${OUTSIDE_DATE} 11:00:00+04`,
      postedAt: `${OUTSIDE_DATE} 11:01:00+04`,
      transferId: transferOutside.rows[0].id,
      legDirection: 'debit',
    });
    await insertTransaction({
      kind: 'transfer_leg',
      memberId: grace.memberId,
      accountId: graceMsa,
      amount: '50',
      method: 'internal_transfer',
      status: 'posted',
      createdAt: `${OUTSIDE_DATE} 11:00:00+04`,
      postedAt: `${OUTSIDE_DATE} 11:01:00+04`,
      transferId: transferOutside.rows[0].id,
      legDirection: 'credit',
    });

    // ---- demised --------------------------------------------------------
    const ibrahim = await createMember(
      individualTypeId,
      'Ibrahim',
      'Demised',
      '2021-01-01'
    );
    ibrahimMemberNo = ibrahim.memberNo;
    const ibrahimMsa = (
      await run(
        mvAppUrl,
        `insert into account (member_id, account_type_id, is_membership_default, status)
         values ($1, $2, true, 'active') returning id`,
        [ibrahim.memberId, msaTypeId]
      )
    ).rows[0].id;

    demiseReference = (
      await insertTransaction({
        kind: 'demise',
        memberId: ibrahim.memberId,
        accountId: ibrahimMsa,
        amount: '20000',
        status: 'posted',
        submittedAt: `${IN_PERIOD_FROM} 08:00:00+04`,
        postedAt: `${IN_PERIOD_FROM} 09:00:00+04`,
        claimantKind: 'nominee',
        claimant: {
          name: 'Zara Ibrahim',
          nic: 'N123',
          address: 'Port Louis',
          relation: 'Spouse',
        },
        takafulBenefit: '15000',
      })
    ).reference;

    demiseOutsideReference = (
      await insertTransaction({
        kind: 'demise',
        memberId: ibrahim.memberId,
        accountId: ibrahimMsa,
        amount: '5000',
        status: 'posted',
        submittedAt: `${OUTSIDE_DATE} 08:00:00+04`,
        postedAt: `${OUTSIDE_DATE} 09:00:00+04`,
        claimantKind: 'nominee',
        claimant: { name: 'Outside Claimant' },
      })
    ).reference;

    // A non-member's account, closed to their claimant on death (0098).
    const customerApplication = await run(
      mvAppUrl,
      `insert into membership_application
         (membership_type_id, captured_by, status, application_kind)
       values ($1, $2, 'approved', 'customer_account') returning id`,
      [individualTypeId, officerId]
    );
    await run(
      mvAppUrl,
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'applicant', 1, $2::jsonb)`,
      [
        customerApplication.rows[0].id,
        JSON.stringify({ name: 'Jamal', surname: 'Nonmember' }),
      ]
    );
    const jamal = await run(
      mvAppUrl,
      `insert into customer (application_id) values ($1) returning id`,
      [customerApplication.rows[0].id]
    );
    const jamalHsa = (
      await run(
        mvAppUrl,
        `insert into account (customer_id, account_type_id, account_no, status)
         values ($1, $2, 'HSA0001', 'active') returning id`,
        [jamal.rows[0].id, hsaTypeId]
      )
    ).rows[0].id;

    closureOnDeathReference = (
      await insertTransaction({
        kind: 'closure',
        customerId: jamal.rows[0].id,
        accountId: jamalHsa,
        amount: '8000',
        status: 'submitted',
        submittedAt: `${IN_PERIOD_FROM} 08:30:00+04`,
        claimantKind: 'other',
        claimant: {
          name: 'Nadia Nonmember',
          nic: 'N999',
          address: 'Curepipe',
          relation: 'Daughter',
        },
      })
    ).reference;

    // An ordinary closure — no claimant — is not a death and must be
    // excluded.
    ordinaryClosureReference = (
      await insertTransaction({
        kind: 'closure',
        memberId: farah.memberId,
        accountId: farahMsa,
        amount: '300',
        status: 'posted',
        submittedAt: `${IN_PERIOD_FROM} 08:45:00+04`,
        postedAt: `${IN_PERIOD_FROM} 09:15:00+04`,
      })
    ).reference;
  }, 60_000);

  afterAll(async () => {
    if (mvPool) await mvPool.closePool();
    await run(ADMIN_URL, `drop database if exists ${mvDbName} with (force)`);
  });

  describe('admissions report', () => {
    it('lists an admission by whichever date it happened on, marking a rejoin', async () => {
      const { reports } = await loadMv();
      const report = reports.reportByCode('admissions')!;
      const result = await report.run({
        from: IN_PERIOD_FROM,
        to: IN_PERIOD_TO,
      });

      const codes = result.rows.map(r => r['Member no']);
      expect(codes).toContain(bobMemberNo);
      expect(codes).toContain(caraMemberNo);
      // Admitted well before the period — out.
      expect(result.rows.some(r => r.Name === 'Alice Admitted-Early')).toBe(
        false
      );

      const bobRow = result.rows.find(r => r['Member no'] === bobMemberNo)!;
      expect(bobRow.Name).toBe('Bob Newmember');
      expect(bobRow.Rejoin).toBe('');

      const caraRow = result.rows.find(r => r['Member no'] === caraMemberNo)!;
      expect(caraRow.Rejoin).toBe('Yes');
      expect(caraRow['Application reference']).toBe(caraRejoinReference);
      expect(caraRow['Status now']).toBe('Active');
    });

    it('filters by membership type', async () => {
      const { reports } = await loadMv();
      const report = reports.reportByCode('admissions')!;
      const result = await report.run({
        from: IN_PERIOD_FROM,
        to: IN_PERIOD_TO,
        type: 'corporate',
      });
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows.every(r => r.Type === 'Corporate')).toBe(true);
      expect(result.rows.some(r => r['Member no'] === bobMemberNo)).toBe(false);
    });
  });

  describe('resignations report', () => {
    it('shows the reason, amount, status and dates, and respects the period', async () => {
      const { reports } = await loadMv();
      const report = reports.reportByCode('resignations')!;
      const result = await report.run({
        from: IN_PERIOD_FROM,
        to: IN_PERIOD_TO,
      });

      const refs = result.rows.map(r => r.Reference);
      expect(refs).toContain(resignationDisbursedRef);
      expect(refs).toContain(resignationInProgressRef);
      expect(refs).toContain(resignationRejectedRef);
      expect(refs).not.toContain(resignationOutsideRef);

      const disbursed = result.rows.find(
        r => r.Reference === resignationDisbursedRef
      )!;
      expect(disbursed['Member no']).toBe(farahMemberNo);
      expect(disbursed.Reason).toBe('Relocating abroad');
      expect(disbursed['Amount paid out']).toBe('5000.00');
      expect(disbursed.Status).toBe('Disbursed');
      expect(disbursed.Disbursed).not.toBe('');

      const inProgress = result.rows.find(
        r => r.Reference === resignationInProgressRef
      )!;
      expect(inProgress.Status).toBe('With Secretary');
      expect(inProgress.Disbursed).toBe('');
    });

    it('offers All / On its way / Disbursed / Rejected, and finds one by it', async () => {
      const { reports } = await loadMv();
      const report = reports.reportByCode('resignations')!;
      const statusFilter = report.filters.find(f => f.name === 'status')!;
      expect(statusFilter.kind).toBe('choice');
      const choices = await statusFilter.choices!();
      expect(choices).toEqual([
        { value: 'in_progress', label: 'On its way' },
        { value: 'done', label: 'Disbursed' },
        { value: 'rejected', label: 'Rejected' },
      ]);

      const done = await report.run({ status: 'done' });
      expect(done.rows.map(r => r.Reference)).toContain(
        resignationDisbursedRef
      );
      expect(done.rows.map(r => r.Reference)).not.toContain(
        resignationInProgressRef
      );

      const inProgress = await report.run({ status: 'in_progress' });
      expect(inProgress.rows.map(r => r.Reference)).toContain(
        resignationInProgressRef
      );
      expect(inProgress.rows.map(r => r.Reference)).not.toContain(
        resignationDisbursedRef
      );

      const rejected = await report.run({ status: 'rejected' });
      expect(rejected.rows.map(r => r.Reference)).toContain(
        resignationRejectedRef
      );
      expect(rejected.rows.map(r => r.Reference)).not.toContain(
        resignationDisbursedRef
      );
    });
  });

  describe('withdrawals report', () => {
    it('shows the holder, account, amount and method, and respects the period', async () => {
      const { reports } = await loadMv();
      const report = reports.reportByCode('withdrawals')!;
      const result = await report.run({
        from: IN_PERIOD_FROM,
        to: IN_PERIOD_TO,
      });

      const refs = result.rows.map(r => r.Reference);
      expect(refs).toContain(withdrawalDisbursedRef);
      expect(refs).toContain(withdrawalInProgressRef);
      expect(refs).not.toContain(withdrawalOutsideRef);

      const disbursed = result.rows.find(
        r => r.Reference === withdrawalDisbursedRef
      )!;
      expect(disbursed['Member no']).toBe(farahMemberNo);
      expect(disbursed.Name).toBe('Farah Test');
      expect(disbursed.Amount).toBe('500.00');
      expect(disbursed.Method).toBe('Cash');
      expect(disbursed.Status).toBe('Disbursed');

      const inProgress = result.rows.find(
        r => r.Reference === withdrawalInProgressRef
      )!;
      // Money out not yet paid has only a placeholder method (transactions
      // report's own rule).
      expect(inProgress.Method).toBe('');
      expect(inProgress.Status).toBe('With Secretary');
    });
  });

  describe('transfers report', () => {
    it('gives one row per transfer — internal and external — and respects the period', async () => {
      const { reports } = await loadMv();
      const report = reports.reportByCode('transfers')!;
      const result = await report.run({
        from: IN_PERIOD_FROM,
        to: IN_PERIOD_TO,
      });

      const internal = result.rows.filter(
        r => r.Reference === internalTransferReference
      );
      expect(internal).toHaveLength(1);
      expect(internal[0].From).toContain('Farah Test');
      expect(internal[0].To).toContain('Grace Recipient');
      expect(internal[0].Amount).toBe('1500.00');
      expect(internal[0].Status).toBe('Disbursed');

      const external = result.rows.filter(
        r => r.Reference === externalTransferReference
      );
      expect(external).toHaveLength(1);
      expect(external[0].From).toContain('Farah Test');
      expect(external[0].To).toBe('Harold Estate');
      expect(external[0].Status).toBe('With Secretary');

      expect(
        result.rows.some(r => r.Reference === transferOutsideReference)
      ).toBe(false);
    });
  });

  describe('demised report', () => {
    it('includes a member claim and a non-member closure on death, excludes an ordinary closure, and respects the period', async () => {
      const { reports } = await loadMv();
      const report = reports.reportByCode('demised')!;
      const result = await report.run({
        from: IN_PERIOD_FROM,
        to: IN_PERIOD_TO,
      });

      const refs = result.rows.map(r => r.Reference);
      expect(refs).toContain(demiseReference);
      expect(refs).toContain(closureOnDeathReference);
      expect(refs).not.toContain(ordinaryClosureReference);
      expect(refs).not.toContain(demiseOutsideReference);

      const claim = result.rows.find(r => r.Reference === demiseReference)!;
      expect(claim['Member / Non-member']).toBe('Member');
      expect(claim['Member no']).toBe(ibrahimMemberNo);
      expect(claim.Claimant).toBe('Zara Ibrahim');
      // The Takaful benefit is already in the transaction's own amount
      // (0079) — not added again here.
      expect(claim['Total paid']).toBe('20000.00');
      expect(claim.Status).toBe('Disbursed');

      const closure = result.rows.find(
        r => r.Reference === closureOnDeathReference
      )!;
      expect(closure['Member / Non-member']).toBe('Non-member');
      expect(closure['Member no']).toBe('');
      expect(closure.Claimant).toBe('Nadia Nonmember');
      expect(closure['Total paid']).toBe('8000.00');
    });
  });
});
