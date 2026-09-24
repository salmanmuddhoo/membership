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

// What a member hears about their own transactions (S-1803), what the
// staff hear about work waiting on them (S-1804), and who is told of a
// void (S-1805), against real migrations. The channels are faked; the
// wording is the seeded one.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `txn_notify_test_${Date.now()}`;
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
    `begin; set local albarakah.actor_description = 'txn-notify.test'; ${sql}; commit;`
  );

let openPool: typeof import('../db/pool') | null = null;

async function closeOpenPool() {
  if (openPool) {
    await openPool.closePool();
    openPool = null;
  }
}

interface Sent {
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
}

async function load() {
  await closeOpenPool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  process.env.PUBLIC_APP_URL = 'https://members.example.mu';
  delete process.env.NOTIFY_EMAIL_DELIVERY;
  delete process.env.NOTIFY_WHATSAPP_DELIVERY;
  openPool = await import('../db/pool');
  const notify = await import('../notifications/notify');
  const sent: Sent[] = [];
  for (const name of ['email', 'whatsapp'] as const) {
    notify.registerChannel({
      name,
      async send(message) {
        sent.push({
          channel: name,
          recipient: message.recipient,
          subject: message.subject,
          body: message.body,
        });
      },
    });
  }
  return {
    sent,
    deposits: await import('./deposits'),
    withdrawals: await import('./withdrawals'),
    transfers: await import('./transfers'),
    review: await import('./review'),
    receipts: await import('./receipts'),
    config: await import('../config/reference'),
    staff: await import('../notifications/staff'),
    reports: await import('../reports/definitions'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let officer: Principal;
let treasurer: Principal;
let secretary: Principal;
let president: Principal;
let amina: { id: string; msa: string; edu: string };
let bilal: { id: string; msa: string };
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
    displayName: email.split('@')[0].replace(/^\w/, c => c.toUpperCase()),
    roles,
    roleNames: roles.map(r => r.replace('_', ' ')),
    permissions: new Set(permissions),
  } satisfies Principal;
}

// Which event a notification row carries, from the log.
async function eventsFor(transactionId: string) {
  const rows = await run(
    appUrl,
    `select event_code, channel, recipient, status from notification
      where entity_type = 'transaction' and entity_id = $1
      order by created_at, channel, recipient`,
    [transactionId]
  );
  return rows.rows.map(
    r => `${r.event_code} ${r.channel} ${r.recipient} ${r.status}`
  );
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (email, display_name, is_active, deactivated_at)
     values ('clerk@albarakah.mu', 'Clerk', true, null),
            ('officer@albarakah.mu', 'Officer', true, null),
            ('treasurer@albarakah.mu', 'Treasurer', true, null),
            ('treasurer2@albarakah.mu', 'Second Treasurer', true, null),
            ('secretary@albarakah.mu', 'Secretary', true, null),
            ('secretary2@albarakah.mu', 'Second Secretary', true, null),
            ('gone@albarakah.mu', 'Former Secretary', false, now()),
            ('president@albarakah.mu', 'President', true, null)
     returning id, email`
  );
  const byEmail = new Map(users.rows.map(r => [r.email, r.id]));
  // Roles on the record (S-1804 reads them), not only on the principal.
  await run(
    appUrl,
    `insert into user_role (user_id, role_id)
     select u.id, r.id
       from (values ('treasurer@albarakah.mu', 'treasurer'),
                    ('treasurer2@albarakah.mu', 'treasurer'),
                    ('secretary@albarakah.mu', 'secretary'),
                    ('secretary2@albarakah.mu', 'secretary'),
                    ('gone@albarakah.mu', 'secretary'),
                    ('president@albarakah.mu', 'president'),
                    ('officer@albarakah.mu', 'account_officer'),
                    ('clerk@albarakah.mu', 'clerk')) as g(email, role)
       join app_user u on u.email = g.email
       join role r on r.code = g.role`
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
    [
      'transaction.post',
      'transaction.disburse',
      'transaction.view',
      'receipt.void',
    ]
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

  // An account type with a floor of 1,000, for the near-floor advisory;
  // no cap on the MSA, so a large withdrawal can reach the chain.
  await configure(
    `insert into account_type
       (code, name, category, number_prefix, sort_order, minimum_balance)
     values ('edu', 'Education Savings', 'savings', 'EDU', 6, 1000);
     update account_type set maximum_transaction_amount = null where code = 'msa'`
  );

  const membershipTypeId = (
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
  const enrol = async (values: string) => {
    const application = await run(
      appUrl,
      `insert into membership_application (membership_type_id, captured_by, status)
       values ($1, $2, 'approved') returning id`,
      [membershipTypeId, officer.userId]
    );
    await run(
      appUrl,
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'applicant', 1, $2)`,
      [application.rows[0].id, values]
    );
    return (
      await run(
        appUrl,
        `insert into member (application_id, membership_type_id)
         values ($1, $2) returning id`,
        [application.rows[0].id, membershipTypeId]
      )
    ).rows[0].id;
  };
  const open = async (
    memberId: string,
    code: string,
    accountNo: string | null
  ) =>
    (
      await run(
        appUrl,
        `insert into account
           (member_id, account_type_id, is_membership_default, status, account_no)
         values ($1, $2, $3, 'active', $4) returning id`,
        [memberId, types[code], accountNo === null, accountNo]
      )
    ).rows[0].id;

  const aminaId = await enrol(
    '{"name": "Amina", "surname": "Test", "email": "amina@example.mu", "mobile": "+230 5111 1111"}'
  );
  amina = {
    id: aminaId,
    msa: await open(aminaId, 'msa', null),
    edu: await open(aminaId, 'edu', 'EDU0001'),
  };
  const bilalId = await enrol(
    '{"name": "Bilal", "surname": "Test", "email": "bilal@example.mu"}'
  );
  bilal = { id: bilalId, msa: await open(bilalId, 'msa', null) };

  await configure(
    `insert into bank_account (code, name, bank_name, account_number)
     values ('mcb', 'MCB current', 'MCB', '000123456789')`
  );
  bankAccountId = (
    await run(appUrl, `select id from bank_account where code = 'mcb'`)
  ).rows[0].id;

  const { deposits } = await load();
  await deposits.recordDeposit(
    {
      accountId: amina.msa,
      amount: '90000',
      method: 'bank_transfer',
      methodReference: 'OPEN-1',
      bankAccountId,
    },
    officer
  );
  await deposits.recordDeposit(
    {
      accountId: amina.msa,
      amount: '90000',
      method: 'bank_transfer',
      methodReference: 'OPEN-2',
      bankAccountId,
    },
    officer
  );
  await deposits.recordDeposit(
    { accountId: bilal.msa, amount: '5000', method: 'cash' },
    officer
  );
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('a member hears about their own money (S-1803)', () => {
  it('is told of a deposit once it is on the account, with the balance', async () => {
    const { deposits, sent } = await load();
    const deposit = await deposits.recordDeposit(
      { accountId: amina.edu, amount: '1500', method: 'cash' },
      officer
    );
    expect(await eventsFor(deposit.id)).toEqual([
      'receipt.issued email amina@example.mu sent',
      'receipt.issued whatsapp +230 5111 1111 sent',
      'deposit.posted email amina@example.mu sent',
      'deposit.posted whatsapp +230 5111 1111 sent',
    ]);
    const told = sent.find(s => s.subject?.includes('deposit of Rs'));
    expect(told?.subject).toBe('Al Barakah: deposit of Rs 1,500.00 received');
    expect(told?.body).toContain('EDU0001 · Education Savings');
    expect(told?.body).toContain('now stands at Rs 1,500.00');
    // Nothing waits on anyone: the staff hear nothing.
    expect(sent.some(s => s.recipient.endsWith('@albarakah.mu'))).toBe(false);
  });

  it('is told of a payout, and warned when it leaves the account near its floor', async () => {
    const { withdrawals, sent } = await load();
    // 1,500 less 200 is 1,300: within 500 of the 1,000 floor.
    const near = await withdrawals.recordWithdrawal(
      { accountId: amina.edu, amount: '200', method: 'cash' },
      officer
    );
    expect(near.status).toBe('posted');
    const events = await eventsFor(near.id);
    expect(events.filter(e => e.startsWith('withdrawal.disbursed'))).toEqual([
      'withdrawal.disbursed email amina@example.mu sent',
      'withdrawal.disbursed whatsapp +230 5111 1111 sent',
    ]);
    expect(events.filter(e => e.startsWith('balance.near_floor'))).toEqual([
      'balance.near_floor email amina@example.mu sent',
      'balance.near_floor whatsapp +230 5111 1111 sent',
    ]);
    const paid = sent.find(s => s.subject?.includes('paid out'));
    expect(paid?.body).toContain('by Cash');
    expect(paid?.body).toContain(`receipt ${near.receiptNo}`);
    expect(paid?.body).toContain('now stands at Rs 1,300.00');
    const warned = sent.find(s => s.subject?.includes('minimum balance'));
    expect(warned?.body).toContain('stands at Rs 1,300.00');
    expect(warned?.body).toContain(
      'minimum balance for this account is Rs 1,000.00'
    );

    // The margin at 0 is the advisory off.
    const { config, withdrawals: again } = await load();
    await config.setNearFloorMargin('0', {
      userId: officer.userId,
      email: officer.email,
    });
    const quiet = await again.recordWithdrawal(
      { accountId: amina.edu, amount: '100', method: 'cash' },
      officer
    );
    expect(
      (await eventsFor(quiet.id)).some(e => e.startsWith('balance.near_floor'))
    ).toBe(false);
    await config.setNearFloorMargin('500', {
      userId: officer.userId,
      email: officer.email,
    });
  });

  it('is told of a transfer on both sides — once when both sides are theirs', async () => {
    const { transfers, sent } = await load();
    const between = await transfers.recordTransfer(
      {
        sourceAccountId: amina.msa,
        amount: '2500',
        destination: { kind: 'account', accountId: bilal.msa },
      },
      officer
    );
    expect(between.status).toBe('posted');
    const debit = await eventsFor(between.debitLeg.id);
    expect(debit.filter(e => e.startsWith('transfer.posted'))).toEqual([
      'transfer.posted email amina@example.mu sent',
      'transfer.posted whatsapp +230 5111 1111 sent',
    ]);
    expect(await eventsFor(between.creditLeg!.id)).toEqual([
      'transfer.posted email bilal@example.mu sent',
    ]);
    const toAmina = sent.find(
      s => s.recipient === 'amina@example.mu' && s.subject?.includes('transfer')
    );
    expect(toAmina?.body).toContain(
      `from ${between.debitLeg.accountNo} · ${between.debitLeg.accountTypeName} to ${between.creditLeg!.accountNo} · ${between.creditLeg!.accountTypeName}`
    );
    expect(toAmina?.body).toContain(`(${between.reference})`);
    const toBilal = sent.find(s => s.recipient === 'bilal@example.mu');
    expect(toBilal?.body).toContain('now stands at Rs 7,500.00');

    const own = await transfers.recordTransfer(
      {
        sourceAccountId: amina.msa,
        amount: '100',
        destination: { kind: 'account', accountId: amina.edu },
      },
      officer
    );
    const ownEvents = [
      ...(await eventsFor(own.debitLeg.id)),
      ...(await eventsFor(own.creditLeg!.id)),
    ];
    expect(ownEvents.filter(e => e.startsWith('transfer.posted'))).toHaveLength(
      2
    );
    expect(ownEvents.filter(e => e.includes('amina@example.mu'))).toHaveLength(
      2
    );
  });
});

