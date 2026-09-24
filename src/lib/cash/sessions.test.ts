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

// The cash drawer (S-2001, S-2002): opened with a float, expected to hold
// what the ledger and the fee receipts say, closed against a count —
// with the attribution done by the database, on the posting itself.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `cash_test_${Date.now()}`;
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
    `begin; set local albarakah.actor_description = 'cash.test'; ${sql}; commit;`
  );

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
    cash: await import('./sessions'),
    deposits: await import('../ledger/deposits'),
    withdrawals: await import('../ledger/withdrawals'),
    payments: await import('../payments/payments'),
    capture: await import('../applications/capture'),
    reports: await import('../reports/definitions'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let cashier: Principal;
let treasurer: Principal;
let msa: string;
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
    roleNames: roles,
    permissions: new Set(permissions),
  } satisfies Principal;
}

async function sessionOf(table: 'transaction' | 'payment', id: string) {
  return (
    await run(appUrl, `select cash_session_id from ${table} where id = $1`, [
      id,
    ])
  ).rows[0].cash_session_id as string | null;
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('cashier@albarakah.mu', 'Cashier'), ('treasurer@albarakah.mu', 'Treasurer')
     returning id, email`
  );
  const byEmail = new Map(users.rows.map(r => [r.email, r.id]));
  cashier = principalFor(
    byEmail.get('cashier@albarakah.mu'),
    'cashier@albarakah.mu',
    ['account_officer'],
    [
      'cash.session',
      'transaction.capture',
      'transaction.post',
      'transaction.disburse',
      'transaction.view',
      'application.capture',
      'payment.record',
      'payment.view',
    ]
  );
  treasurer = principalFor(
    byEmail.get('treasurer@albarakah.mu'),
    'treasurer@albarakah.mu',
    ['treasurer'],
    [
      'cash.session',
      'cash.view',
      'transaction.capture',
      'transaction.post',
      'transaction.disburse',
      'payment.void',
    ]
  );
  bankAccountId = (
    await run(
      appUrl,
      `begin; set local albarakah.actor_description = 'cash.test';
       insert into bank_account (code, name, bank_name, account_number)
       values ('mcb', 'MCB current', 'MCB', '000123456789'); commit;
       select id from bank_account where code = 'mcb'`
    ).then(r => (Array.isArray(r) ? r[r.length - 1] : r))
  ).rows[0].id;
  await configure(`select 1`);

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
    [membershipTypeId, cashier.userId]
  );
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, '{"name": "Amina", "surname": "Test"}')`,
    [application.rows[0].id]
  );
  const member = await run(
    appUrl,
    `insert into member (application_id, membership_type_id)
     values ($1, $2) returning id`,
    [application.rows[0].id, membershipTypeId]
  );
  msa = (
    await run(
      appUrl,
      `insert into account (member_id, account_type_id, is_membership_default, status)
       select $1, id, true, 'active' from account_type where code = 'msa'
       returning id`,
      [member.rows[0].id]
    )
  ).rows[0].id;
}, 60_000);

