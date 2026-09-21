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

// A person's transactions across every account (S-1506) and the reversal
// of a posted mistake (S-1505): what the one list shows, a transfer once,
// the filters, and the correction that is a new transaction and never an
// edit. Against real migrations, like every ledger suite.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `history_test_${Date.now()}`;
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
    history: await import('./history'),
    reversals: await import('./reversals'),
    review: await import('./review'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let officer: Principal;
let treasurer: Principal;
let amina: { id: string; shares: string; msa: string };
let bilal: { id: string; shares: string; msa: string };

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
     values ('officer@albarakah.mu', 'Officer'), ('treasurer@albarakah.mu', 'Treasurer')
     returning id, email`
  );
  const byEmail = new Map(users.rows.map(r => [r.email, r.id]));
  officer = principalFor(
    byEmail.get('officer@albarakah.mu'),
    'officer@albarakah.mu',
    ['account_officer'],
    ['transaction.capture', 'transaction.post', 'transaction.view']
  );
  treasurer = principalFor(
    byEmail.get('treasurer@albarakah.mu'),
    'treasurer@albarakah.mu',
    ['treasurer'],
    ['receipt.void', 'transaction.view']
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

describe('one list across every account (S-1506)', () => {
  it('shows every kind newest first, a transfer once, and filters', async () => {
    const { deposits, withdrawals, transfers, history } = await load();
    const d1 = await deposits.recordDeposit(
      { accountId: amina.shares, amount: '9000', method: 'cash' },
      officer
    );
    const d2 = await deposits.recordDeposit(
      { accountId: amina.msa, amount: '5000', method: 'cash' },
      officer
    );
    const w = await withdrawals.recordWithdrawal(
      { accountId: amina.msa, amount: '500', method: 'cash' },
      officer
    );
    const own = await transfers.recordTransfer(
      {
        sourceAccountId: amina.msa,
        amount: '1000',
        destination: { kind: 'account', accountId: amina.shares },
      },
      officer
    );
    const toBilal = await transfers.recordTransfer(
      {
        sourceAccountId: amina.msa,
        amount: '700',
        destination: { kind: 'account', accountId: bilal.msa },
      },
      officer
    );

    const all = await history.listTransactions({ memberId: amina.id });
    // Own transfer once (debit leg), Bilal's transfer once (debit leg),
    // the withdrawal and the two deposits: five rows, newest first.
    expect(all.total).toBe(5);
    expect(all.transactions.map(t => t.reference)).toEqual([
      toBilal.debitLeg.reference,
      own.debitLeg.reference,
      w.reference,
      d2.reference,
      d1.reference,
    ]);
    // Bilal sees the transfer he received, on its own.
    const his = await history.listTransactions({ memberId: bilal.id });
    expect(his.transactions.map(t => t.reference)).toEqual([
      toBilal.creditLeg!.reference,
    ]);
    expect(his.transactions[0].legDirection).toBe('credit');
    expect(his.transactions[0].counterpartHolderName).toBe('Amina Test');

    // The Society's list: credit legs never, so the transfer to Bilal once.
    const everything = await history.listTransactions({});
    expect(everything.total).toBe(5);

    const shares = await history.listTransactions({
      memberId: amina.id,
      accountId: amina.shares,
    });
    expect(shares.transactions.map(t => t.reference)).toEqual([d1.reference]);
    const kind = await history.listTransactions({
      memberId: amina.id,
      kind: 'transfer_leg',
    });
    expect(kind.total).toBe(2);
    const posted = await history.listTransactions({
      memberId: amina.id,
      status: 'posted',
    });
    expect(posted.total).toBe(5);
    const none = await history.listTransactions({
      memberId: amina.id,
      status: 'rejected',
    });
    expect(none.total).toBe(0);
    const paged = await history.listTransactions({
      memberId: amina.id,
      page: 2,
      pageSize: 2,
    });
    expect(paged.transactions.map(t => t.reference)).toEqual([
      w.reference,
      d2.reference,
    ]);
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(
      (await history.listTransactions({ memberId: amina.id, from: tomorrow }))
        .total
    ).toBe(0);
    expect(
      (await history.listTransactions({ memberId: amina.id, to: tomorrow }))
        .total
    ).toBe(5);
  });
});

describe('reversing a posted transaction (S-1505)', () => {
  it('posts the opposite entry with its own receipt, once, and leaves the original', async () => {
    const { deposits, reversals, review } = await load();
    const deposit = await deposits.recordDeposit(
      { accountId: bilal.shares, amount: '6000', method: 'cash' },
      officer
    );
    const before = await balance(bilal.shares);
    // The captor may not reverse it; nor may someone without the permission.
    await expect(
      reversals.reverseTransaction(deposit.id, { reason: 'Typo' }, officer)
    ).rejects.toThrowError(/permission/);
    const officerWhoVoids = {
      ...officer,
      permissions: new Set(['receipt.void']),
    };
    await expect(
      reversals.reverseTransaction(
        deposit.id,
        { reason: 'Typo' },
        officerWhoVoids
      )
    ).rejects.toThrowError(/may not reverse/);
    await expect(
      reversals.reverseTransaction(deposit.id, { reason: '  ' }, treasurer)
    ).rejects.toThrowError(/why/);

    const { reversals: made } = await reversals.reverseTransaction(
      deposit.id,
      { reason: 'Recorded on the wrong member' },
      treasurer
    );
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({
      kind: 'reversal',
      status: 'posted',
      accountId: bilal.shares,
      amount: '6000.00',
      reason: 'Recorded on the wrong member',
    });
    expect(made[0].receiptNo).toMatch(/^RCT-\d{6}$/);
    expect(made[0].receiptNo).not.toBe(deposit.receiptNo);
    expect(Number(before) - Number(await balance(bilal.shares))).toBe(6000);
    // The original is untouched, and cannot be reversed twice.
    const original = await review.loadTransaction(deposit.id);
    expect(original?.status).toBe('posted');
    expect(original?.receiptNo).toBe(deposit.receiptNo);
    await expect(
      reversals.reverseTransaction(deposit.id, { reason: 'Again' }, treasurer)
    ).rejects.toThrowError(/already reversed/);
    await expect(
      reversals.reverseTransaction(
        made[0].id,
        { reason: 'Undo the undo' },
        treasurer
      )
    ).resolves.toBeTruthy();
    const audit = await run(
      appUrl,
      `select new_value->>'reversed_by' as by from audit_event
        where entity_type = 'transaction' and entity_id = $1 and action = 'transaction.reversed'`,
      [deposit.reference]
    );
    expect(audit.rows).toEqual([{ by: made[0].reference }]);
  });

  it('reverses a transfer whole', async () => {
    const { deposits, transfers, reversals } = await load();
    await deposits.recordDeposit(
      { accountId: bilal.msa, amount: '3000', method: 'cash' },
      officer
    );
    const before = {
      bilal: await balance(bilal.msa),
      amina: await balance(amina.msa),
    };
    const transfer = await transfers.recordTransfer(
      {
        sourceAccountId: bilal.msa,
        amount: '800',
        destination: { kind: 'account', accountId: amina.msa },
      },
      officer
    );
    expect(transfer.status).toBe('posted');
    const { reversals: made } = await reversals.reverseTransaction(
      transfer.debitLeg.id,
      { reason: 'Wrong recipient' },
      treasurer
    );
    expect(made.map(r => [r.accountId, r.status])).toEqual([
      [bilal.msa, 'posted'],
      [amina.msa, 'posted'],
    ]);
    expect(made[0].receiptNo).toMatch(/^RCT-/);
    expect(made[1].receiptNo).toBeNull();
    expect(await balance(bilal.msa)).toBe(before.bilal);
    expect(await balance(amina.msa)).toBe(before.amina);
    // Only a posted transaction reverses.
    await expect(
      reversals.reverseTransaction(
        transfer.creditLeg!.id,
        { reason: 'x' },
        treasurer
      )
    ).rejects.toThrowError(/already reversed/);
  });
});