describe('the office hears what waits on it (S-1804)', () => {
  it('tells the step’s role on arrival, the captor on return, and the member at each turn', async () => {
    const { withdrawals, review, sent } = await load();
    const large = await withdrawals.recordWithdrawal(
      { accountId: amina.msa, amount: '120000', method: 'bank_transfer' },
      officer
    );
    expect(large.status).toBe('submitted');
    expect(await eventsFor(large.id)).toEqual([
      'withdrawal.submitted email amina@example.mu sent',
      'withdrawal.submitted whatsapp +230 5111 1111 sent',
      'transaction.awaiting email secretary2@albarakah.mu sent',
      'transaction.awaiting email secretary@albarakah.mu sent',
    ]);
    const awaiting = sent.find(s => s.recipient === 'secretary@albarakah.mu');
    expect(awaiting?.subject).toBe(
      `Awaiting you: Withdrawal ${large.reference} — Secretary review`
    );
    expect(awaiting?.body).toContain('Secretary,');
    expect(awaiting?.body).toContain('for Amina Test');
    expect(awaiting?.body).toContain('captured by Officer');
    expect(awaiting?.body).toContain(
      `https://members.example.mu/transactions/${large.id}`
    );
    // A deactivated holder of the role is not written to.
    expect(sent.some(s => s.recipient === 'gone@albarakah.mu')).toBe(false);

    await review.reviewTransaction(
      large.id,
      { outcome: 'forward', comment: 'Bank details checked' },
      secretary
    );
    expect((await eventsFor(large.id)).slice(4)).toEqual([
      'withdrawal.under_review email amina@example.mu sent',
      'withdrawal.under_review whatsapp +230 5111 1111 sent',
      'transaction.awaiting email president@albarakah.mu sent',
    ]);
    expect(
      sent.find(s => s.recipient === 'president@albarakah.mu')?.subject
    ).toContain('President decision');
    expect(
      sent.find(s => s.subject?.includes('is under review'))?.body
    ).toContain('Bank details checked');

    await review.reviewTransaction(
      large.id,
      { outcome: 'return', comment: 'Add the IBAN' },
      president
    );
    expect((await eventsFor(large.id)).slice(7)).toEqual([
      'transaction.returned email officer@albarakah.mu sent',
    ]);
    const returned = sent.find(s => s.recipient === 'officer@albarakah.mu');
    expect(returned?.subject).toBe(
      `Returned to you: Withdrawal ${large.reference}`
    );
    expect(returned?.body).toContain('returned by President: Add the IBAN');
    expect(returned?.body).toContain(
      `https://members.example.mu/transactions/${large.id}`
    );

    // Resubmitted: back with the President, and the member is not told
    // again that it is in.
    await withdrawals.resubmitWithdrawal(
      large.id,
      {
        accountId: amina.msa,
        amount: '120000',
        method: 'bank_transfer',
        methodReference: 'MU00 1234',
      },
      officer
    );
    expect((await eventsFor(large.id)).slice(8)).toEqual([
      'transaction.awaiting email president@albarakah.mu sent',
    ]);

    // Approval on its own says nothing; the payout does.
    await review.reviewTransaction(
      large.id,
      { outcome: 'forward', comment: '' },
      president
    );
    expect(await eventsFor(large.id)).toHaveLength(9);
    const posted = await review.postApprovedTransaction(large.id, treasurer, {
      method: 'bank_transfer',
      methodReference: 'MU00 1234',
      bankAccountId,
    });
    const after = await eventsFor(large.id);
    expect(after.filter(e => e.startsWith('withdrawal.disbursed'))).toEqual([
      'withdrawal.disbursed email amina@example.mu sent',
      'withdrawal.disbursed whatsapp +230 5111 1111 sent',
    ]);
    expect(
      sent.find(
        s =>
          s.subject?.includes('paid out') &&
          s.body.includes(`receipt ${posted.receiptNo}`)
      )?.body
    ).toContain('by Bank transfer');
  });

  it('tells the member why a withdrawal was refused', async () => {
    const { deposits, withdrawals, review, sent } = await load();
    await deposits.recordDeposit(
      {
        accountId: amina.msa,
        amount: '100000',
        method: 'bank_transfer',
        methodReference: 'TOP-UP',
        bankAccountId,
      },
      officer
    );
    const large = await withdrawals.recordWithdrawal(
      { accountId: amina.msa, amount: '110000', method: 'cash' },
      officer
    );
    await review.reviewTransaction(
      large.id,
      { outcome: 'reject', comment: 'Over the cash limit for one day.' },
      secretary
    );
    expect((await eventsFor(large.id)).slice(4)).toEqual([
      'withdrawal.rejected email amina@example.mu sent',
      'withdrawal.rejected whatsapp +230 5111 1111 sent',
    ]);
    expect(sent.at(-1)?.body).toContain(
      'was not approved by Al Barakah. Over the cash limit for one day.'
    );
  });

  it('lists the staff by role and by permission, active only', async () => {
    const { staff } = await load();
    expect((await staff.staffWithRole('secretary')).map(s => s.email)).toEqual([
      'secretary2@albarakah.mu',
      'secretary@albarakah.mu',
    ]);
    expect(
      (await staff.staffWithPermission('receipt.void')).map(s => s.name)
    ).toEqual(['Second Treasurer', 'Treasurer']);
    expect(await staff.staffMember(secretary.userId)).toMatchObject({
      name: 'Secretary',
      email: 'secretary@albarakah.mu',
    });
    const gone = (
      await run(
        appUrl,
        `select id from app_user where email = 'gone@albarakah.mu'`
      )
    ).rows[0].id;
    expect(await staff.staffMember(gone)).toBeNull();
  });
});

