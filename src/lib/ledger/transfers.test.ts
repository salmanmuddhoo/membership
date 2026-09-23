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

// A transfer is two legs under one id (S-1504): the checks on each side,
// posting both or neither, the matrix reading it as its own kind or as a
// withdrawal, a payee with no account, and a correction. Against real
// migrations, like every ledger suite.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `transfers_test_${Date.now()}`;
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

async function configure(sql: string) {
  await run(
    appUrl,
    `begin; set local albarakah.actor_description = 'transfers.test'; ${sql}; commit;`
  );
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
    transfers: await import('./transfers'),
    review: await import('./review'),
    ledger: await import('./ledger'),
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
let amina: { id: string; shares: string; msa: string };
let bilal: { id: string; shares: string; msa: string };
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
  const make = (email: string, roles: string[], permissions: string[]) =>
    principalFor(byEmail.get(email), email, roles, permissions);
  clerk = make(
    'clerk@albarakah.mu',
    ['clerk'],
    ['transaction.capture', 'transaction.view']
  );
  officer = make(
    'officer@albarakah.mu',
    ['account_officer'],
    [
      'transaction.capture',
      'transaction.post',
      'transaction.disburse',
      'transaction.view',
    ]
  );
  treasurer = make(
    'treasurer@albarakah.mu',
    ['treasurer'],
    ['transaction.post', 'transaction.disburse', 'transaction.view']
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
  const newMember = async (name: string) => {
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
      [application.rows[0].id, JSON.stringify({ name, surname: 'Test' })]
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
    return {
      id: member.rows[0].id,
      shares: await open('shares'),
      msa: await open('msa'),
    };
  };
  amina = await newMember('Amina');
  bilal = await newMember('Bilal');

  await configure(
    `insert into bank_account (code, name, bank_name, account_number)
     values ('mcb', 'MCB current', 'MCB', '000123456789')`
  );
  bankAccountId = (
    await run(appUrl, `select id from bank_account where code = 'mcb'`)
  ).rows[0].id;

  const { deposits } = await load();
  await deposits.recordDeposit(
    { accountId: amina.shares, amount: '8000', method: 'cash' },
    officer
  );
  for (const n of [1, 2, 3]) {
    await deposits.recordDeposit(
      {
        accountId: amina.msa,
        amount: '90000',
        method: 'bank_transfer',
        methodReference: `D${n}`,
        bankAccountId,
      },
      officer
    );
  }
  await deposits.recordDeposit(
    { accountId: bilal.msa, amount: '1000', method: 'cash' },
    officer
  );
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

describe('a transfer between accounts on the system', () => {
  it('posts both legs at once below the band, under one reference', async () => {
    const { transfers, ledger } = await load();
    const transfer = await transfers.recordTransfer(
      {
        sourceAccountId: amina.msa,
        amount: '2500',
        destination: { kind: 'account', accountId: amina.shares },
        reason: 'Top up shares',
      },
      officer
    );
    expect(transfer.reference).toMatch(/^TR-\d{6}$/);
    expect(transfer.status).toBe('posted');
    expect(transfer.debitLeg).toMatchObject({
      kind: 'transfer_leg',
      legDirection: 'debit',
      status: 'posted',
      accountId: amina.msa,
      counterpartAccountId: amina.shares,
      method: 'internal_transfer',
      transferReference: transfer.reference,
    });
    expect(transfer.debitLeg.receiptNo).toMatch(/^RCT-\d{6}$/);
    expect(transfer.creditLeg).toMatchObject({
      legDirection: 'credit',
      status: 'posted',
      accountId: amina.shares,
      counterpartAccountId: amina.msa,
    });
    expect(transfer.creditLeg?.receiptNo).toBeNull();
    expect(await balance(amina.msa)).toBe('267500.00');
    expect(await balance(amina.shares)).toBe('10500.00');
    // Both legs on the trail as one posting, and the statement names the other side.
    const entries = await ledger.accountEntries(amina.shares, { limit: 1 });
    expect(entries[0].description).toMatch(/^Transfer from AB\d+ · Multiplier/);
    const out = await ledger.accountEntries(amina.msa, { limit: 1 });
    expect(out[0].description).toMatch(/^Transfer to AB\d+ · Shares/);
  });

  it('checks the source as a withdrawal and the destination as a deposit, and refuses the same account', async () => {
    const { transfers } = await load();
    const attempt = (
      input: Parameters<typeof transfers.recordTransfer>[0],
      who = officer
    ) => transfers.recordTransfer(input, who);
    await expect(
      attempt({
        sourceAccountId: amina.msa,
        amount: '10',
        destination: { kind: 'account', accountId: amina.msa },
      })
    ).rejects.toThrowError(/different account/);
    // Shares keeps its floor.
    await expect(
      attempt({
        sourceAccountId: amina.shares,
        amount: '6000',
        destination: { kind: 'account', accountId: amina.msa },
      })
    ).rejects.toThrowError(
      /must keep at least MUR 5,000.00; only MUR 5,500.00 can be transferred/
    );
    await expect(
      attempt({
        sourceAccountId: amina.msa,
        amount: '999999',
        destination: { kind: 'account', accountId: amina.shares },
      })
    ).rejects.toThrowError(/is available/);
    await run(appUrl, `update account set status = 'frozen' where id = $1`, [
      bilal.msa,
    ]);
    try {
      await expect(
        attempt({
          sourceAccountId: amina.msa,
          amount: '10',
          destination: { kind: 'account', accountId: bilal.msa },
        })
      ).rejects.toThrowError(/destination account is frozen/);
    } finally {
      await run(appUrl, `update account set status = 'active' where id = $1`, [
        bilal.msa,
      ]);
    }
    await configure(
      `update account_type set allows_transfer = false where code = 'shares'`
    );
    try {
      await expect(
        attempt({
          sourceAccountId: amina.shares,
          amount: '10',
          destination: { kind: 'account', accountId: amina.msa },
        })
      ).rejects.toThrowError(/does not allow transfers/);
    } finally {
      await configure(
        `update account_type set allows_transfer = true where code = 'shares'`
      );
    }
    await expect(
      attempt(
        {
          sourceAccountId: amina.msa,
          amount: '10',
          destination: { kind: 'account', accountId: amina.shares },
        },
        clerk
      )
    ).rejects.toThrowError(/record a transfer but not post it/);
  });

  it("reads another person's account as a withdrawal for the matrix, and posts both legs once approved", async () => {
    const { transfers, review, ledger } = await load();
    const before = {
      amina: await balance(amina.msa),
      bilal: await balance(bilal.msa),
    };
    const transfer = await transfers.recordTransfer(
      {
        sourceAccountId: amina.msa,
        amount: '120000',
        destination: { kind: 'account', accountId: bilal.msa },
      },
      clerk
    );
    expect(transfer.status).toBe('submitted');
    expect(transfer.debitLeg.status).toBe('submitted');
    expect(transfer.debitLeg.workflowName).toBe('Withdrawal approval');
    expect(transfer.creditLeg?.status).toBe('submitted');
    expect(transfer.creditLeg?.workflowDefinitionId).toBeNull();
    // On its way out of Amina's, and only the debit leg in a queue.
    expect((await ledger.availableBalance(amina.msa)).pendingDebits).toBe(
      '120000.00'
    );
    const queue = await review.pendingTransactions(secretary);
    expect(queue.map(t => t.id)).toContain(transfer.debitLeg.id);
    expect(queue.map(t => t.id)).not.toContain(transfer.creditLeg!.id);

    await review.reviewTransaction(
      transfer.debitLeg.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    await review.reviewTransaction(
      transfer.debitLeg.id,
      { outcome: 'forward', comment: 'OK' },
      president
    );
    expect((await transfers.loadTransfer(transfer.id))?.status).toBe(
      'approved'
    );
    expect(await balance(bilal.msa)).toBe(before.bilal);
    // Between two accounts here nothing is paid out, so posting asks for no method.
    const posted = await review.postApprovedTransaction(
      transfer.debitLeg.id,
      treasurer
    );
    expect(posted.status).toBe('posted');
    const done = (await transfers.loadTransfer(transfer.id))!;
    expect(done.status).toBe('posted');
    expect(done.creditLeg?.status).toBe('posted');
    expect(Number(before.amina) - Number(await balance(amina.msa))).toBe(
      120000
    );
    expect(Number(await balance(bilal.msa)) - Number(before.bilal)).toBe(
      120000
    );
    // Posting the credit leg on its own is refused.
    await expect(
      run(ownerUrl, `select post_transaction($1, $2, 'test')`, [
        done.creditLeg!.id,
        treasurer.userId,
      ])
    ).rejects.toThrowError(/posted, and only a submitted or approved/);
  });

  it('rejects both legs together, releasing what was on its way out', async () => {
    const { transfers, review, ledger } = await load();
    const transfer = await transfers.recordTransfer(
      {
        sourceAccountId: amina.msa,
        amount: '101000',
        destination: { kind: 'account', accountId: bilal.msa },
      },
      clerk
    );
    await review.reviewTransaction(
      transfer.debitLeg.id,
      { outcome: 'reject', comment: 'No' },
      secretary
    );
    const ended = (await transfers.loadTransfer(transfer.id))!;
    expect(ended.status).toBe('rejected');
    expect(ended.debitLeg.status).toBe('rejected');
    expect(ended.creditLeg?.status).toBe('rejected');
    expect((await ledger.availableBalance(amina.msa)).pendingDebits).toBe(
      '0.00'
    );
  });
});

describe('a transfer to a payee with no account here', () => {
  it('has one leg, names the payee, and is paid out at disbursement', async () => {
    const { transfers, review } = await load();
    const before = await balance(amina.msa);
    const transfer = await transfers.recordTransfer(
      {
        sourceAccountId: amina.msa,
        amount: '100500',
        destination: {
          kind: 'payee',
          payeeName: 'Al Noor School',
          method: 'cheque',
        },
        reason: 'Fees',
      },
      officer
    );
    expect(transfer.status).toBe('submitted');
    expect(transfer.creditLeg).toBeNull();
    expect(transfer.debitLeg.payeeName).toBe('Al Noor School');
    expect(transfer.debitLeg.workflowName).toBe('Withdrawal approval');
    await review.reviewTransaction(
      transfer.debitLeg.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    await review.reviewTransaction(
      transfer.debitLeg.id,
      { outcome: 'forward', comment: '' },
      president
    );
    await expect(
      review.postApprovedTransaction(transfer.debitLeg.id, treasurer)
    ).rejects.toThrowError(/how it was paid out/);
    await expect(
      review.postApprovedTransaction(transfer.debitLeg.id, treasurer, {
        method: 'cheque',
        bankAccountId,
      })
    ).rejects.toThrowError(/Enter the cheque reference/);
    const posted = await review.postApprovedTransaction(
      transfer.debitLeg.id,
      treasurer,
      {
        method: 'cheque',
        methodReference: 'CHQ 4411',
        bankAccountId,
      }
    );
    expect(posted.status).toBe('posted');
    expect(posted.methodReference).toBe('CHQ 4411');
    expect(posted.receiptNo).toMatch(/^RCT-\d{6}$/);
    expect(Number(before) - Number(await balance(amina.msa))).toBe(100500);
    expect((await transfers.loadTransfer(transfer.id))?.status).toBe('posted');
  });

  it('demands the reference now when it posts at once, and the payee always', async () => {
    const { transfers } = await load();
    await expect(
      transfers.recordTransfer(
        {
          sourceAccountId: amina.msa,
          amount: '300',
          destination: { kind: 'payee', payeeName: '  ', method: 'cash' },
        },
        officer
      )
    ).rejects.toThrowError(/who the money goes to/);
    await expect(
      transfers.recordTransfer(
        {
          sourceAccountId: amina.msa,
          amount: '300',
          destination: {
            kind: 'payee',
            payeeName: 'Someone',
            method: 'cheque',
            bankAccountId,
          },
        },
        officer
      )
    ).rejects.toThrowError(/Enter the cheque reference/);
    const small = await transfers.recordTransfer(
      {
        sourceAccountId: amina.msa,
        amount: '300',
        destination: { kind: 'payee', payeeName: 'Someone', method: 'cash' },
      },
      officer
    );
    expect(small.status).toBe('posted');
    expect(small.creditLeg).toBeNull();
  });
});

describe('correcting a returned transfer', () => {
  it('takes the new amount on both legs and re-enters where it was returned', async () => {
    const { transfers, review, deposits } = await load();
    for (const n of [1, 2]) {
      await deposits.recordDeposit(
        {
          accountId: amina.msa,
          amount: '90000',
          method: 'bank_transfer',
          methodReference: `E${n}`,
          bankAccountId,
        },
        officer
      );
    }
    const transfer = await transfers.recordTransfer(
      {
        sourceAccountId: amina.msa,
        amount: '101500',
        destination: { kind: 'account', accountId: bilal.msa },
      },
      clerk
    );
    await review.reviewTransaction(
      transfer.debitLeg.id,
      { outcome: 'return', comment: 'Should be 102,000' },
      secretary
    );
    expect((await transfers.loadTransfer(transfer.id))?.status).toBe(
      'returned'
    );
    await expect(
      transfers.resubmitTransfer(
        transfer.debitLeg.id,
        { amount: '102000' },
        officer
      )
    ).rejects.toThrowError(/Only the officer who recorded/);
    const again = await transfers.resubmitTransfer(
      transfer.debitLeg.id,
      { amount: '102000', reason: 'Corrected' },
      clerk
    );
    expect(again.status).toBe('submitted');
    expect(again.debitLeg.amount).toBe('102000.00');
    expect(again.creditLeg?.amount).toBe('102000.00');
    expect(again.debitLeg.currentStepCode).toBe('secretary_review');
    expect(again.reason).toBe('Corrected');
  });

  it('answers a repeated key with the same transfer', async () => {
    const { transfers } = await load();
    const key = `tkey-${Date.now()}`;
    const first = await transfers.recordTransfer(
      {
        sourceAccountId: amina.msa,
        amount: '50',
        destination: { kind: 'account', accountId: amina.shares },
        idempotencyKey: key,
      },
      officer
    );
    const again = await transfers.recordTransfer(
      {
        sourceAccountId: amina.msa,
        amount: '50.00',
        destination: { kind: 'account', accountId: amina.shares },
        idempotencyKey: key,
      },
      officer
    );
    expect(again.id).toBe(first.id);
    await expect(
      transfers.recordTransfer(
        {
          sourceAccountId: amina.msa,
          amount: '51',
          destination: { kind: 'account', accountId: amina.shares },
          idempotencyKey: key,
        },
        officer
      )
    ).rejects.toMatchObject({ reason: 'conflict' });
  });
});