afterAll(async () => {
  if (openPool) await openPool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('the cash drawer (S-2001, S-2002)', () => {
  it('opens once with a float, and refuses a second drawer', async () => {
    const { cash } = await load();
    await expect(
      cash.openSession({ openingFloat: 'five' }, cashier)
    ).rejects.toThrowError(/not an amount for the float/);
    const session = await cash.openSession({ openingFloat: '5000' }, cashier);
    expect(session).toMatchObject({
      cashierName: 'Cashier',
      openingFloat: '5000.00',
      closedAt: null,
      closingCount: null,
      overShort: null,
    });
    await expect(
      cash.openSession({ openingFloat: '100' }, cashier)
    ).rejects.toThrowError(/already open/);
    expect((await cash.openSessionFor(cashier.userId))?.id).toBe(session.id);
    expect(await cash.openSessionFor(treasurer.userId)).toBeNull();
    await expect(
      cash.openSession(
        { openingFloat: '1' },
        { ...treasurer, permissions: new Set() }
      )
    ).rejects.toThrowError(/permission/);
  });

  it('attributes cash movements to the open drawer as they post, and counts them', async () => {
    const { cash, deposits, withdrawals, payments, capture } = await load();
    const session = (await cash.openSessionFor(cashier.userId))!;

    // Cash in: a deposit posted at once, and a fee receipt.
    const deposit = await deposits.recordDeposit(
      { accountId: msa, amount: '1000', method: 'cash' },
      cashier
    );
    expect(await sessionOf('transaction', deposit.id)).toBe(session.id);
    const application = await capture.startApplication('individual', {
      userId: cashier.userId,
      email: cashier.email,
    });
    const fee = await payments.recordPayment(
      {
        applicationId: application.id,
        method: 'cash',
        amounts: { entrance: '1500.00', takaful: '2000.00', shares: '5000.00' },
      },
      cashier
    );
    expect(await sessionOf('payment', fee.id)).toBe(session.id);

    // Not cash: through the bank, not the drawer.
    const transfer = await deposits.recordDeposit(
      {
        accountId: msa,
        amount: '2000',
        method: 'bank_transfer',
        methodReference: 'IN-1',
        bankAccountId,
      },
      cashier
    );
    expect(await sessionOf('transaction', transfer.id)).toBeNull();

    // Cash out: a withdrawal paid at once.
    const withdrawal = await withdrawals.recordWithdrawal(
      { accountId: msa, amount: '300', method: 'cash' },
      cashier
    );
    expect(await sessionOf('transaction', withdrawal.id)).toBe(session.id);

    // Somebody with no drawer open: nobody's.
    const nobodys = await deposits.recordDeposit(
      { accountId: msa, amount: '50', method: 'cash' },
      treasurer
    );
    expect(await sessionOf('transaction', nobodys.id)).toBeNull();

    const figures = await cash.drawerFigures(session.id);
    expect(figures).toMatchObject({
      openingFloat: '5000.00',
      cashIn: '9500.00',
      cashOut: '300.00',
      expected: '14200.00',
    });
    expect(
      figures.movements.map(m => `${m.what} ${m.direction} ${m.amount}`)
    ).toEqual([
      'Deposit in 1000.00',
      'Fee receipt in 8500.00',
      'Withdrawal out 300.00',
    ]);
    expect(figures.movements[1].receiptNo).toMatch(/^RCT-/);
  });

  it('closes against a count, fixes the over or short, and never changes again', async () => {
    const { cash } = await load();
    await expect(
      cash.closeSession({ closingCount: '14150' }, treasurer)
    ).rejects.toThrowError(/no drawer open/);
    const closed = await cash.closeSession(
      { closingCount: '14150', note: 'One note short' },
      cashier
    );
    expect(closed).toMatchObject({
      closingCount: '14150.00',
      expectedAtClose: '14200.00',
      overShort: '-50.00',
      note: 'One note short',
    });
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(await cash.openSessionFor(cashier.userId)).toBeNull();
    await expect(
      cash.closeSession({ closingCount: '1' }, cashier)
    ).rejects.toThrowError(/no drawer open/);

    // A closed session is a record; the database refuses to alter it.
    await expect(
      run(appUrl, `update cash_session set closing_count = 0 where id = $1`, [
        closed.id,
      ])
    ).rejects.toThrowError(/closed and cannot change/);
    await expect(
      run(appUrl, `delete from cash_session where id = $1`, [closed.id])
    ).rejects.toThrowError(/never deleted/);

    const audited = await run(
      appUrl,
      `select action, new_value->>'over_short' as over_short
         from audit_event
        where entity_type = 'cash_session' and entity_id = $1
        order by occurred_at`,
      [closed.id]
    );
    expect(audited.rows).toEqual([
      { action: 'cash.session.opened', over_short: null },
      { action: 'cash.session.closed', over_short: '-50.00' },
    ]);

    // The next drawer starts afresh, and the list shows both.
    const again = await cash.openSession({ openingFloat: '2000' }, cashier);
    expect((await cash.drawerFigures(again.id)).expected).toBe('2000.00');
    const listed = await cash.listSessions({});
    expect(listed.map(s => [s.cashierName, s.overShort])).toEqual([
      ['Cashier', null],
      ['Cashier', '-50.00'],
    ]);
    expect(await cash.listSessions({ cashierId: treasurer.userId })).toEqual(
      []
    );

    // Paged for the officer's screen: a page at a time, newest first, with
    // a total and the open/over-short figures across every drawer in the
    // period — not just the page.
    expect(await cash.countSessions({})).toBe(2);
    const firstPage = await cash.listSessions({ limit: 1, offset: 0 });
    expect(firstPage.map(s => s.overShort)).toEqual([null]);
    const secondPage = await cash.listSessions({ limit: 1, offset: 1 });
    expect(secondPage.map(s => s.overShort)).toEqual(['-50.00']);
    expect(await cash.sessionTotals({})).toEqual({
      open: 1,
      netOverShort: '-50.00',
    });
  });

  // S-2003 · The day's reconciliation, over what the cases above left: one
  // drawer closed short, one just opened, and the Treasurer's cash deposit
  // that went through no drawer.
  it('reconciles every drawer of the day, and the cash moved with none open', async () => {
    const { cash, payments, reports } = await load();
    const report = reports.reportByCode('cash-reconciliation')!;
    expect(report.permission).toBe('cash.view');
    const today = new Date().toISOString().slice(0, 10);

    const result = await report.run({ from: today, to: today });
    expect(result.rows.map(r => [r.Cashier, r.Status])).toEqual([
      ['Cashier', 'Closed'],
      ['Cashier', 'Open'],
      ['Treasurer', 'No drawer'],
    ]);
    expect(result.rows[0]).toMatchObject({
      Float: '5000.00',
      'Cash in': '9500.00',
      'Cash out': '300.00',
      Expected: '14200.00',
      Counted: '14150.00',
      'Over/short': '-50.00',
      Movements: 3,
      Note: 'One note short',
    });
    expect(result.rows[0].Opened).toMatch(/^\d\d:\d\d$/);
    expect(result.rows[0].Closed).toMatch(/^\d\d:\d\d$/);
    expect(result.rows[1]).toMatchObject({
      Float: '2000.00',
      'Cash in': '0.00',
      'Cash out': '0.00',
      Expected: '2000.00',
      Counted: null,
      'Over/short': null,
      Closed: '',
      Movements: 0,
    });
    expect(result.rows[2]).toMatchObject({
      Opened: '',
      Float: null,
      'Cash in': '50.00',
      'Cash out': '0.00',
      Expected: null,
      Movements: 1,
    });
    expect(result.summary).toBe(
      '2 drawer(s): 1 closed, 1 open; cash in MUR 9,500.00, out MUR 300.00; ' +
        'counted MUR 14,150.00 against MUR 14,200.00 expected, short by MUR 50.00. ' +
        '1 cash movement(s) with no drawer open: MUR 50.00 in, MUR 0.00 out.'
    );

    // By cashier, and outside the period.
    const mine = await report.run({ cashier: 'treas' });
    expect(mine.rows).toHaveLength(1);
    expect(mine.summary).toBe(
      '0 drawer(s): 0 closed, 0 open; cash in MUR 0.00, out MUR 0.00. ' +
        '1 cash movement(s) with no drawer open: MUR 50.00 in, MUR 0.00 out.'
    );
    const none = await report.run({ from: '2000-01-01', to: '2000-01-02' });
    expect(none.rows).toEqual([]);
    expect(none.summary).toBe(
      '0 drawer(s): 0 closed, 0 open; cash in MUR 0.00, out MUR 0.00.'
    );

    // A fee receipt voided after the drawer closed: the record stands, the
    // movements no longer add up to it, and the row says so.
    const closed = (await cash.listSessions({})).find(s => s.closedAt)!;
    const fee = await run(
      appUrl,
      `select id from payment where cash_session_id = $1 and kind = 'payment'`,
      [closed.id]
    );
    await payments.voidPayment(fee.rows[0].id, 'Taken in error', treasurer);
    const after = await report.run({ from: today, to: today });
    expect(after.rows[0]).toMatchObject({
      Status: 'Closed · receipt voided since',
      'Cash in': '1000.00',
      Expected: '14200.00',
      Counted: '14150.00',
      'Over/short': '-50.00',
      Movements: 2,
    });
  });
});