describe('a void is told to whoever else may void (S-1805)', () => {
  it('names the receipt, the reason and the user', async () => {
    const { withdrawals, receipts, sent } = await load();
    const paid = await withdrawals.recordWithdrawal(
      { accountId: amina.msa, amount: '300', method: 'cash' },
      officer
    );
    await receipts.voidTransactionReceipt(
      paid.id,
      'Printed on the wrong paper',
      treasurer
    );
    expect(
      (await eventsFor(paid.id)).filter(e => e.startsWith('receipt.voided'))
    ).toEqual(['receipt.voided email treasurer2@albarakah.mu sent']);
    const notice = sent.find(s => s.recipient === 'treasurer2@albarakah.mu');
    expect(notice?.subject).toBe(`Receipt ${paid.receiptNo} voided`);
    expect(notice?.body).toContain('Second Treasurer,');
    expect(notice?.body).toContain(
      `(Withdrawal ${paid.reference}, Rs 300.00 for Amina Test)`
    );
    expect(notice?.body).toContain(
      'voided by Treasurer: Printed on the wrong paper'
    );
    expect(notice?.body).toContain(
      `https://members.example.mu/receipts/${paid.id}`
    );
  });

  it('names every placeholder the events fill in', async () => {
    const { placeholdersForEvent } =
      await import('../notifications/event-codes');
    expect(placeholdersForEvent('deposit.posted')).toEqual([
      'member_name',
      'reference',
      'amount',
      'account',
      'balance',
    ]);
    expect(placeholdersForEvent('withdrawal.rejected')).toContain('comment');
    expect(placeholdersForEvent('transfer.posted')).toEqual(
      expect.arrayContaining(['from_account', 'to_account', 'balance'])
    );
    expect(placeholdersForEvent('transaction.awaiting')).toEqual(
      expect.arrayContaining(['recipient_name', 'step', 'captured_by', 'link'])
    );
    expect(placeholdersForEvent('receipt.voided')).toEqual(
      expect.arrayContaining(['receipt_no', 'voided_by', 'reason'])
    );
    expect(placeholdersForEvent('withdrawal.returned')).toBeNull();
  });
});

