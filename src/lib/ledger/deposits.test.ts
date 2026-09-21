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

// Recording a deposit (S-1305, S-1306, S-1308): the rules that refuse one,
// the posting and receipt that follow, and the key that makes a retry the
// same deposit. Against real migrations, like every ledger suite.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `deposits_test_${Date.now()}`;
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

// Configuration tables want an actor on every write (S-210).
async function configure(sql: string) {
  await run(
    appUrl,
    `begin; set local albarakah.actor_description = 'deposits.test'; ${sql}; commit;`
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
  return import('./deposits');
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let officer: Principal;
let onlooker: Principal;
let memberId: string;
let shares: string;
let msa: string;
let hsa: string;
let pendingInv: string;

function principalFor(userId: string, email: string, permissions: string[]) {
  return {
    userId,
    entraSubject: `sub-${email}`,
    email,
    displayName: email,
    roles: [],
    roleNames: [],
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
     values ('officer@albarakah.mu', 'Officer'), ('viewer@albarakah.mu', 'Viewer')
     returning id, email`
  );
  const byEmail = new Map(users.rows.map(r => [r.email, r.id]));
  officer = principalFor(
    byEmail.get('officer@albarakah.mu'),
    'officer@albarakah.mu',
    ['transaction.capture', 'transaction.post']
  );
  onlooker = principalFor(
    byEmail.get('viewer@albarakah.mu'),
    'viewer@albarakah.mu',
    ['member.view']
  );

  // Two more account types: one that takes no deposits, one capped.
  await configure(
    `insert into account_type (code, name, category, number_prefix, sort_order, allows_deposit)
     values ('hsa', 'Hajj Savings', 'savings', 'HSA', 5, false);
     insert into account_type (code, name, category, number_prefix, sort_order, maximum_transaction_amount)
     values ('inv', 'Investment', 'investment', 'INV', 6, 1000)`
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
  const member = await run(
    appUrl,
    `insert into member (application_id, membership_type_id)
     values ($1, $2) returning id`,
    [application.rows[0].id, membershipTypeId]
  );
  memberId = member.rows[0].id;

  const types = Object.fromEntries(
    (await run(appUrl, `select code, id from account_type`)).rows.map(r => [
      r.code,
      r.id,
    ])
  );
  const open = async (
    code: string,
    status = 'active',
    accountNo: string | null = null
  ) =>
    (
      await run(
        appUrl,
        `insert into account
           (member_id, account_type_id, is_membership_default, status, account_no)
         values ($1, $2, $3, $4, $5) returning id`,
        [memberId, types[code], accountNo === null, status, accountNo]
      )
    ).rows[0].id;
  shares = await open('shares');
  msa = await open('msa');
  hsa = await open('hsa', 'active', 'HSA0001');
  pendingInv = await open('inv', 'pending', 'INV0001');
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return (await run(appUrl, sql, params)).rows[0].n;
}

describe('recording a deposit', () => {
  it('posts it through the engine, moves the balance and issues the receipt, in one step', async () => {
    const deposits = await load();
    const deposit = await deposits.recordDeposit(
      { accountId: shares, amount: '500', method: 'cash', reason: 'Top up' },
      officer
    );

    expect(deposit.status).toBe('posted');
    expect(deposit.reference).toMatch(/^TX-\d{6}$/);
    expect(deposit.receiptNo).toMatch(/^RCT-\d{6}$/);
    expect(deposit.amount).toBe('500.00');
    expect(deposit.balanceAfter).toBe('500.00');
    expect(deposit.methodName).toBe('Cash');
    expect(deposit.capturedById).toBe(officer.userId);
    expect(deposit.memberId).toBe(memberId);

    const balance = await run(
      appUrl,
      `select balance from account_balance where account_id = $1`,
      [shares]
    );
    expect(balance.rows[0].balance).toBe('500.00');

    // The receipt is issued, not left allocated, and the event names it.
    const receipt = await run(
      appUrl,
      `select rn.state, fe.receipt_no
         from transaction t
         join receipt_number rn on rn.id = t.receipt_number_id
         join financial_event fe on fe.transaction_id = t.id
        where t.id = $1`,
      [deposit.id]
    );
    expect(receipt.rows[0]).toEqual({
      state: 'issued',
      receipt_no: deposit.receiptNo,
    });
  });

  it('answers a repeated key with the original, and refuses the key with a different request', async () => {
    const deposits = await load();
    const key = `key-${Date.now()}`;
    const before = await count('select count(*)::int as n from transaction');

    const first = await deposits.recordDeposit(
      { accountId: msa, amount: '250.00', method: 'cash', idempotencyKey: key },
      officer
    );
    const again = await deposits.recordDeposit(
      { accountId: msa, amount: '250', method: 'cash', idempotencyKey: key },
      officer
    );
    expect(again.id).toBe(first.id);
    expect(await count('select count(*)::int as n from transaction')).toBe(
      before + 1
    );

    await expect(
      deposits.recordDeposit(
        {
          accountId: msa,
          amount: '260.00',
          method: 'cash',
          idempotencyKey: key,
        },
        officer
      )
    ).rejects.toMatchObject({ reason: 'conflict' });
    expect(await count('select count(*)::int as n from transaction')).toBe(
      before + 1
    );

    // Another officer's identical key is their own.
    const other = await run(
      appUrl,
      `insert into app_user (email, display_name)
       values ('second@albarakah.mu', 'Second') returning id`
    );
    const second = principalFor(other.rows[0].id, 'second@albarakah.mu', [
      'transaction.capture',
      'transaction.post',
    ]);
    const theirs = await deposits.recordDeposit(
      { accountId: msa, amount: '250.00', method: 'cash', idempotencyKey: key },
      second
    );
    expect(theirs.id).not.toBe(first.id);
  });

  it('refuses, naming the rule, before anything is written', async () => {
    const deposits = await load();
    const before = await count('select count(*)::int as n from transaction');
    const receipts = await count(
      'select count(*)::int as n from receipt_number'
    );
    const attempt = (
      input: Parameters<typeof deposits.recordDeposit>[0],
      who = officer
    ) => deposits.recordDeposit(input, who);

    await expect(
      attempt({ accountId: shares, amount: '10', method: 'cash' }, onlooker)
    ).rejects.toThrowError(/permission/);
    // S-1311: capture without post is a Clerk's, and a deposit has no chain
    // to hand it on to yet.
    const clerk = principalFor(onlooker.userId, 'viewer@albarakah.mu', [
      'transaction.capture',
    ]);
    await expect(
      attempt({ accountId: shares, amount: '10', method: 'cash' }, clerk)
    ).rejects.toThrowError(/record a deposit but not post it/);
    await expect(
      attempt({
        accountId: '00000000-0000-0000-0000-000000000000',
        amount: '10',
        method: 'cash',
      })
    ).rejects.toThrowError(/no longer exists/);
    await expect(
      attempt({ accountId: hsa, amount: '10', method: 'cash' })
    ).rejects.toThrowError(/does not accept deposits/);
    await expect(
      attempt({ accountId: pendingInv, amount: '10', method: 'cash' })
    ).rejects.toThrowError(/account is pending/);
    await expect(
      attempt({ accountId: msa, amount: '20000.01', method: 'cash' })
    ).rejects.toThrowError(/cannot exceed 20000.00/);
    await expect(
      attempt({ accountId: shares, amount: '10', method: 'cheque' })
    ).rejects.toThrowError(/Enter the cheque reference/);
    await expect(
      attempt({ accountId: shares, amount: '10', method: 'migration' })
    ).rejects.toThrowError(/Choose how/);
    await expect(
      attempt({ accountId: shares, amount: '0', method: 'cash' })
    ).rejects.toThrowError(/more than zero/);
    await expect(
      attempt({ accountId: shares, amount: 'ten', method: 'cash' })
    ).rejects.toThrowError(/in rupees/);

    await run(appUrl, `update member set status = 'inactive' where id = $1`, [
      memberId,
    ]);
    try {
      await expect(
        attempt({ accountId: shares, amount: '10', method: 'cash' })
      ).rejects.toThrowError(/member is inactive/);
    } finally {
      await run(appUrl, `update member set status = 'active' where id = $1`, [
        memberId,
      ]);
    }

    // Nothing written, and no receipt number spent on any of it.
    expect(await count('select count(*)::int as n from transaction')).toBe(
      before
    );
    expect(await count('select count(*)::int as n from receipt_number')).toBe(
      receipts
    );
  });

  // S-1311: who captured is on the trail before who posted, and the rules
  // key on it wherever posting or voiding is someone else's act.
  it('records who captured it, and the segregation rules read that row', async () => {
    const deposits = await load();
    const deposit = await deposits.recordDeposit(
      { accountId: shares, amount: '75', method: 'cash' },
      officer
    );
    const trail = await run(
      appUrl,
      `select action, actor_user_id from audit_event
        where entity_type = 'transaction' and entity_id = $1
        order by occurred_at, id`,
      [deposit.reference]
    );
    expect(trail.rows).toEqual([
      { action: 'transaction.captured', actor_user_id: officer.userId },
      { action: 'transaction.posted', actor_user_id: officer.userId },
    ]);

    const { checkSegregation } = await import('../admin/segregation');
    for (const later of [
      'transaction.approved',
      'transaction.posted',
      'transaction.voided',
    ]) {
      const own = await checkSegregation(
        officer.userId,
        'transaction',
        deposit.reference,
        later
      );
      expect(own.allowed, later).toBe(false);
      const other = await checkSegregation(
        onlooker.userId,
        'transaction',
        deposit.reference,
        later
      );
      expect(other.allowed, later).toBe(true);
    }
  });

  // Officer feedback: the Transactions page finds the account from the
  // type and a number — the member's own for Shares and the MSA, the
  // account's own for the rest.
  it('finds an account from its type and number, however the number is typed', async () => {
    await load();
    const { findAccountByNumber } = await import('./lookup');
    const memberNo = (
      await run(appUrl, `select member_no from member where id = $1`, [
        memberId,
      ])
    ).rows[0].member_no as string;
    const types = Object.fromEntries(
      (await run(appUrl, `select code, id from account_type`)).rows.map(r => [
        r.code,
        r.id,
      ])
    );

    const byMember = await findAccountByNumber(
      types.shares,
      ` ${memberNo.toLowerCase()} `
    );
    expect(byMember).toMatchObject({
      accountId: shares,
      accountNo: memberNo,
      holderId: memberId,
      holderKind: 'member',
    });
    const byAccount = await findAccountByNumber(types.hsa, 'hsa0001');
    expect(byAccount).toMatchObject({ accountId: hsa, accountNo: 'HSA0001' });
    // The number is read against the type asked for, never across types.
    expect(await findAccountByNumber(types.hsa, memberNo)).toBeNull();
    expect(await findAccountByNumber(types.shares, 'HSA0001')).toBeNull();
    expect(await findAccountByNumber(types.shares, '   ')).toBeNull();
  });

  // S-1306: the same three configuration entries a cash payment reads
  // (0032, 0062), through the same function.
  it('applies the cash controls to cash, and only to cash', async () => {
    const deposits = await load();

    await expect(
      deposits.recordDeposit(
        { accountId: shares, amount: '600000', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/not authorised/);
    await expect(
      deposits.recordDeposit(
        { accountId: shares, amount: '50000', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/Source of Fund/);

    const confirmed = await deposits.recordDeposit(
      {
        accountId: shares,
        amount: '50000',
        method: 'cash',
        sourceOfFundFormConfirmed: true,
      },
      officer
    );
    expect(confirmed.status).toBe('posted');
    const flag = await run(
      appUrl,
      `select source_of_fund_form_confirmed from transaction where id = $1`,
      [confirmed.id]
    );
    expect(flag.rows[0].source_of_fund_form_confirmed).toBe(true);

    const transfer = await deposits.recordDeposit(
      {
        accountId: shares,
        amount: '600000',
        method: 'bank_transfer',
        methodReference: 'TRF-9',
      },
      officer
    );
    expect(transfer.status).toBe('posted');
  });
});
