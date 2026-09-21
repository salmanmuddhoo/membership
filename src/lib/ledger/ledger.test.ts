// The account ledger (migration 0064, S-1301, S-1302).
//
// Needs a real database: what is under test is that a balance is the sum of
// immutable entries, that post_transaction() is the only thing that moves
// one, and that the guards refuse everything else — none of which a mock
// can answer.
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

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `ledger_test_${Date.now()}`;
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

// See admin.test.ts: each load() opens a new pool, and the one it replaces
// has to be closed or the suite exhausts the server's connection slots.
let openPool: { closePool: () => Promise<void> } | undefined;

async function closeOpenPool() {
  const previous = openPool;
  openPool = undefined;
  await previous?.closePool();
}

async function load() {
  await closeOpenPool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  openPool = await import('../db/pool');
  return import('./ledger');
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let userId: string;
let memberId: string;
let accountId: string;
let secondAccountId: string;
const actor = { userId: '', description: 'admin@albarakah.mu' };

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('admin@albarakah.mu', 'Administrator')
     returning id`
  );
  userId = user.rows[0].id;
  actor.userId = userId;

  const membershipTypeId = (
    await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    )
  ).rows[0].id;
  const shares = (
    await run(appUrl, `select id from account_type where code = 'shares'`)
  ).rows[0].id;
  const msa = (
    await run(appUrl, `select id from account_type where code = 'msa'`)
  ).rows[0].id;

  const application = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [membershipTypeId, userId]
  );
  const member = await run(
    appUrl,
    `insert into member (application_id, membership_type_id)
     values ($1, $2) returning id`,
    [application.rows[0].id, membershipTypeId]
  );
  memberId = member.rows[0].id;

  accountId = (
    await run(
      appUrl,
      `insert into account (member_id, account_type_id, is_membership_default)
       values ($1, $2, true) returning id`,
      [memberId, shares]
    )
  ).rows[0].id;
  secondAccountId = (
    await run(
      appUrl,
      `insert into account (member_id, account_type_id, is_membership_default)
       values ($1, $2, true) returning id`,
      [memberId, msa]
    )
  ).rows[0].id;
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

async function newDeposit(
  amount: string,
  status = 'submitted',
  account = accountId
): Promise<string> {
  const result = await run(
    appUrl,
    `insert into transaction
       (kind, member_id, account_id, amount, method, status, captured_by)
     values ('deposit', $1, $2, $3, 'cash', $4, $5)
     returning id`,
    [memberId, account, amount, status, userId]
  );
  return result.rows[0].id;
}

describe('posting a deposit', () => {
  it('writes one credit entry, moves the cache, and marks the transaction posted', async () => {
    const ledger = await load();
    const id = await newDeposit('150.00');

    await ledger.postTransaction(id, actor);

    const entries = await run(
      appUrl,
      `select direction, amount from account_entry where transaction_id = $1`,
      [id]
    );
    expect(entries.rows).toEqual([{ direction: 'credit', amount: '150.00' }]);

    const balance = await ledger.accountBalance(accountId);
    expect(balance?.balance).toBe('150.00');
    expect(balance?.entryCount).toBe(1);

    const tx = await run(
      appUrl,
      `select status, posted_by, posted_at is not null as posted from transaction where id = $1`,
      [id]
    );
    expect(tx.rows[0]).toEqual({
      status: 'posted',
      posted_by: userId,
      posted: true,
    });
  });

  it('emits a self-contained financial event and an audit row', async () => {
    const ledger = await load();
    const id = await newDeposit('25.50');
    await ledger.postTransaction(id, actor);

    const event = await run(
      appUrl,
      `select event_type, payment_id, payload from financial_event where transaction_id = $1`,
      [id]
    );
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0].event_type).toBe('transaction.posted');
    expect(event.rows[0].payment_id).toBeNull();
    expect(event.rows[0].payload).toMatchObject({
      kind: 'deposit',
      direction: 'credit',
      amount: 25.5,
      account_id: accountId,
      posted_by: userId,
    });
    expect(event.rows[0].payload.reference).toMatch(/^TX-\d{6}$/);

    const audit = await run(
      appUrl,
      `select actor_user_id, action, entity_type from audit_event
        where action = 'transaction.posted' and entity_id = $1`,
      [event.rows[0].payload.reference]
    );
    expect(audit.rows).toEqual([
      {
        actor_user_id: userId,
        action: 'transaction.posted',
        entity_type: 'transaction',
      },
    ]);
  });

  it('refuses to post the same transaction twice, or a draft', async () => {
    const ledger = await load();
    const id = await newDeposit('10.00');
    await ledger.postTransaction(id, actor);
    await expect(ledger.postTransaction(id, actor)).rejects.toThrowError(
      /is posted, and only a submitted or approved one posts/
    );

    const draft = await newDeposit('10.00', 'draft');
    await expect(ledger.postTransaction(draft, actor)).rejects.toThrowError(
      /is draft/
    );
  });

  it('refuses to post onto an account that is not active', async () => {
    const ledger = await load();
    await run(ownerUrl, `update account set status = 'closed' where id = $1`, [
      secondAccountId,
    ]);
    try {
      const id = await newDeposit('10.00', 'submitted', secondAccountId);
      await expect(ledger.postTransaction(id, actor)).rejects.toThrowError(
        /is closed, and money cannot move on it/
      );
      await expect(ledger.postTransaction(id, actor)).rejects.toBeInstanceOf(
        ledger.LedgerError
      );
    } finally {
      await run(
        ownerUrl,
        `update account set status = 'active' where id = $1`,
        [secondAccountId]
      );
    }
  });

  it('requires a named actor', async () => {
    const ledger = await load();
    const id = await newDeposit('10.00');
    await expect(
      ledger.postTransaction(id, { userId, description: '  ' })
    ).rejects.toThrowError(/requires a named actor/);
  });
});

describe('what cannot change', () => {
  it('refuses any edit or delete of a posted transaction, for the owner too', async () => {
    const ledger = await load();
    const id = await newDeposit('10.00');
    await ledger.postTransaction(id, actor);

    await expect(
      run(appUrl, `update transaction set amount = 999 where id = $1`, [id])
    ).rejects.toThrowError(/cannot be edited; reverse it instead/);
    await expect(
      run(ownerUrl, `update transaction set reason = 'x' where id = $1`, [id])
    ).rejects.toThrowError(/cannot be edited/);
    await expect(
      run(ownerUrl, `delete from transaction where id = $1`, [id])
    ).rejects.toThrowError(/only a draft transaction can be deleted/);
  });

  it('lets a draft be deleted and a working one be edited, but never its identity', async () => {
    await load();
    const draft = await newDeposit('10.00', 'draft');
    await run(appUrl, `update transaction set amount = 20 where id = $1`, [
      draft,
    ]);
    await expect(
      run(
        appUrl,
        `update transaction set kind = 'deposit', member_id = gen_random_uuid() where id = $1`,
        [draft]
      )
    ).rejects.toThrowError(/identity cannot change/);
    await run(appUrl, `delete from transaction where id = $1`, [draft]);

    const submitted = await newDeposit('10.00', 'submitted');
    await expect(
      run(appUrl, `delete from transaction where id = $1`, [submitted])
    ).rejects.toThrowError(/only a draft transaction can be deleted/);
  });

  it('refuses any update or delete of an entry, for the owner too', async () => {
    const ledger = await load();
    const id = await newDeposit('10.00');
    await ledger.postTransaction(id, actor);

    await expect(
      run(
        ownerUrl,
        `update account_entry set amount = 1 where transaction_id = $1`,
        [id]
      )
    ).rejects.toThrowError(/append-only/);
    await expect(
      run(ownerUrl, `delete from account_entry where transaction_id = $1`, [id])
    ).rejects.toThrowError(/append-only/);
  });

  it('honours the same idempotency key from the same person as one transaction', async () => {
    await load();
    await run(
      appUrl,
      `insert into transaction
         (kind, member_id, account_id, amount, method, status, captured_by,
          idempotency_key, idempotency_fingerprint)
       values ('deposit', $1, $2, 5, 'cash', 'draft', $3, 'key-1', 'fp-1')`,
      [memberId, accountId, userId]
    );
    await expect(
      run(
        appUrl,
        `insert into transaction
           (kind, member_id, account_id, amount, method, status, captured_by,
            idempotency_key, idempotency_fingerprint)
         values ('deposit', $1, $2, 5, 'cash', 'draft', $3, 'key-1', 'fp-1')`,
        [memberId, accountId, userId]
      )
    ).rejects.toThrowError(/transaction_idempotency_idx/);
  });
});

// S-1309: what a statement line carries, and paging backwards through it.
describe('the history of an account', () => {
  it('describes each entry, names its method and receipt, and pages by sequence', async () => {
    const ledger = await load();
    // A member of its own: the fixture member already holds one account of
    // each type, and the schema allows no second (S-309).
    const msa = (
      await run(appUrl, `select id from account_type where code = 'msa'`)
    ).rows[0].id;
    const other = await run(
      appUrl,
      `with app as (
         insert into membership_application (membership_type_id, captured_by, status)
         select membership_type_id, $1, 'approved' from member where id = $2
         returning id, membership_type_id
       )
       insert into member (application_id, membership_type_id)
       select id, membership_type_id from app returning id`,
      [userId, memberId]
    );
    const otherMemberId = other.rows[0].id;
    const account = (
      await run(
        appUrl,
        `insert into account (member_id, account_type_id, is_membership_default)
         values ($1, $2, true) returning id`,
        [otherMemberId, msa]
      )
    ).rows[0].id;

    for (const amount of ['10.00', '20.00', '30.00']) {
      const id = (
        await run(
          appUrl,
          `insert into transaction
             (kind, member_id, account_id, amount, method, status, captured_by)
           values ('deposit', $1, $2, $3, 'cash', 'submitted', $4)
           returning id`,
          [otherMemberId, account, amount, userId]
        )
      ).rows[0].id;
      await ledger.postTransaction(id, actor);
    }

    const page = await ledger.accountEntries(account, { limit: 2 });
    expect(page.map(e => [e.amount, e.runningBalance])).toEqual([
      ['30.00', '60.00'],
      ['20.00', '30.00'],
    ]);
    expect(page[0]).toMatchObject({
      kind: 'deposit',
      description: 'Deposit',
      direction: 'credit',
      currency: 'MUR',
      methodName: 'Cash',
      methodReference: '',
      reason: '',
      receiptNo: null,
      reversesReference: null,
      capturedByName: 'Administrator',
    });
    expect(page[0].occurredAt).toBeInstanceOf(Date);

    const older = await ledger.accountEntries(account, {
      limit: 2,
      beforeSequenceNo: page[1].sequenceNo,
    });
    expect(older.map(e => [e.amount, e.runningBalance])).toEqual([
      ['10.00', '10.00'],
    ]);
  });
});

describe('the balance is the sum of the entries', () => {
  it('reads a running balance in posting order', async () => {
    const ledger = await load();
    const before = await ledger.accountBalance(secondAccountId);
    const start = Number(before?.balance ?? '0');

    for (const amount of ['100.00', '20.00', '3.00']) {
      await ledger.postTransaction(
        await newDeposit(amount, 'submitted', secondAccountId),
        actor
      );
    }

    const entries = await ledger.accountEntries(secondAccountId, { limit: 3 });
    expect(entries.map(e => e.amount)).toEqual(['3.00', '20.00', '100.00']);
    expect(entries.map(e => Number(e.runningBalance))).toEqual([
      start + 123,
      start + 120,
      start + 100,
    ]);
    expect(entries[0].transactionReference).toMatch(/^TX-\d{6}$/);

    const balances = await ledger.memberBalances(memberId);
    expect(Number(balances.get(secondAccountId))).toBe(start + 123);
  });

  it('finds a cache that disagrees with its entries, and rebuilds it from them', async () => {
    const ledger = await load();
    expect(await ledger.ledgerDrift()).toEqual([]);

    // Only the owner can do this, and only because nothing but the ledger's
    // own functions is supposed to. Simulates exactly the corruption the
    // nightly job exists to catch.
    await run(
      ownerUrl,
      `update account_balance set balance = balance + 1 where account_id = $1`,
      [accountId]
    );
    const drift = await ledger.ledgerDrift();
    expect(drift.map(d => d.accountId)).toEqual([accountId]);
    expect(Number(drift[0].cached) - Number(drift[0].computed)).toBe(1);

    const outcome = await ledger.verifyLedger({
      userId: null,
      description: 'ledger-verify job',
    });
    expect(outcome.repaired).toBe(1);
    expect(await ledger.ledgerDrift()).toEqual([]);
    expect((await ledger.accountBalance(accountId))?.balance).toBe(
      drift[0].computed
    );

    const audit = await run(
      appUrl,
      `select action, actor_description, previous_value, new_value
         from audit_event where action = 'ledger.repaired' and entity_id = $1`,
      [accountId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_description).toBe('ledger-verify job');
    expect(audit.rows[0].previous_value.balance).toBe(drift[0].cached);
    expect(audit.rows[0].new_value.balance).toBe(drift[0].computed);
  });

  it('reports null for an account nothing has posted to', async () => {
    const ledger = await load();
    const fresh = (
      await run(
        appUrl,
        `insert into account (member_id, account_type_id)
         select $1, id from account_type where code = 'hsa' returning id`,
        [memberId]
      )
    ).rows[0]?.id;
    if (!fresh) return; // no HSA type seeded on this schema; nothing to assert
    expect(await ledger.accountBalance(fresh)).toBeNull();
    expect((await ledger.memberBalances(memberId)).get(fresh)).toBe('0.00');
  });
});

describe('the test-data reset reaches the ledger', () => {
  it('truncates entries, balances and transactions through the flag', async () => {
    const ledger = await load();
    await ledger.postTransaction(await newDeposit('10.00'), actor);
    await run(ownerUrl, `select reset_all_test_data($1, 'test reset')`, [
      userId,
    ]);
    for (const table of ['account_entry', 'account_balance', 'transaction']) {
      const count = await run(
        appUrl,
        `select count(*)::int as n from ${table}`
      );
      expect(count.rows[0].n).toBe(0);
    }
  });
});