// The Section 13 reports (S-1806), over the transactions the cases above
// left behind: two deposits and a top-up on Amina's MSA, two transfers, a
// withdrawal paid out through the chain, one refused, one voided, and an
// Education account left within its margin of the floor.
describe('the Section 13 reports (S-1806)', () => {
  const today = new Date().toISOString().slice(0, 10);

  it('lists every transaction in a period by kind, method and officer', async () => {
    const { reports } = await load();
    const report = reports.reportByCode('transactions')!;
    expect(report.permission).toBe('transaction.view');
    const all = await report.run({ from: today, to: today });
    expect(all.rows.length).toBeGreaterThanOrEqual(10);
    // A transfer shows once, as the leg the money left.
    const transfers = await report.run({ kind: 'transfer' });
    expect(transfers.rows).toHaveLength(2);
    expect(transfers.rows.every(r => r.Kind === 'Transfer')).toBe(true);
    expect(transfers.rows[0].Account).toContain('Multiplier Savings Account');
    const cash = await report.run({ method: 'cash', officer: 'offic' });
    expect(cash.rows.length).toBeGreaterThan(0);
    expect(cash.rows.every(r => r.Method === 'Cash')).toBe(true);
    expect(cash.rows.every(r => r.Officer === 'Officer')).toBe(true);
    const refused = all.rows.find(r => r.Status === 'Rejected');
    expect(refused).toMatchObject({
      Kind: 'Withdrawal',
      Amount: '110000.00',
      Disbursed: null,
      Receipt: '',
    });
    expect(all.summary).toMatch(/disbursed: Deposit MUR 28[0-9,]*\.00/);
    expect(all.summary).toContain('Withdrawal MUR 120,600.00');
    const none = await report.run({ from: '2000-01-01', to: '2000-01-02' });
    expect(none.rows).toEqual([]);
    expect(none.summary).toBe('0 transaction(s).');
  });

  it('shows what waits on a step, for how long, and the turnaround of the decided', async () => {
    const { reports, withdrawals } = await load();
    const waiting = await withdrawals.recordWithdrawal(
      { accountId: amina.msa, amount: '105000', method: 'cash' },
      officer
    );
    const report = reports.reportByCode('pending-approvals')!;
    const result = await report.run({});
    expect(result.rows[0]).toMatchObject({
      Reference: waiting.reference,
      Kind: 'Withdrawal',
      Holder: 'Amina Test',
      Status: 'Submitted',
      'Waiting at': 'Secretary review · Secretary',
      Officer: 'Officer',
      Decided: null,
      Days: 0,
    });
    const decided = result.rows.filter(r => r.Decided !== null);
    expect(decided.map(r => r.Status).sort()).toEqual([
      'Disbursed',
      'Rejected',
    ]);
    expect(decided.every(r => r['Waiting at'] === '')).toBe(true);
    expect(result.summary).toBe(
      '1 waiting (oldest 0 day(s)); 2 decided, 0.0 day(s) from submission to decision on average.'
    );
    // Only what went to a chain: the ones the matrix posted at once are
    // not approvals.
    expect(result.rows).toHaveLength(3);
    const none = await report.run({ kind: 'deposit' });
    expect(none.rows).toEqual([]);
    expect(none.summary).toBe('0 waiting; 0 decided.');
  });

  it('lists the accounts at or near their minimum, within the configured or a typed margin', async () => {
    const { reports } = await load();
    const report = reports.reportByCode('accounts-near-floor')!;
    expect(report.permission).toBe('account.view');
    const near = await report.run({});
    expect(near.rows).toEqual([
      {
        'Account no': 'EDU0001',
        Type: 'Education Savings',
        'Member no': expect.any(String),
        Holder: 'Amina Test',
        Status: 'Active',
        Balance: '1300.00',
        Minimum: '1000.00',
        Headroom: '300.00',
        'At minimum': 'No',
      },
    ]);
    expect(near.summary).toBe(
      '1 account(s) within MUR 500.00 of their minimum, 0 at or below it.'
    );
    expect((await report.run({ margin: '10' })).rows).toEqual([]);
    const wide = await report.run({ margin: '200,000' });
    expect(wide.rows).toHaveLength(3);
    expect(wide.rows[0].Headroom).toBe('300.00');
    expect((await report.run({ type: 'edu' })).rows).toHaveLength(1);
  });

  it('filters the accounts report by status and balance, and shows the balance', async () => {
    const { reports } = await load();
    const report = reports.reportByCode('accounts')!;
    const active = await report.run({ status: 'active' });
    expect(active.rows).toHaveLength(3);
    expect(active.summary).toMatch(/^3 account\(s\), MUR [\d,]+\.\d\d held\.$/);
    const rich = await report.run({ balanceFrom: '100000' });
    expect(rich.rows).toHaveLength(1);
    expect(rich.rows[0].Type).toBe('Multiplier Savings Account');
    const small = await report.run({ balanceTo: '2000' });
    expect(small.rows.map(r => r['Account no'])).toEqual(['EDU0001']);
    expect(small.rows[0].Balance).toBe('1300.00');
    expect((await report.run({ status: 'closed' })).rows).toEqual([]);
    // A bound that is not an amount is no bound.
    expect((await report.run({ balanceFrom: 'lots' })).rows).toHaveLength(3);
  });
});
