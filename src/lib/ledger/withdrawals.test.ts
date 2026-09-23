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

// Recording a withdrawal (S-1501), the available balance it reads (S-1502)
// and the disbursement of an approved one (S-1503): the checks in order,
// the floor, the matrix, the receipt, and who may pay it out. Against real
// migrations, like every ledger suite.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `withdrawals_test_${Date.now()}`;
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
    `begin; set local albarakah.actor_description = 'withdrawals.test'; ${sql}; commit;`
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
    withdrawals: await import('./withdrawals'),
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
let memberId: string;
let shares: string;
let msa: string;
let hsa: string;
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

  // An HSA that takes deposits but allows no withdrawals, and an MSA cap.
  await configure(
    `insert into account_type (code, name, category, number_prefix, sort_order, allows_withdrawal)
     values ('hsa', 'Hajj Savings', 'savings', 'HSA', 5, false)`
  );
  await configure(
    `update account_type set maximum_transaction_amount = 20000 where code = 'msa'`
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
  memberId = (
    await run(
      appUrl,
      `insert into member (application_id, membership_type_id)
       values ($1, $2) returning id`,
      [application.rows[0].id, membershipTypeId]
    )
  ).rows[0].id;
  const types = Object.fromEntries(
    (await run(appUrl, `select code, id from account_type`)).rows.map(r => [
      r.code,
      r.id,
    ])
  );
  const open = async (code: string, accountNo: string | null = null) =>
    (
      await run(
        appUrl,
        `insert into account (member_id, account_type_id, is_membership_default, status, account_no)
         values ($1, $2, $3, 'active', $4) returning id`,
        [memberId, types[code], accountNo === null, accountNo]
      )
    ).rows[0].id;
  shares = await open('shares');
  msa = await open('msa');
  hsa = await open('hsa', 'HSA0001');

  // Money to draw on: Shares 8,000 (floor 5,000), MSA 30,000, HSA 1,000.
  const { deposits } = await load();
  await deposits.recordDeposit(
    { accountId: shares, amount: '8000', method: 'cash' },
    officer
  );
  await deposits.recordDeposit(
    { accountId: msa, amount: '15000', method: 'cash' },
    officer
  );
  await deposits.recordDeposit(
    { accountId: msa, amount: '15000', method: 'cash' },
    officer
  );
  await deposits.recordDeposit(
    { accountId: hsa, amount: '1000', method: 'cash' },
    officer
  );

  await configure(
    `insert into bank_account (code, name, bank_name, account_number)
     values ('mcb', 'MCB current', 'MCB', '000123456789')`
  );
  bankAccountId = (
    await run(appUrl, `select id from bank_account where code = 'mcb'`)
  ).rows[0].id;
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

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return (await run(appUrl, sql, params)).rows[0].n;
}

