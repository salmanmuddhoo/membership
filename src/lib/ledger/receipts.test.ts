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

// A transaction's receipt on the one sequence (S-1601, S-1603): what the
// sheet reads, a print on the record, a void that withdraws the number and
// leaves the money, and the reconciliation and report that see both kinds
// of receipt. Against real migrations, like every ledger suite.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `txreceipts_test_${Date.now()}`;
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
    deposits: await import('./deposits'),
    withdrawals: await import('./withdrawals'),
    transfers: await import('./transfers'),
    receipts: await import('./receipts'),
    reconciliation: await import('../payments/receipts'),
    reports: await import('../reports/definitions'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let officer: Principal;
let treasurer: Principal;
let member: { id: string; shares: string; msa: string };

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

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('officer@albarakah.mu', 'Officer'), ('treasurer@albarakah.mu', 'Treasurer')
     returning id, email`
  );
  const byEmail = new Map(users.rows.map(r => [r.email, r.id]));
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
    ['receipt.void', 'transaction.view', 'payment.view']
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
  const open = async (code: string) =>
    (
      await run(
        appUrl,
        `insert into account (member_id, account_type_id, is_membership_default, status)
         values ($1, $2, $3, 'active') returning id`,
        [m.rows[0].id, types[code], code === 'shares']
      )
    ).rows[0].id;
  member = {
    id: m.rows[0].id,
    shares: await open('shares'),
    msa: await open('msa'),
  };
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('the receipt a transaction takes (S-1601)', () => {
  it('reads the sheet off the transaction, by id, by number id or by number', async () => {
    const { deposits, receipts } = await load();
    const deposit = await deposits.recordDeposit(
      {
        accountId: member.shares,
        amount: '7000',
        method: 'cash',
        reason: 'Top up',
      },
      officer
    );
    const byId = await receipts.loadTransactionReceipt(deposit.id);
    expect(byId).toMatchObject({
      receiptNo: deposit.receiptNo,
      state: 'issued',
      voidReason: null,
      capturedByRole: 'account officer',
      postedByName: 'Officer',
    });
    expect(byId?.transaction).toMatchObject({
      reference: deposit.reference,
      holderName: 'Amina Test',
      amount: '7000.00',
      balanceAfter: '7000.00',
    });
    const byNumber = await receipts.loadTransactionReceipt(deposit.receiptNo!);
    expect(byNumber?.transaction.id).toBe(deposit.id);
    const byNumberId = await receipts.loadTransactionReceipt(
      byId!.receiptNumberId
    );
    expect(byNumberId?.transaction.id).toBe(deposit.id);
    // Two transactions, two numbers, one sequence.
    const next = await deposits.recordDeposit(
      { accountId: member.msa, amount: '500', method: 'cash' },
      officer
    );
    expect(
      Number(next.receiptNo!.slice(4)) - Number(deposit.receiptNo!.slice(4))
    ).toBe(1);
  });

  it("a transfer's two legs share one receipt, and it names both sides", async () => {
    const { transfers, receipts } = await load();
    const transfer = await transfers.recordTransfer(
      {
        sourceAccountId: member.msa,
        amount: '200',
        destination: { kind: 'account', accountId: member.shares },
      },
      officer
    );
    expect(transfer.creditLeg?.receiptNo).toBeNull();
    const sheet = await receipts.loadTransactionReceipt(transfer.debitLeg.id);
    expect(sheet?.receiptNo).toBe(transfer.debitLeg.receiptNo);
    expect(sheet?.transaction.transferReference).toBe(transfer.reference);
    expect(sheet?.transaction.counterpartAccountId).toBe(member.shares);
    expect(
      await receipts.loadTransactionReceipt(transfer.creditLeg!.id)
    ).toBeNull();
  });

  it('records a print, so a reprint says so', async () => {
    const { deposits, receipts } = await load();
    const deposit = await deposits.recordDeposit(
      { accountId: member.msa, amount: '50', method: 'cash' },
      officer
    );
    expect((await receipts.transactionPrintHistory(deposit.id)).count).toBe(0);
    await receipts.recordTransactionReceiptPrint(deposit.id, officer);
    await receipts.recordTransactionReceiptPrint(deposit.id, treasurer);
    const history = await receipts.transactionPrintHistory(deposit.id);
    expect(history.count).toBe(2);
    expect(history.firstPrintedByName).toBe('Officer');
    await expect(
      receipts.recordTransactionReceiptPrint(deposit.id, {
        ...officer,
        permissions: new Set(),
      })
    ).rejects.toThrowError(/permission/);
    // Append-only, like a payment's.
    await expect(
      run(ownerUrl, `delete from receipt_print where transaction_id = $1`, [
        deposit.id,
      ])
    ).rejects.toThrowError(/append-only/);
  });
});

describe('voiding a transaction receipt (S-1603)', () => {
  it('withdraws the number with a reason and leaves the money where it is', async () => {
    const { withdrawals, deposits, receipts, reconciliation } = await load();
    await deposits.recordDeposit(
      { accountId: member.msa, amount: '3000', method: 'cash' },
      officer
    );
    const withdrawal = await withdrawals.recordWithdrawal(
      { accountId: member.msa, amount: '1000', method: 'cash' },
      officer
    );
    const balance = async () =>
      (
        await run(
          appUrl,
          `select balance from account_balance where account_id = $1`,
          [member.msa]
        )
      ).rows[0].balance;
    const before = await balance();

    await expect(
      receipts.voidTransactionReceipt(withdrawal.id, 'Wrong', officer)
    ).rejects.toThrowError(/permission/);
    await expect(
      receipts.voidTransactionReceipt(withdrawal.id, '   ', treasurer)
    ).rejects.toThrowError(/why/);
    // The captor may not void it, whatever permission they hold.
    await expect(
      receipts.voidTransactionReceipt(withdrawal.id, 'Wrong', {
        ...officer,
        permissions: new Set(['receipt.void']),
      })
    ).rejects.toThrowError(/may not void/);

    const voided = await receipts.voidTransactionReceipt(
      withdrawal.id,
      'Printed on the wrong paper',
      treasurer
    );
    expect(voided.state).toBe('void');
    expect(voided.voidReason).toBe('Printed on the wrong paper');
    expect(voided.voidedAt).toBeInstanceOf(Date);
    expect(voided.transaction.status).toBe('posted');
    expect(await balance()).toBe(before);
    await expect(
      receipts.voidTransactionReceipt(withdrawal.id, 'Again', treasurer)
    ).rejects.toThrowError(/already void/);

    const event = await run(
      appUrl,
      `select event_type, receipt_no, payload->>'reason' as reason
         from financial_event where transaction_id = $1 order by sequence_no`,
      [withdrawal.id]
    );
    expect(event.rows.map(r => r.event_type)).toEqual([
      'transaction.posted',
      'transaction.voided',
    ]);
    expect(event.rows[1]).toMatchObject({
      receipt_no: withdrawal.receiptNo,
      reason: 'Printed on the wrong paper',
    });

    // The reconciliation lists it as a void that opens the transaction.
    const period = await reconciliation.reconcileReceipts(
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000)
    );
    const finding = period.exceptions.find(
      e => e.receiptNo === withdrawal.receiptNo
    );
    expect(finding).toMatchObject({
      kind: 'void',
      transactionId: withdrawal.id,
      paymentId: null,
      reason: 'Printed on the wrong paper',
    });
  });

  it('counts transaction receipts in the period total by their direction, and in the report', async () => {
    const { deposits, withdrawals, transfers, reconciliation, reports } =
      await load();
    const start = new Date();
    await new Promise(r => setTimeout(r, 5));
    await deposits.recordDeposit(
      { accountId: member.msa, amount: '1000', method: 'cash' },
      officer
    );
    await withdrawals.recordWithdrawal(
      { accountId: member.msa, amount: '250', method: 'cash' },
      officer
    );
    // Between two accounts here: a receipt, but nothing in or out of the box.
    await transfers.recordTransfer(
      {
        sourceAccountId: member.msa,
        amount: '100',
        destination: { kind: 'account', accountId: member.shares },
      },
      officer
    );
    const period = await reconciliation.reconcileReceipts(
      start,
      new Date(Date.now() + 60_000)
    );
    expect(period.issuedCount).toBe(3);
    expect(period.issuedTotal).toBe('750.00');

    const report = reports.REPORTS.find(r => r.code === 'receipts')!;
    const result = await report.run({
      from: start.toISOString().slice(0, 10),
      to: start.toISOString().slice(0, 10),
    });
    const kinds = result.rows.map(r => r.Kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['Deposit', 'Withdrawal', 'Transfer'])
    );
    expect(result.columns.map(c => c.key)).toEqual(
      expect.arrayContaining([
        'Kind',
        'Reference',
        'Method',
        'Amount',
        'Reason',
      ])
    );
    expect(result.summary).toMatch(/issued — Cash/);
  });
});
