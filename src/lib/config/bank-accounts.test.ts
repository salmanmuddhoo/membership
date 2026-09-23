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

// The Society's bank accounts (S-1901): configuration with its own two
// permissions, the number masked for one and whole for the other, and a
// balance derived from the posted transactions that name the account.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `bank_accounts_test_${Date.now()}`;
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
    `begin; set local albarakah.actor_description = 'bank-accounts.test'; ${sql}; commit;`
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
    config: await import('./reference'),
    bank: await import('../ledger/bank-accounts'),
    deposits: await import('../ledger/deposits'),
    withdrawals: await import('../ledger/withdrawals'),
    transfers: await import('../ledger/transfers'),
    review: await import('../ledger/review'),
    reversals: await import('../ledger/reversals'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let actor: { userId: string; email: string };
let officer: Principal;
let secretary: Principal;
let president: Principal;
let treasurer: Principal;
let msa: string;

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

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('admin@albarakah.mu', 'Administrator'),
            ('officer@albarakah.mu', 'Officer'),
            ('secretary@albarakah.mu', 'Secretary'),
            ('president@albarakah.mu', 'President'),
            ('treasurer@albarakah.mu', 'Treasurer')
     returning id, email`
  );
  const byEmail = new Map(users.rows.map(r => [r.email, r.id]));
  actor = {
    userId: byEmail.get('admin@albarakah.mu'),
    email: 'admin@albarakah.mu',
  };
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
  await configure(
    `update account_type set maximum_transaction_amount = null where code = 'msa'`
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

const mcb = {
  code: 'mcb_current',
  name: 'MCB current account',
  bankName: 'MCB',
  accountNumber: '000123456789',
  openingBalance: '250000',
  openingDate: '2026-01-01',
  isActive: true,
};

describe('the Society’s bank accounts are configuration (S-1901)', () => {
  it('adds one, reads it whole or masked, and refuses what is not an account', async () => {
    const { config } = await load();
    const id = await config.createBankAccount(mcb, actor);
    const [whole] = await config.listBankAccounts();
    expect(whole).toMatchObject({
      id,
      code: 'mcb_current',
      name: 'MCB current account',
      bankName: 'MCB',
      accountNumber: '000123456789',
      currency: 'MUR',
      openingBalance: '250000.00',
      openingDate: '2026-01-01',
      isActive: true,
    });
    const [masked] = await config.listBankAccountsMasked();
    expect(masked.accountNumber).toBe('••••••••6789');
    expect(config.maskAccountNumber('12')).toBe('••••');
    expect(await config.bankAccountById(id)).toMatchObject({ id });

    await expect(
      config.createBankAccount({ ...mcb, code: 'MCB current' }, actor)
    ).rejects.toThrowError(/code must start with a letter/);
    await expect(
      config.createBankAccount({ ...mcb, code: 'mcb_current' }, actor)
    ).rejects.toThrowError(/already exists/);
    await expect(
      config.createBankAccount(
        { ...mcb, code: 'sbm', accountNumber: '12' },
        actor
      )
    ).rejects.toThrowError(/account number/);
    await expect(
      config.createBankAccount({ ...mcb, code: 'sbm', bankName: ' ' }, actor)
    ).rejects.toThrowError(/bank is required/);
    await expect(
      config.createBankAccount(
        { ...mcb, code: 'sbm', openingBalance: 'lots' },
        actor
      )
    ).rejects.toThrowError(/not an amount/);
    await expect(
      config.createBankAccount(
        { ...mcb, code: 'sbm', currency: 'rupees' },
        actor
      )
    ).rejects.toThrowError(/three-letter code/);
  });

  it('changes one, on the audited trail every configuration table has', async () => {
    const { config } = await load();
    const [account] = await config.listBankAccounts();
    await config.updateBankAccount(
      account.id,
      { ...mcb, name: 'MCB main account', openingBalance: '250,000.00' },
      actor
    );
    const [after] = await (await load()).config.listBankAccounts();
    expect(after.name).toBe('MCB main account');
    expect(after.openingBalance).toBe('250000.00');
    const audited = await run(
      appUrl,
      `select actor_user_id, previous_value->>'name' as before, new_value->>'name' as after
         from audit_event
        where entity_type = 'bank_account' and action = 'config.bank_account.update'
        order by occurred_at desc limit 1`
    );
    expect(audited.rows[0]).toEqual({
      actor_user_id: actor.userId,
      before: 'MCB current account',
      after: 'MCB main account',
    });
    await expect(
      config.updateBankAccount(
        '00000000-0000-0000-0000-000000000000',
        mcb,
        actor
      )
    ).rejects.toThrowError(/no longer exists/);
  });

  it('derives each balance from the posted transactions that name it', async () => {
    const { config, bank, deposits, withdrawals, transfers, review } =
      await load();
    const [account] = await config.listBankAccounts();
    const sbm = await config.createBankAccount(
      {
        ...mcb,
        code: 'sbm_savings',
        name: 'SBM savings',
        bankName: 'SBM',
        accountNumber: 'SBM-9988',
        openingBalance: '0',
        isActive: false,
      },
      actor
    );
    // Nothing posted yet: the opening balance, and no movements.
    expect(await bank.bankAccountBalances()).toMatchObject([
      {
        id: account.id,
        balance: '250000.00',
        movements: 0,
        lastPostedAt: null,
      },
      { id: sbm, balance: '0.00', movements: 0 },
    ]);

    // Money in by bank transfer, naming the account — twice, each under
    // the matrix band so it posts at once.
    for (const reference of ['IN-1', 'IN-2']) {
      await deposits.recordDeposit(
        {
          accountId: msa,
          amount: '80000',
          method: 'bank_transfer',
          methodReference: reference,
          bankAccountId: account.id,
        },
        officer
      );
    }
    // Money out by cheque, and a cash withdrawal that names nothing.
    const cheque = await withdrawals.recordWithdrawal(
      {
        accountId: msa,
        amount: '20000',
        method: 'cheque',
        methodReference: 'CHQ 1',
        bankAccountId: account.id,
      },
      officer
    );
    expect(cheque.bankAccountId).toBe(account.id);
    expect(cheque.bankAccountName).toBe('MCB main account');
    await withdrawals.recordWithdrawal(
      { accountId: msa, amount: '1000', method: 'cash' },
      officer
    );
    // A transfer paid out to a payee names it; one between two accounts
    // here could not, and moves nothing at the bank.
    await transfers.recordTransfer(
      {
        sourceAccountId: msa,
        amount: '5000',
        destination: {
          kind: 'payee',
          payeeName: 'A supplier',
          method: 'bank_transfer',
          methodReference: 'OUT-1',
          bankAccountId: account.id,
        },
      },
      officer
    );
    // A withdrawal through the chain names the account at disbursement.
    const large = await withdrawals.recordWithdrawal(
      { accountId: msa, amount: '110000', method: 'bank_transfer' },
      officer
    );
    expect(large.status).toBe('submitted');
    await review.reviewTransaction(
      large.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    await review.reviewTransaction(
      large.id,
      { outcome: 'forward', comment: '' },
      president
    );
    const posted = await review.postApprovedTransaction(large.id, treasurer, {
      method: 'bank_transfer',
      methodReference: 'OUT-2',
      bankAccountId: account.id,
    });
    expect(posted.bankAccountName).toBe('MCB main account');

    // 250,000 + 160,000 − 20,000 − 5,000 − 110,000.
    const [balance] = await bank.bankAccountBalances();
    expect(balance).toMatchObject({
      id: account.id,
      balance: '275000.00',
      movements: 5,
    });
    expect(balance.lastPostedAt).toBeInstanceOf(Date);

    // Only one of the Society's active accounts may be named.
    await expect(
      deposits.recordDeposit(
        {
          accountId: msa,
          amount: '10',
          method: 'bank_transfer',
          methodReference: 'X',
          bankAccountId: sbm,
        },
        officer
      )
    ).rejects.toThrowError(/Choose one of the Society/);
    await expect(
      review.postApprovedTransaction(large.id, treasurer, {
        method: 'cash',
        bankAccountId: '00000000-0000-0000-0000-000000000000',
      })
    ).rejects.toThrowError(/only an approved transaction posts/);
  });
});

describe('money through a bank names its account and reference (S-1902)', () => {
  it('refuses a bank-touching deposit, payout, transfer or disbursement without both', async () => {
    const { config, deposits, withdrawals, transfers, review } = await load();
    const [account] = await config.listBankAccounts();
    await expect(
      deposits.recordDeposit(
        {
          accountId: msa,
          amount: '100',
          method: 'bank_transfer',
          methodReference: 'NO-ACCOUNT',
        },
        officer
      )
    ).rejects.toThrowError(/Choose the Society's bank account/);
    await expect(
      deposits.recordDeposit(
        {
          accountId: msa,
          amount: '100',
          method: 'bank_transfer',
          bankAccountId: account.id,
        },
        officer
      )
    ).rejects.toThrowError(/bank transfer reference/);
    // Cash needs neither.
    const cash = await deposits.recordDeposit(
      { accountId: msa, amount: '100', method: 'cash' },
      officer
    );
    expect(cash.bankAccountId).toBeNull();

    await expect(
      withdrawals.recordWithdrawal(
        {
          accountId: msa,
          amount: '50',
          method: 'cheque',
          methodReference: 'CHQ 9',
        },
        officer
      )
    ).rejects.toThrowError(/Choose the Society's bank account/);
    await expect(
      transfers.recordTransfer(
        {
          sourceAccountId: msa,
          amount: '50',
          destination: {
            kind: 'payee',
            payeeName: 'Someone',
            method: 'bank_transfer',
            methodReference: 'OUT-9',
          },
        },
        officer
      )
    ).rejects.toThrowError(/Choose the Society's bank account/);

    // A chained withdrawal may leave it until the payout — and then must say.
    for (const reference of ['IN-3', 'IN-4']) {
      await deposits.recordDeposit(
        {
          accountId: msa,
          amount: '80000',
          method: 'bank_transfer',
          methodReference: reference,
          bankAccountId: account.id,
        },
        officer
      );
    }
    const large = await withdrawals.recordWithdrawal(
      { accountId: msa, amount: '105000', method: 'bank_transfer' },
      officer
    );
    expect(large.bankAccountId).toBeNull();
    await review.reviewTransaction(
      large.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    await review.reviewTransaction(
      large.id,
      { outcome: 'forward', comment: '' },
      president
    );
    await expect(
      review.postApprovedTransaction(large.id, treasurer, {
        method: 'bank_transfer',
        methodReference: 'OUT-10',
      })
    ).rejects.toThrowError(/Choose the Society's bank account/);
    const posted = await review.postApprovedTransaction(large.id, treasurer, {
      method: 'bank_transfer',
      methodReference: 'OUT-10',
      bankAccountId: account.id,
    });
    expect(posted.bankAccountId).toBe(account.id);
  });

  it('carries both in the posting, guards them in the ledger itself, and hands them to a reversal', async () => {
    const { config, deposits, reversals } = await load();
    const [account] = await config.listBankAccounts();
    const deposit = await deposits.recordDeposit(
      {
        accountId: msa,
        amount: '700',
        method: 'cheque',
        methodReference: 'CHQ 700',
        bankAccountId: account.id,
      },
      officer
    );
    const event = await run(
      appUrl,
      `select payload->>'bank_account_id' as bank_account_id,
              payload->>'method_reference' as method_reference
         from financial_event
        where transaction_id = $1 and event_type = 'transaction.posted'`,
      [deposit.id]
    );
    expect(event.rows[0]).toEqual({
      bank_account_id: account.id,
      method_reference: 'CHQ 700',
    });

    // The reversal undoes it on the same bank account.
    const { reversals: made } = await reversals.reverseTransaction(
      deposit.id,
      { reason: 'Cheque bounced' },
      treasurer
    );
    expect(made[0].bankAccountId).toBe(account.id);
    expect(made[0].status).toBe('posted');

    // post_transaction refuses a bank-touching row that lost either, on
    // whatever path it took: a submitted row edited underneath the rule.
    const stripped = await run(
      appUrl,
      `insert into transaction
         (kind, member_id, account_id, amount, method, method_reference,
          status, captured_by, submitted_at)
       select 'deposit', member_id, id, 10, 'bank_transfer', 'REF', 'submitted', $2, now()
         from account where id = $1
       returning id`,
      [msa, officer.userId]
    );
    await expect(
      run(appUrl, `select post_transaction($1, $2, 'test')`, [
        stripped.rows[0].id,
        officer.userId,
      ])
    ).rejects.toThrowError(/must name the bank account and the reference/);
  });
});