describe('recording a withdrawal', () => {
  it('pays out and posts a small one at once, as a debit, with a receipt', async () => {
    const { withdrawals } = await load();
    const withdrawal = await withdrawals.recordWithdrawal(
      { accountId: msa, amount: '2000', method: 'cash', reason: 'School fees' },
      officer
    );
    expect(withdrawal.kind).toBe('withdrawal');
    expect(withdrawal.status).toBe('posted');
    expect(withdrawal.receiptNo).toMatch(/^RCT-\d{6}$/);
    expect(withdrawal.balanceAfter).toBe('28000.00');
    expect(await balance(msa)).toBe('28000.00');
    const entry = await run(
      appUrl,
      `select direction, amount from account_entry where transaction_id = $1`,
      [withdrawal.id]
    );
    expect(entry.rows).toEqual([{ direction: 'debit', amount: '2000.00' }]);
  });

  it('refuses, in order and naming the rule, before anything is written', async () => {
    const { withdrawals } = await load();
    const before = await count('select count(*)::int as n from transaction');
    const receipts = await count(
      'select count(*)::int as n from receipt_number'
    );
    const attempt = (
      input: Parameters<typeof withdrawals.recordWithdrawal>[0],
      who = officer
    ) => withdrawals.recordWithdrawal(input, who);

    await expect(
      attempt({ accountId: msa, amount: '10', method: 'cash' }, secretary)
    ).rejects.toThrowError(/permission/);
    await expect(
      attempt({ accountId: msa, amount: '10', method: 'cash' }, clerk)
    ).rejects.toThrowError(/record a withdrawal but not pay it out/);
    await expect(
      attempt({ accountId: hsa, amount: '10', method: 'cash' })
    ).rejects.toThrowError(/does not allow withdrawals/);
    // More than is there.
    await expect(
      attempt({ accountId: msa, amount: '28000.01', method: 'cash' })
    ).rejects.toThrowError(/Only 28000.00 is available/);
    // The floor (decision 12): Shares keeps its 5,000.
    await expect(
      attempt({ accountId: shares, amount: '3000.01', method: 'cash' })
    ).rejects.toThrowError(
      /must keep at least 5000.00; only 3000.00 can be withdrawn/
    );
    // The type's maximum.
    await expect(
      attempt({ accountId: msa, amount: '20000.01', method: 'cash' })
    ).rejects.toThrowError(/cannot exceed 20000.00/);
    // The method's reference, because it pays out now.
    await expect(
      attempt({
        accountId: msa,
        amount: '10',
        method: 'cheque',
        bankAccountId,
      })
    ).rejects.toThrowError(/Enter the cheque reference/);
    await expect(
      attempt({ accountId: msa, amount: '10', method: 'migration' })
    ).rejects.toThrowError(/Choose how it is paid out/);
    await expect(
      attempt({ accountId: msa, amount: '0', method: 'cash' })
    ).rejects.toThrowError(/more than zero/);

    await run(appUrl, `update member set status = 'dormant' where id = $1`, [
      memberId,
    ]);
    try {
      await expect(
        attempt({ accountId: msa, amount: '10', method: 'cash' })
      ).rejects.toThrowError(/member is dormant/);
    } finally {
      await run(appUrl, `update member set status = 'active' where id = $1`, [
        memberId,
      ]);
    }
    await run(appUrl, `update account set status = 'frozen' where id = $1`, [
      msa,
    ]);
    try {
      await expect(
        attempt({ accountId: msa, amount: '10', method: 'cash' })
      ).rejects.toThrowError(/account is frozen/);
    } finally {
      await run(appUrl, `update account set status = 'active' where id = $1`, [
        msa,
      ]);
    }

    expect(await count('select count(*)::int as n from transaction')).toBe(
      before
    );
    expect(await count('select count(*)::int as n from receipt_number')).toBe(
      receipts
    );
  });

  it('answers a repeated key with the original and refuses a different request on it', async () => {
    const { withdrawals } = await load();
    const key = `wkey-${Date.now()}`;
    const first = await withdrawals.recordWithdrawal(
      { accountId: msa, amount: '100', method: 'cash', idempotencyKey: key },
      officer
    );
    const again = await withdrawals.recordWithdrawal(
      { accountId: msa, amount: '100.00', method: 'cash', idempotencyKey: key },
      officer
    );
    expect(again.id).toBe(first.id);
    await expect(
      withdrawals.recordWithdrawal(
        { accountId: msa, amount: '101', method: 'cash', idempotencyKey: key },
        officer
      )
    ).rejects.toMatchObject({ reason: 'conflict' });
  });
});

