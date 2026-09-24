import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
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

// Phase 1's money becomes Phase 2's opening balances (S-1303). The carry
// function is exercised directly against raw receipts here, so what is
// asserted is the money — not the approval workflow, which
// applications/workflow.test.ts already proves calls it.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);
const BACKFILL_MIGRATION = '0066_opening_balances.sql';

const dbName = `opening_test_${Date.now()}`;
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

async function load(url = appUrl) {
  await closeOpenPool();
  vi.resetModules();
  process.env.DATABASE_URL = url;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  openPool = await import('../db/pool');
  return {
    ledger: await import('./ledger'),
    payments: await import('../payments/payments'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

// The fixtures: a receipt against an application, itemised, as Phase 1
// wrote them. Built against whichever database url is given, because the
// backfill test below has one of its own.
interface Fixture {
  url: string;
  officerId: string;
  membershipTypeId: string;
  types: Record<string, string>;
}

async function fixture(url: string): Promise<Fixture> {
  const officer = await run(
    url,
    `insert into app_user (email, display_name)
     values ('officer@albarakah.mu', 'Officer') returning id`
  );
  const membershipType = await run(
    url,
    `select id from membership_type where code = 'individual'`
  );
  // Numbers the customer accounts the fixtures open; the real numbering
  // (next_customer_account_number) is not what is under test here.
  await run(
    ownerUrl.replace(dbName, url.split('/').pop()!),
    'create sequence if not exists customers_in_test'
  );
  await run(
    ownerUrl.replace(dbName, url.split('/').pop()!),
    'grant usage on sequence customers_in_test to albarakah_app'
  );
  // A configuration table: its audit trigger wants to know who (S-210).
  await run(
    url,
    `begin;
     set local albarakah.actor_description = 'opening.test';
     insert into account_type (code, name, category, number_prefix, sort_order)
     values ('hsa', 'Hajj Savings', 'savings', 'HSA', 5)
     on conflict (code) do nothing;
     commit;`
  );
  const types = await run(url, `select code, id from account_type`);
  return {
    url,
    officerId: officer.rows[0].id,
    membershipTypeId: membershipType.rows[0].id,
    types: Object.fromEntries(types.rows.map(r => [r.code, r.id])),
  };
}

async function newMember(f: Fixture, accountStatus = 'active') {
  const application = await run(
    f.url,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [f.membershipTypeId, f.officerId]
  );
  const applicationId = application.rows[0].id;
  const member = await run(
    f.url,
    `insert into member (application_id, membership_type_id)
     values ($1, $2) returning id`,
    [applicationId, f.membershipTypeId]
  );
  const accounts: Record<string, string> = {};
  for (const code of ['shares', 'msa']) {
    const account = await run(
      f.url,
      `insert into account
         (member_id, account_type_id, is_membership_default, status,
          opened_by_application_id)
       values ($1, $2, true, $3, $4) returning id`,
      [member.rows[0].id, f.types[code], accountStatus, applicationId]
    );
    accounts[code] = account.rows[0].id;
  }
  return { applicationId, memberId: member.rows[0].id, accounts };
}

async function newCustomer(f: Fixture, accountStatus = 'active') {
  const application = await run(
    f.url,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [f.membershipTypeId, f.officerId]
  );
  const applicationId = application.rows[0].id;
  const customer = await run(
    f.url,
    `insert into customer (application_id) values ($1) returning id`,
    [applicationId]
  );
  const account = await run(
    f.url,
    `insert into account
       (customer_id, account_type_id, account_no, status,
        opened_by_application_id)
     values ($1, $2, 'HSA' || lpad(nextval('customers_in_test')::text, 4, '0'),
             $3, $4) returning id`,
    [customer.rows[0].id, f.types.hsa, accountStatus, applicationId]
  );
  return {
    applicationId,
    customerId: customer.rows[0].id,
    accountId: account.rows[0].id,
  };
}

async function newReceipt(
  f: Fixture,
  applicationId: string,
  options: {
    lines?: Record<string, string>;
    accountLines?: Record<string, string>;
    refunds?: string;
    receivedAt?: string;
    voided?: boolean;
  }
) {
  const receipt = await run(
    f.url,
    `insert into receipt_number (allocated_by, state) values ($1, 'issued')
     returning id, receipt_no`,
    [f.officerId]
  );
  const lines = Object.entries(options.lines ?? {});
  const accountLines = Object.entries(options.accountLines ?? {});
  const total = [...lines, ...accountLines].reduce(
    (sum, [, amount]) => sum + Number(amount),
    0
  );
  const payment = await run(
    f.url,
    `insert into payment
       (receipt_number_id, kind, refunds_id, application_id, method,
        method_reference, total_amount, recorded_by, received_at,
        voided_at, voided_by, void_reason)
     values ($1, $2, $3, $4, 'cash', 'slip 1', $5, $6::uuid,
             coalesce($7::timestamptz, now()),
             case when $8::boolean then now() end,
             case when $8::boolean then $6::uuid end,
             case when $8::boolean then 'issued in error' end)
     returning id`,
    [
      receipt.rows[0].id,
      options.refunds ? 'refund' : 'payment',
      options.refunds ?? null,
      applicationId,
      total.toFixed(2),
      f.officerId,
      options.receivedAt ?? null,
      options.voided ?? false,
    ]
  );
  const paymentId = payment.rows[0].id;
  for (const [index, [code, amount]] of lines.entries()) {
    await run(
      f.url,
      `insert into payment_line (payment_id, component_code, amount, sort_order)
       values ($1, $2, $3, $4)`,
      [paymentId, code, amount, index]
    );
  }
  for (const [index, [code, amount]] of accountLines.entries()) {
    await run(
      f.url,
      `insert into payment_account_line
         (payment_id, account_type_id, account_type_code, account_type_name,
          amount, sort_order)
       values ($1, $2, $3, $3, $4, $5)`,
      [paymentId, f.types[code], code, amount, index]
    );
  }
  return { paymentId, receiptNo: receipt.rows[0].receipt_no as string };
}

async function balance(url: string, accountId: string): Promise<string | null> {
  const r = await run(
    url,
    `select balance from account_balance where account_id = $1`,
    [accountId]
  );
  return r.rows[0]?.balance ?? null;
}

let f: Fixture;
const actor = { userId: '', description: 'officer@albarakah.mu' };

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);
  f = await fixture(appUrl);
  actor.userId = f.officerId;
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('carrying a receipt into the ledger', () => {
  it('lands the shares and MSA lines on the accounts the application opened, and nothing else', async () => {
    const { ledger } = await load();
    const member = await newMember(f);
    const receipt = await newReceipt(f, member.applicationId, {
      lines: {
        entrance: '1500.00',
        takaful: '2000.00',
        shares: '5000.00',
        msa_deposit: '750.00',
        processing: '0.00',
      },
      receivedAt: '2026-03-01T09:00:00Z',
    });

    expect(await ledger.postOpeningBalances(member.applicationId, actor)).toBe(
      2
    );
    expect(await balance(appUrl, member.accounts.shares)).toBe('5000.00');
    expect(await balance(appUrl, member.accounts.msa)).toBe('750.00');

    // Each carried transaction names the receipt it came from, who took
    // the money and when — not who ran the carry, nor when.
    const carried = await run(
      appUrl,
      `select t.kind, t.status, t.amount, t.captured_by, t.posted_by,
              t.created_at, rn.receipt_no
         from transaction t
         join receipt_number rn on rn.id = t.receipt_number_id
        where t.member_id = $1
        order by t.serial_no`,
      [member.memberId]
    );
    expect(carried.rows).toHaveLength(2);
    for (const row of carried.rows) {
      expect(row.kind).toBe('deposit');
      expect(row.status).toBe('posted');
      expect(row.captured_by).toBe(f.officerId);
      expect(row.posted_by).toBe(actor.userId);
      expect(row.receipt_no).toBe(receipt.receiptNo);
      expect(row.created_at.toISOString()).toBe('2026-03-01T09:00:00.000Z');
    }
    expect(carried.rows.map(r => r.amount)).toEqual(['5000.00', '750.00']);

    // The event says where it came from.
    const events = await run(
      appUrl,
      `select payload->>'carried_from_phase_1' as carried,
              payload->>'receipt_no' as receipt_no
         from financial_event e
         join transaction t on t.id = e.transaction_id
        where t.member_id = $1`,
      [member.memberId]
    );
    expect(events.rows).toEqual([
      { carried: 'true', receipt_no: receipt.receiptNo },
      { carried: 'true', receipt_no: receipt.receiptNo },
    ]);
  });

  it('is free to call again: a line is carried once', async () => {
    const { ledger } = await load();
    const member = await newMember(f);
    await newReceipt(f, member.applicationId, { lines: { shares: '5000.00' } });

    expect(await ledger.postOpeningBalances(member.applicationId, actor)).toBe(
      1
    );
    expect(await ledger.postOpeningBalances(member.applicationId, actor)).toBe(
      0
    );
    expect(await balance(appUrl, member.accounts.shares)).toBe('5000.00');
  });

  it('reverses a refunded line, through a reversal that names the deposit', async () => {
    const { ledger } = await load();
    const member = await newMember(f);
    const original = await newReceipt(f, member.applicationId, {
      lines: { shares: '5000.00', msa_deposit: '1000.00' },
      receivedAt: '2026-03-01T09:00:00Z',
    });
    await ledger.postOpeningBalances(member.applicationId, actor);

    await newReceipt(f, member.applicationId, {
      lines: { shares: '1200.00' },
      refunds: original.paymentId,
      receivedAt: '2026-03-02T09:00:00Z',
    });
    expect(await ledger.postOpeningBalances(member.applicationId, actor)).toBe(
      1
    );

    expect(await balance(appUrl, member.accounts.shares)).toBe('3800.00');
    expect(await balance(appUrl, member.accounts.msa)).toBe('1000.00');

    const reversal = await run(
      appUrl,
      `select t.kind, t.amount, o.kind as reverses_kind, o.amount as reverses_amount,
              e.direction
         from transaction t
         join transaction o on o.id = t.reverses_id
         join account_entry e on e.transaction_id = t.id
        where t.member_id = $1 and t.kind = 'reversal'`,
      [member.memberId]
    );
    expect(reversal.rows).toEqual([
      {
        kind: 'reversal',
        amount: '1200.00',
        reverses_kind: 'deposit',
        reverses_amount: '5000.00',
        direction: 'debit',
      },
    ]);

    // A statement reads the credit and the debit, in order.
    const entries = await ledger.accountEntries(member.accounts.shares);
    expect(entries.map(e => [e.kind, e.direction, e.runningBalance])).toEqual([
      ['reversal', 'debit', '3800.00'],
      ['deposit', 'credit', '5000.00'],
    ]);
  });

  it('ignores a voided receipt and a zero line', async () => {
    const { ledger } = await load();
    const member = await newMember(f);
    await newReceipt(f, member.applicationId, {
      lines: { shares: '999.00' },
      voided: true,
    });
    await newReceipt(f, member.applicationId, {
      lines: { shares: '0.00', msa_deposit: '0.00' },
    });

    expect(await ledger.postOpeningBalances(member.applicationId, actor)).toBe(
      0
    );
    expect(await balance(appUrl, member.accounts.shares)).toBeNull();
  });

  it('carries an account line onto a customer account, whatever its status', async () => {
    const { ledger } = await load();
    const customer = await newCustomer(f, 'pending');
    await newReceipt(f, customer.applicationId, {
      accountLines: { hsa: '2500.00' },
    });

    expect(
      await ledger.postOpeningBalances(customer.applicationId, actor)
    ).toBe(1);
    expect(await balance(appUrl, customer.accountId)).toBe('2500.00');

    const holder = await run(
      appUrl,
      `select member_id, customer_id from transaction where account_id = $1`,
      [customer.accountId]
    );
    expect(holder.rows).toEqual([
      { member_id: null, customer_id: customer.customerId },
    ]);
  });

  it('still refuses a new deposit on an account that is not active', async () => {
    const { ledger } = await load();
    const customer = await newCustomer(f, 'pending');
    const deposit = await run(
      appUrl,
      `insert into transaction
         (kind, customer_id, account_id, amount, method, status, captured_by)
       values ('deposit', $1, $2, 100, 'cash', 'submitted', $3)
       returning id`,
      [customer.customerId, customer.accountId, f.officerId]
    );
    await expect(
      ledger.postTransaction(deposit.rows[0].id, actor)
    ).rejects.toThrowError(/money cannot move/);
  });

  it('refuses a reversal for more than the original moved, or on another account', async () => {
    const { ledger } = await load();
    const member = await newMember(f);
    await newReceipt(f, member.applicationId, { lines: { shares: '5000.00' } });
    await ledger.postOpeningBalances(member.applicationId, actor);
    const original = (
      await run(
        appUrl,
        `select id from transaction where member_id = $1 and kind = 'deposit'`,
        [member.memberId]
      )
    ).rows[0].id;

    const reversal = async (amount: string, accountId: string) =>
      (
        await run(
          appUrl,
          `insert into transaction
             (kind, reverses_id, member_id, account_id, amount, method, status,
              captured_by)
           values ('reversal', $1, $2, $3, $4, 'cash', 'submitted', $5)
           returning id`,
          [original, member.memberId, accountId, amount, f.officerId]
        )
      ).rows[0].id;

    await expect(
      ledger.postTransaction(
        await reversal('5000.01', member.accounts.shares),
        actor
      )
    ).rejects.toThrowError(/reverses more than/);
    await expect(
      ledger.postTransaction(
        await reversal('10.00', member.accounts.msa),
        actor
      )
    ).rejects.toThrowError(/on the account it names/);
    expect(await balance(appUrl, member.accounts.shares)).toBe('5000.00');
  });

  it('refuses to void a receipt once its lines are on a balance', async () => {
    const { ledger, payments } = await load();
    const member = await newMember(f);
    const receipt = await newReceipt(f, member.applicationId, {
      lines: { shares: '5000.00' },
    });
    await ledger.postOpeningBalances(member.applicationId, actor);

    const treasurer = await run(
      appUrl,
      `insert into app_user (email, display_name)
       values ('treasurer@albarakah.mu', 'Treasurer') returning id`
    );
    const principal: Principal = {
      userId: treasurer.rows[0].id,
      entraSubject: 'sub-treasurer',
      email: 'treasurer@albarakah.mu',
      displayName: 'Treasurer',
      roles: [],
      roleNames: [],
      permissions: new Set(['payment.void', 'payment.view']),
    };
    await expect(
      payments.voidPayment(receipt.paymentId, 'issued twice', principal)
    ).rejects.toThrowError(/is already on the account.*Refund it instead/);
    expect(await balance(appUrl, member.accounts.shares)).toBe('5000.00');
  });
});

// The backfill itself: receipts that exist BEFORE migration 0066 runs are on
// their accounts once it has. Its own database, migrated in two steps.
describe('the one-time backfill', () => {
  const backfillDb = `${dbName}_backfill`;
  const backfillOwner = `postgresql://postgres@127.0.0.1:5433/${backfillDb}`;
  const backfillApp = `postgresql://albarakah_app:devpassword@127.0.0.1:5433/${backfillDb}`;
  let beforeDir: string;

  beforeAll(async () => {
    // Every migration before the backfill, in a directory of its own, so
    // the receipts can be written into the schema Phase 1 left.
    beforeDir = await mkdtemp(path.join(os.tmpdir(), 'migrations-before-'));
    const names = (await readdir(MIGRATIONS_DIR))
      .filter(n => n.endsWith('.sql'))
      .sort();
    for (const name of names) {
      if (name >= BACKFILL_MIGRATION) break;
      await copyFile(
        path.join(MIGRATIONS_DIR, name),
        path.join(beforeDir, name)
      );
    }
    await run(ADMIN_URL, `create database ${backfillDb}`);
    await run(backfillOwner, 'revoke all on schema public from public');
    await run(
      backfillOwner,
      `grant connect on database ${backfillDb} to albarakah_app`
    );
    await migrate(backfillOwner, beforeDir);
  }, 60_000);

  afterAll(async () => {
    await closeOpenPool();
    await run(ADMIN_URL, `drop database if exists ${backfillDb} with (force)`);
    await rm(beforeDir, { recursive: true, force: true });
  });

  it('carries every receipt taken before it, in the order the money arrived', async () => {
    const g = await fixture(backfillApp);
    const later = await newMember(g);
    const earlier = await newMember(g);
    const customer = await newCustomer(g, 'pending');
    await newReceipt(g, later.applicationId, {
      lines: { shares: '5000.00', msa_deposit: '200.00' },
      receivedAt: '2026-02-10T10:00:00Z',
    });
    const first = await newReceipt(g, earlier.applicationId, {
      lines: { entrance: '1500.00', shares: '6000.00' },
      receivedAt: '2026-01-05T10:00:00Z',
    });
    await newReceipt(g, earlier.applicationId, {
      lines: { shares: '1000.00' },
      refunds: first.paymentId,
      receivedAt: '2026-01-20T10:00:00Z',
    });
    await newReceipt(g, customer.applicationId, {
      accountLines: { hsa: '300.00' },
      receivedAt: '2026-02-01T10:00:00Z',
    });
    await newReceipt(g, later.applicationId, {
      lines: { shares: '50.00' },
      voided: true,
    });

    const applied = await migrate(backfillOwner, MIGRATIONS_DIR);
    expect(applied.applied).toContain(BACKFILL_MIGRATION);

    expect(await balance(backfillApp, earlier.accounts.shares)).toBe('5000.00');
    expect(await balance(backfillApp, earlier.accounts.msa)).toBeNull();
    expect(await balance(backfillApp, later.accounts.shares)).toBe('5000.00');
    expect(await balance(backfillApp, later.accounts.msa)).toBe('200.00');
    expect(await balance(backfillApp, customer.accountId)).toBe('300.00');

    // Posted by the migration's own actor, in receipt order, with the
    // reversal after every deposit — that is the only order the function
    // could have posted them in, and the sequence proves it held.
    const posted = await run(
      backfillApp,
      `select t.kind, t.amount, u.entra_subject
         from transaction t
         join app_user u on u.id = t.posted_by
        order by t.serial_no`
    );
    expect(posted.rows.map(r => [r.kind, r.amount])).toEqual([
      ['deposit', '6000.00'],
      ['reversal', '1000.00'],
      ['deposit', '300.00'],
      ['deposit', '5000.00'],
      ['deposit', '200.00'],
    ]);
    expect(new Set(posted.rows.map(r => r.entra_subject))).toEqual(
      new Set(['system:migration'])
    );

    // The control total the Treasurer checks: every Shares balance is
    // every issued, unrefunded shares line.
    const control = await run(
      backfillApp,
      `select (select coalesce(sum(b.balance), 0)
                 from account_balance b
                 join account a on a.id = b.account_id
                 join account_type ty on ty.id = a.account_type_id
                where ty.code = 'shares') as balances,
              (select coalesce(sum(case p.kind when 'refund' then -l.amount else l.amount end), 0)
                 from payment p
                 join payment_line l on l.payment_id = p.id
                where p.voided_at is null and l.component_code = 'shares') as lines`
    );
    expect(control.rows[0].balances).toBe(control.rows[0].lines);

    // And nothing is left to carry.
    const { ledger } = await load(backfillApp);
    expect(
      await ledger.postOpeningBalances(earlier.applicationId, {
        userId: g.officerId,
        description: 'officer@albarakah.mu',
      })
    ).toBe(0);
  }, 60_000);
});
