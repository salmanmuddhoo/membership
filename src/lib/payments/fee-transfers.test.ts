// A new member's fees paid by another member's transfer (migration 0126):
// at once below the Transfer band, through the chain above it, the fee
// receipt issued only when the money moves; Shares may pay but keep their
// floor; a live transfer stops a second payment, and cancelling it opens
// the step again. Against real migrations, like every ledger suite.
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
import { openEveryDrawer } from '../cash/drawers.testing';
import type { Principal } from '../access/principal';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `fee_transfers_test_${Date.now()}`;
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
    feeTransfers: await import('./fee-transfers'),
    payments: await import('./payments'),
    capture: await import('../applications/capture'),
    deposits: await import('../ledger/deposits'),
    review: await import('../ledger/review'),
    reversals: await import('../ledger/reversals'),
    transfers: await import('../ledger/transfers'),
    ledger: await import('../ledger/ledger'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let officer: Principal;
let clerk: Principal;
let treasurer: Principal;
let secretary: Principal;
let president: Principal;
let payer: { id: string; shares: string; msa: string };

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

// What an individual must pay: 1500 + 2000 + 5000.
const FULL = {
  entrance: '1500.00',
  takaful: '2000.00',
  shares: '5000.00',
} as const;
// Above the Transfer band, so the chain reviews it.
const LARGE = { ...FULL, shares: '150000.00' } as const;

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('officer@albarakah.mu', 'Officer'),
            ('clerk@albarakah.mu', 'Clerk'),
            ('treasurer@albarakah.mu', 'Treasurer'),
            ('secretary@albarakah.mu', 'Secretary'),
            ('president@albarakah.mu', 'President')
     returning id, email`
  );
  const byEmail = new Map(users.rows.map(r => [r.email, r.id]));
  await openEveryDrawer(appUrl);
  const make = (email: string, roles: string[], permissions: string[]) =>
    principalFor(byEmail.get(email), email, roles, permissions);
  officer = make(
    'officer@albarakah.mu',
    ['account_officer'],
    [
      'application.capture',
      'payment.view',
      'payment.record',
      'transaction.capture',
      'transaction.post',
      'transaction.record_transfer',
      'transaction.view',
    ]
  );
  clerk = make(
    'clerk@albarakah.mu',
    ['clerk'],
    ['transaction.capture', 'transaction.view']
  );
  treasurer = make(
    'treasurer@albarakah.mu',
    ['treasurer'],
    [
      'transaction.post',
      'transaction.record_transfer',
      'transaction.view',
      'receipt.void',
    ]
  );
  secretary = make(
    'secretary@albarakah.mu',
    ['secretary'],
    ['transaction.review', 'transaction.view']
  );
  president = make(
    'president@albarakah.mu',
    ['president'],
    ['transaction.approve', 'transaction.view']
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
     values ($1, 'applicant', 1, $2)`,
    [
      application.rows[0].id,
      JSON.stringify({ name: 'Hassan', surname: 'Test' }),
    ]
  );
  const member = await run(
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
        [member.rows[0].id, types[code], code === 'shares']
      )
    ).rows[0].id;
  payer = {
    id: member.rows[0].id,
    shares: await open('shares'),
    msa: await open('msa'),
  };

  await run(
    appUrl,
    `begin; set local albarakah.actor_description = 'fee-transfers.test';
     insert into bank_account (code, name, bank_name, account_number)
     values ('mcb', 'MCB current', 'MCB', '000123456789'); commit;`
  );
  const bankAccountId = (
    await run(appUrl, `select id from bank_account where code = 'mcb'`)
  ).rows[0].id;

  const { deposits } = await load();
  await deposits.recordDeposit(
    { accountId: payer.shares, amount: '20000', method: 'cash' },
    officer
  );
  for (const n of [1, 2, 3, 4]) {
    await deposits.recordDeposit(
      {
        accountId: payer.msa,
        amount: '90000',
        method: 'bank_transfer',
        methodReference: `D${n}`,
        bankAccountId,
      },
      officer
    );
  }
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

async function balance(accountId: string): Promise<string> {
  const result = await run(
    appUrl,
    `select balance from account_balance where account_id = $1`,
    [accountId]
  );
  return result.rows[0]?.balance ?? '0.00';
}

async function newApplication() {
  const { capture } = await load();
  return capture.startApplication('individual', officer);
}

