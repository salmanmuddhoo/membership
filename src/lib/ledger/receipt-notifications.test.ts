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

// A receipt sent to its member when it is issued (S-1602), and the account
// statement read off the entries (S-1604). Against real migrations, like
// every ledger suite.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `rctnotify_test_${Date.now()}`;
const ownerUrl = `postgresql://postgres@127.0.0.1:5433/${dbName}`;
const appUrl = `postgresql://albarakah_app:devpassword@127.0.0.1:5433/${dbName}`;
const SECRET = 'receipt-link-test-secret-with-thirty-two-plus-characters';

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
  process.env.MEMBER_SESSION_SECRET ??= SECRET;
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
    notify,
    deposits: await import('./deposits'),
    withdrawals: await import('./withdrawals'),
    receipts: await import('./receipts'),
    receiptNotifications: await import('./receipt-notifications'),
    links: await import('./receipt-links'),
    ledger: await import('./ledger'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let officer: Principal;
let reachable: { id: string; msa: string };
let unreachable: { id: string; msa: string };

function principalFor(userId: string, email: string) {
  return {
    userId,
    entraSubject: `sub-${email}`,
    email,
    displayName: email,
    roles: ['account_officer'],
    roleNames: ['account officer'],
    permissions: new Set([
      'transaction.capture',
      'transaction.post',
      'transaction.view',
    ]),
  } satisfies Principal;
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
  officer = principalFor(user.rows[0].id, 'officer@albarakah.mu');

  const membershipTypeId = (
    await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    )
  ).rows[0].id;
  const msaTypeId = (
    await run(appUrl, `select id from account_type where code = 'msa'`)
  ).rows[0].id;

  const member = async (values: Record<string, string>) => {
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
      [application.rows[0].id, JSON.stringify(values)]
    );
    const m = await run(
      appUrl,
      `insert into member (application_id, membership_type_id)
       values ($1, $2) returning id`,
      [application.rows[0].id, membershipTypeId]
    );
    const account = await run(
      appUrl,
      `insert into account (member_id, account_type_id, is_membership_default, status)
       values ($1, $2, false, 'active') returning id`,
      [m.rows[0].id, msaTypeId]
    );
    return { id: m.rows[0].id, msa: account.rows[0].id };
  };
  reachable = await member({
    name: 'Amina',
    surname: 'Test',
    email: 'amina@example.mu',
    mobile: '+230 5789 1234',
  });
  unreachable = await member({ name: 'Bilal', surname: 'Test' });
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('a receipt sent to its member (S-1602)', () => {
  it('goes out on every channel the member has an address for, with a link that opens it', async () => {
    const { sent, deposits, links, notify } = await load();
    const deposit = await deposits.recordDeposit(
      {
        accountId: reachable.msa,
        amount: '7000',
        method: 'cash',
        reason: 'Top up',
      },
      officer
    );
    expect(sent.map(s => s.channel).sort()).toEqual(['email', 'whatsapp']);
    const email = sent.find(s => s.channel === 'email')!;
    expect(email.recipient).toBe('amina@example.mu');
    expect(email.subject).toBe(
      `Your receipt ${deposit.receiptNo} from Al Barakah`
    );
    expect(email.body).toContain('Assalamoualaikoum Amina Test');
    expect(email.body).toContain('Deposit of Rs 7,000.00');
    expect(email.body).toContain(deposit.reference);
    const link = email.body.match(
      /https:\/\/members\.example\.mu\/receipts\/shared\/(\S+)/
    );
    expect(link).not.toBeNull();
    expect(await links.verifyReceiptToken(link![1])).toBe(deposit.id);
    const whatsapp = sent.find(s => s.channel === 'whatsapp')!;
    expect(whatsapp.recipient).toBe('+230 5789 1234');
    expect(whatsapp.body).toContain(deposit.receiptNo);

    // On the record against the transaction, so the receipt page can say
    // where it went.
    const log = await notify.notificationsFor('transaction', deposit.id);
    expect(log).toHaveLength(2);
    expect(log.every(n => n.status === 'sent')).toBe(true);
    expect(log.every(n => n.eventCode === 'receipt.issued')).toBe(true);
  });

  it('sends nothing to a member with no address on file, and says so', async () => {
    const { sent, deposits, receiptNotifications } = await load();
    const deposit = await deposits.recordDeposit(
      { accountId: unreachable.msa, amount: '500', method: 'cash' },
      officer
    );
    expect(sent).toHaveLength(0);
    const again = await receiptNotifications.notifyReceiptIssued(deposit.id);
    expect(again.notificationIds).toEqual([]);
    expect(again.contact).toMatchObject({ email: null, mobile: null });
  });

  it('can be sent again from the receipt, and not once the receipt is void', async () => {
    const { sent, withdrawals, receipts, receiptNotifications, notify } =
      await load();
    const withdrawal = await withdrawals.recordWithdrawal(
      { accountId: reachable.msa, amount: '1000', method: 'cash' },
      officer
    );
    expect(sent).toHaveLength(2);
    expect(sent[0].body).toContain('Withdrawal of Rs 1,000.00');

    const resend = await receiptNotifications.notifyReceiptIssued(
      withdrawal.id
    );
    expect(resend.notificationIds).toHaveLength(2);
    expect(resend.link).toMatch(/\/receipts\/shared\//);
    expect(sent).toHaveLength(4);
    expect(
      await notify.notificationsFor('transaction', withdrawal.id)
    ).toHaveLength(4);

    const treasurer = {
      ...principalFor(officer.userId, 'officer@albarakah.mu'),
      roles: ['treasurer'],
      roleNames: ['treasurer'],
      permissions: new Set(['receipt.void', 'transaction.view']),
    };
    const other = await run(
      appUrl,
      `insert into app_user (email, display_name)
       values ('treasurer@albarakah.mu', 'Treasurer') returning id`
    );
    await receipts.voidTransactionReceipt(withdrawal.id, 'Printed twice', {
      ...treasurer,
      userId: other.rows[0].id,
    });
    const afterVoid = await receiptNotifications.notifyReceiptIssued(
      withdrawal.id
    );
    expect(afterVoid.notificationIds).toEqual([]);
    expect(sent).toHaveLength(4);
  });

  it('is nothing without a link secret: the receipt still issues, the wording says where to ask', async () => {
    process.env.MEMBER_SESSION_SECRET = 'short';
    const { sent, deposits } = await load();
    const deposit = await deposits.recordDeposit(
      { accountId: reachable.msa, amount: '250', method: 'cash' },
      officer
    );
    expect(deposit.receiptNo).toMatch(/^RCT-/);
    expect(sent).toHaveLength(2);
    expect(sent[0].body).toContain('Ask at your branch for a printed copy.');
    expect(sent[0].body).not.toContain('/receipts/shared/');
  });
});

describe('the account statement (S-1604)', () => {
  it('opens at what stood before the period, runs the balance through it, and closes on the last line', async () => {
    const { ledger } = await load();
    const today = (await run(appUrl, 'select current_date::text as d')).rows[0]
      .d as string;
    const shift = (days: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000)
        .toISOString()
        .slice(0, 10);

    // Everything above posted today: 7000 + 500 (other member) ... on this
    // account: 7000 - 1000 + 250.
    const statement = (await ledger.accountStatement(
      reachable.msa,
      today,
      today
    ))!;
    expect(statement).toMatchObject({
      accountNo: expect.any(String),
      accountTypeName: 'Multiplier Savings Account',
      holderName: 'Amina Test',
      from: today,
      to: today,
      openingBalance: '0.00',
      totalCredits: '7250.00',
      totalDebits: '1000.00',
      closingBalance: '6250.00',
    });
    expect(
      statement.lines.map(l => [l.description, l.debit, l.credit, l.balance])
    ).toEqual([
      ['Deposit', null, '7000.00', '7000.00'],
      ['Withdrawal', '1000.00', null, '6000.00'],
      ['Deposit', null, '250.00', '6250.00'],
    ]);
    expect(statement.lines[0].reason).toBe('Top up');
    expect(statement.lines[0].receiptNo).toMatch(/^RCT-/);
    expect(statement.lines[0].methodName).toBe('Cash');

    // Tomorrow onwards: all of it is the opening balance and nothing moves.
    const later = (await ledger.accountStatement(
      reachable.msa,
      shift(1),
      shift(2)
    ))!;
    expect(later).toMatchObject({
      openingBalance: '6250.00',
      closingBalance: '6250.00',
      totalCredits: '0.00',
      totalDebits: '0.00',
      lines: [],
    });

    // Before any of it: nothing, on both sides.
    const earlier = (await ledger.accountStatement(
      reachable.msa,
      shift(-2),
      shift(-1)
    ))!;
    expect(earlier).toMatchObject({
      openingBalance: '0.00',
      closingBalance: '0.00',
      lines: [],
    });

    expect(
      await ledger.accountStatement(
        '00000000-0000-4000-8000-000000000000',
        today,
        today
      )
    ).toBeNull();
  });
});