describe('available, not merely current (S-1502)', () => {
  it('counts what is on its way out, and releases it on rejection', async () => {
    const { ledger } = await load();
    // Raise the MSA cap so a large withdrawal can go to the chain.
    await configure(
      `update account_type set maximum_transaction_amount = null where code = 'msa'`
    );
    const before = await ledger.availableBalance(msa);
    expect(before.available).toBe(before.balance);
    // Deposit more so a chain-bound amount is coverable.
    const { deposits } = await load();
    await deposits.recordDeposit(
      {
        accountId: msa,
        amount: '90000',
        method: 'bank_transfer',
        methodReference: 'D1',
        bankAccountId,
      },
      officer
    );
    const figures = await (await load()).ledger.availableBalance(msa);
    const balanceCents = Math.round(Number(figures.balance) * 100);

    const large = await (
      await load()
    ).withdrawals.recordWithdrawal(
      { accountId: msa, amount: '110000', method: 'bank_transfer' },
      clerk
    );
    expect(large.status).toBe('submitted');
    expect(large.receiptNo).toBeNull();
    expect(large.currentStepCode).toBe('secretary_review');

    const during = await (await load()).ledger.availableBalance(msa);
    expect(during.balance).toBe(figures.balance);
    expect(during.pendingDebits).toBe('110000.00');
    expect(Math.round(Number(during.available) * 100)).toBe(
      balanceCents - 11000000
    );

    // A second withdrawal sees only what is left.
    await expect(
      (await load()).withdrawals.recordWithdrawal(
        { accountId: msa, amount: during.balance, method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/is already on its way out/);

    const mods = await load();
    await mods.review.reviewTransaction(
      large.id,
      { outcome: 'reject', comment: 'Not today' },
      mods.review && secretary
    );
    const after = await mods.ledger.availableBalance(msa);
    expect(after.pendingDebits).toBe('0.00');
    expect(after.available).toBe(after.balance);
  });
});

describe('disbursing an approved withdrawal (S-1503)', () => {
  it('pays out once approved, by someone who neither captured nor approved it, with the method recorded', async () => {
    const mods = await load();
    const large = await mods.withdrawals.recordWithdrawal(
      { accountId: msa, amount: '105000', method: 'cash', reason: 'Hajj' },
      officer
    );
    expect(large.status).toBe('submitted');
    await mods.review.reviewTransaction(
      large.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    await mods.review.reviewTransaction(
      large.id,
      { outcome: 'forward', comment: '' },
      president
    );
    expect((await mods.review.loadTransaction(large.id))?.status).toBe(
      'approved'
    );
    const before = await balance(msa);

    // Approval moved nothing; posting without saying how it was paid is
    // refused; a bank method needs its reference.
    expect(await balance(msa)).toBe(before);
    await expect(
      mods.review.postApprovedTransaction(large.id, treasurer)
    ).rejects.toThrowError(/how it was paid out/);
    await expect(
      mods.review.postApprovedTransaction(large.id, treasurer, {
        method: 'bank_transfer',
        bankAccountId,
      })
    ).rejects.toThrowError(/Enter the bank transfer reference/);
    // The captor may not pay it out; nor may the approver.
    await expect(
      mods.review.postApprovedTransaction(large.id, officer, { method: 'cash' })
    ).rejects.toThrowError(/may not post/);
    const presidentWhoPosts = {
      ...president,
      permissions: new Set(['transaction.post', 'transaction.disburse']),
    };
    await expect(
      mods.review.postApprovedTransaction(large.id, presidentWhoPosts, {
        method: 'cash',
      })
    ).rejects.toThrowError(/approved a transaction may not/);

    const posted = await mods.review.postApprovedTransaction(
      large.id,
      treasurer,
      {
        method: 'bank_transfer',
        methodReference: 'BT-9001',
        bankAccountId,
      }
    );
    expect(posted.status).toBe('posted');
    expect(posted.method).toBe('bank_transfer');
    expect(posted.methodReference).toBe('BT-9001');
    expect(posted.receiptNo).toMatch(/^RCT-\d{6}$/);
    expect(Number(before) - Number(await balance(msa))).toBe(105000);
    const trail = await run(
      appUrl,
      `select to_status from transaction_transition where transaction_id = $1 order by id`,
      [large.id]
    );
    expect(trail.rows.map(r => r.to_status)).toEqual([
      'submitted',
      'under_review',
      'approved',
      'posted',
    ]);
  });

  it('refuses at posting time a withdrawal the floor no longer allows', async () => {
    const mods = await load();
    // Below the matrix band, so each posts at once.
    for (const n of [1, 2]) {
      await mods.deposits.recordDeposit(
        {
          accountId: msa,
          amount: '90000',
          method: 'bank_transfer',
          methodReference: `D2-${n}`,
          bankAccountId,
        },
        officer
      );
    }
    const large = await mods.withdrawals.recordWithdrawal(
      { accountId: msa, amount: '100500', method: 'cash' },
      officer
    );
    await mods.review.reviewTransaction(
      large.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    await mods.review.reviewTransaction(
      large.id,
      { outcome: 'forward', comment: '' },
      president
    );
    // Between the decision and the pay-out the MSA's floor is raised past
    // what would be left: the engine, not the screen, is what refuses.
    const receipts = await count(
      'select count(*)::int as n from receipt_number'
    );
    await configure(
      `update account_type set minimum_balance = 150000 where code = 'msa'`
    );
    try {
      await expect(
        mods.review.postApprovedTransaction(large.id, treasurer, {
          method: 'cash',
        })
      ).rejects.toThrowError(/below its floor/);
      expect((await mods.review.loadTransaction(large.id))?.status).toBe(
        'approved'
      );
      // The receipt number it took is abandoned, not left dangling.
      const abandoned = await run(
        appUrl,
        `select state from receipt_number order by allocated_at desc limit 1`
      );
      expect(abandoned.rows[0].state).toBe('abandoned');
      expect(await count('select count(*)::int as n from receipt_number')).toBe(
        receipts + 1
      );
    } finally {
      await configure(
        `update account_type set minimum_balance = 0 where code = 'msa'`
      );
    }
    const posted = await mods.review.postApprovedTransaction(
      large.id,
      treasurer,
      { method: 'cash' }
    );
    expect(posted.status).toBe('posted');
  });

  it('lets the captor correct a returned withdrawal and re-checks it', async () => {
    const mods = await load();
    for (const n of [1, 2, 3, 4]) {
      await mods.deposits.recordDeposit(
        {
          accountId: msa,
          amount: '90000',
          method: 'bank_transfer',
          methodReference: `D3-${n}`,
          bankAccountId,
        },
        officer
      );
    }
    const large = await mods.withdrawals
      .recordWithdrawal(
        { accountId: shares, amount: '100001', method: 'cash' },
        clerk
      )
      .catch(err => err);
    // Shares cannot cover it: refused up front, not queued.
    expect(large).toBeInstanceOf(Error);
    expect(String(large.message)).toMatch(/is available/);

    const queued = await mods.withdrawals.recordWithdrawal(
      { accountId: msa, amount: '101000', method: 'cash' },
      clerk
    );
    await mods.review.reviewTransaction(
      queued.id,
      { outcome: 'return', comment: 'Confirm the amount' },
      secretary
    );
    await expect(
      mods.withdrawals.resubmitWithdrawal(
        queued.id,
        { accountId: msa, amount: '101000', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/Only the officer who recorded/);
    // Below the band it would pay out at once, which a clerk may not.
    await expect(
      mods.withdrawals.resubmitWithdrawal(
        queued.id,
        { accountId: msa, amount: '500', method: 'cash' },
        clerk
      )
    ).rejects.toThrowError(/paid out at once/);
    const resubmitted = await mods.withdrawals.resubmitWithdrawal(
      queued.id,
      { accountId: msa, amount: '102000', method: 'cash', reason: 'Confirmed' },
      clerk
    );
    expect(resubmitted.status).toBe('submitted');
    expect(resubmitted.amount).toBe('102000.00');
    expect(resubmitted.currentStepCode).toBe('secretary_review');
  });

  // Officer direction (migration 0095): after the Secretary and the
  // President, the Treasurer disburses. transaction.post alone posts a
  // deposit; paying out needs transaction.disburse.
  it('is disbursed by whoever holds transaction.disburse, never by transaction.post alone', async () => {
    const mods = await load();
    const large = await mods.withdrawals.recordWithdrawal(
      { accountId: msa, amount: '101000', method: 'cash', reason: 'Umrah' },
      officer
    );
    await mods.review.reviewTransaction(
      large.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    await mods.review.reviewTransaction(
      large.id,
      { outcome: 'forward', comment: '' },
      president
    );
    const posterOnly = {
      ...treasurer,
      permissions: new Set(['transaction.post', 'transaction.view']),
    };
    await expect(
      mods.review.postApprovedTransaction(large.id, posterOnly, {
        method: 'cash',
      })
    ).rejects.toThrowError(/permission to disburse/);
    // The queue offers it to the disburser, not to a poster.
    expect(
      (await mods.review.approvedTransactions(posterOnly)).map(t => t.id)
    ).not.toContain(large.id);
    const disburserOnly = {
      ...treasurer,
      permissions: new Set(['transaction.disburse', 'transaction.view']),
    };
    expect(
      (await mods.review.approvedTransactions(disburserOnly)).map(t => t.id)
    ).toContain(large.id);
    const paid = await mods.review.postApprovedTransaction(
      large.id,
      disburserOnly,
      { method: 'cash' }
    );
    expect(paid.status).toBe('posted');
  });
});