describe('fees paid by transfer from a member', () => {
  it('pays from Shares, posted at once below the band, and issues the fee receipt', async () => {
    const application = await newApplication();
    const { feeTransfers, payments, review } = await load();

    const outcome = await feeTransfers.requestFeeTransfer(
      {
        applicationId: application.id,
        payerAccountId: payer.shares,
        amounts: FULL,
      },
      officer
    );
    expect(outcome.reference).toMatch(/^TR-\d{6}$/);
    expect(outcome.receiptNo).toMatch(/^RCT-\d{6}$/);
    expect(await balance(payer.shares)).toBe('11500.00');

    const leg = (await review.loadTransaction(outcome.transactionId))!;
    expect(leg).toMatchObject({
      kind: 'transfer_leg',
      legDirection: 'debit',
      status: 'posted',
      payeeName: null,
      counterpartAccountId: null,
      feeApplicationId: application.id,
      feeApplicationReference: application.reference,
    });
    expect(leg.receiptNo).toMatch(/^RCT-\d{6}$/);
    expect(leg.receiptNo).not.toBe(outcome.receiptNo);

    const [paid] = await payments.paymentsForApplication(application.id);
    expect(paid).toMatchObject({
      kind: 'payment',
      receiptNo: outcome.receiptNo,
      method: 'member_transfer',
      methodName: 'Transfer from a member',
      totalAmount: '8500.00',
    });
    expect(paid.methodReference).toMatch(/^TR-\d{6} · AB\d+$/);
    expect(paid.lines.map(l => [l.componentCode, l.amount])).toEqual([
      ['entrance', '1500.00'],
      ['takaful', '2000.00'],
      ['shares', '5000.00'],
      ['msa_deposit', '0.00'],
    ]);
    expect(await feeTransfers.pendingFeeTransfer(application.id)).toBeNull();

    // Paid is paid: neither a second transfer nor cash.
    await expect(
      feeTransfers.requestFeeTransfer(
        {
          applicationId: application.id,
          payerAccountId: payer.msa,
          amounts: FULL,
        },
        officer
      )
    ).rejects.toThrowError(/already receipted/);
  });

  it('lets Shares pay, but not below their floor', async () => {
    const application = await newApplication();
    const { feeTransfers } = await load();
    await expect(
      feeTransfers.requestFeeTransfer(
        {
          applicationId: application.id,
          payerAccountId: payer.shares,
          amounts: FULL,
        },
        officer
      )
    ).rejects.toThrowError(/must keep at least MUR 5,000.00/);
    expect(await feeTransfers.pendingFeeTransfer(application.id)).toBeNull();
  });

  it('goes through the transfer chain above the band, and the fees count only once it posts', async () => {
    const application = await newApplication();
    const { feeTransfers, payments, review, reversals, ledger } = await load();
    const before = await balance(payer.msa);

    const outcome = await feeTransfers.requestFeeTransfer(
      {
        applicationId: application.id,
        payerAccountId: payer.msa,
        amounts: LARGE,
      },
      officer
    );
    expect(outcome.receiptNo).toBeNull();
    const pending = (await feeTransfers.pendingFeeTransfer(application.id))!;
    expect(pending).toMatchObject({
      transactionId: outcome.transactionId,
      status: 'submitted',
      amount: '153500.00',
    });
    expect((await ledger.availableBalance(payer.msa)).pendingDebits).toBe(
      '153500.00'
    );
    expect(await payments.paymentsForApplication(application.id)).toEqual([]);
    await expect(
      payments.recordPayment(
        { applicationId: application.id, method: 'cash', amounts: FULL },
        officer
      )
    ).rejects.toThrowError(/is paying these fees. Cancel it first/);

    await review.reviewTransaction(
      outcome.transactionId,
      { outcome: 'forward', comment: '' },
      secretary
    );
    await review.reviewTransaction(
      outcome.transactionId,
      { outcome: 'forward', comment: 'Paid by her uncle.' },
      president
    );
    expect(await payments.paymentsForApplication(application.id)).toEqual([]);

    // Nothing is paid out of the Society, so it is recorded, not disbursed.
    const posted = await review.postApprovedTransaction(
      outcome.transactionId,
      treasurer
    );
    expect(posted.status).toBe('posted');
    expect(Number(before) - Number(await balance(payer.msa))).toBe(153500);
    const [paid] = await payments.paymentsForApplication(application.id);
    expect(paid.method).toBe('member_transfer');
    expect(paid.totalAmount).toBe('153500.00');
    // Taken by the officer who started it, not whoever recorded the transfer.
    expect(paid.recordedByEmail).toBe(officer.email);
    expect(await feeTransfers.pendingFeeTransfer(application.id)).toBeNull();

    // Undone only once the fee receipt it became is voided.
    await expect(
      reversals.reverseTransaction(
        outcome.transactionId,
        { reason: 'Wrong payer' },
        treasurer
      )
    ).rejects.toThrowError(
      new RegExp(
        `paid the fees on receipt ${paid.receiptNo}. Void that receipt first`
      )
    );
  });

  it('is cancelled from the application, and the step is open again', async () => {
    const application = await newApplication();
    const { feeTransfers, payments, review, ledger, capture } = await load();
    const outcome = await feeTransfers.requestFeeTransfer(
      {
        applicationId: application.id,
        payerAccountId: payer.msa,
        amounts: LARGE,
      },
      officer
    );
    await review.reviewTransaction(
      outcome.transactionId,
      { outcome: 'return', comment: 'Ask the payer to sign.' },
      secretary
    );
    expect(
      (await feeTransfers.pendingFeeTransfer(application.id))?.status
    ).toBe('returned');

    const cancelled = await feeTransfers.cancelFeeTransfer(
      application.id,
      officer
    );
    expect(cancelled).toBe(outcome.reference);
    expect((await review.loadTransaction(outcome.transactionId))?.status).toBe(
      'cancelled'
    );
    expect(await feeTransfers.pendingFeeTransfer(application.id)).toBeNull();
    expect((await ledger.availableBalance(payer.msa)).pendingDebits).toBe(
      '0.00'
    );
    await expect(
      feeTransfers.cancelFeeTransfer(application.id, officer)
    ).rejects.toThrowError(/No transfer is paying these fees/);

    // The application carries the transfer now, so it is not deleted.
    await expect(
      capture.deleteDraftApplication(application.id, officer)
    ).rejects.toThrowError(/was started for this application's fees/);

    const paid = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      officer
    );
    expect(paid.method).toBe('cash');
  });

  it('is never edited once returned: cancelled and started again', async () => {
    const application = await newApplication();
    const { feeTransfers, review, transfers } = await load();
    const outcome = await feeTransfers.requestFeeTransfer(
      {
        applicationId: application.id,
        payerAccountId: payer.msa,
        amounts: LARGE,
      },
      officer
    );
    await review.reviewTransaction(
      outcome.transactionId,
      { outcome: 'return', comment: 'Check the amount.' },
      secretary
    );
    await expect(
      transfers.resubmitTransfer(
        outcome.transactionId,
        { amount: '100' },
        officer
      )
    ).rejects.toThrowError(/Cancel it on the application and start again/);
    await feeTransfers.cancelFeeTransfer(application.id, officer);
  });

  it('does not post once the application has been decided', async () => {
    const application = await newApplication();
    const { feeTransfers, payments, review } = await load();
    const before = await balance(payer.msa);
    const outcome = await feeTransfers.requestFeeTransfer(
      {
        applicationId: application.id,
        payerAccountId: payer.msa,
        amounts: LARGE,
      },
      officer
    );
    await review.reviewTransaction(
      outcome.transactionId,
      { outcome: 'forward', comment: '' },
      secretary
    );
    await review.reviewTransaction(
      outcome.transactionId,
      { outcome: 'forward', comment: 'OK' },
      president
    );
    await run(
      ownerUrl,
      `update membership_application set status = 'rejected' where id = $1`,
      [application.id]
    );
    await expect(
      review.postApprovedTransaction(outcome.transactionId, treasurer)
    ).rejects.toThrowError(/was rejected. Cancel the transfer/);
    expect(await balance(payer.msa)).toBe(before);
    expect((await review.loadTransaction(outcome.transactionId))?.status).toBe(
      'approved'
    );
    expect(await payments.paymentsForApplication(application.id)).toEqual([]);

    await feeTransfers.cancelFeeTransfer(application.id, officer);
    expect((await review.loadTransaction(outcome.transactionId))?.status).toBe(
      'cancelled'
    );
  });

  it('needs both payment.record and transaction.capture, and a member to pay', async () => {
    const application = await newApplication();
    const { feeTransfers } = await load();
    await expect(
      feeTransfers.requestFeeTransfer(
        {
          applicationId: application.id,
          payerAccountId: payer.msa,
          amounts: FULL,
        },
        clerk
      )
    ).rejects.toThrowError(/do not have permission/);
    await expect(
      feeTransfers.requestFeeTransfer(
        { applicationId: application.id, payerAccountId: '', amounts: FULL },
        officer
      )
    ).rejects.toThrowError(/Choose the account the fees are paid from/);
  });
});
