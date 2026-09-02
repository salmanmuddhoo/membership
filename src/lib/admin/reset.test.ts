// Wiping a test environment back to empty (migration 0019).
//
// Needs a real database: what is under test is whether the append-only
// guards actually relax for reset_all_test_data() and nowhere else, which a
// mock cannot answer.
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

const dbName = `reset_test_${Date.now()}`;
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
  return import('./reset');
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let userId: string;
let membershipTypeId: string;
let accountTypeId: string;
let feeVersionId: string;
let actor: { userId: string; email: string };

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
  actor = { userId, email: 'admin@albarakah.mu' };

  membershipTypeId = (
    await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    )
  ).rows[0].id;
  accountTypeId = (
    await run(appUrl, `select id from account_type where code = 'shares'`)
  ).rows[0].id;
  feeVersionId = (
    await run(appUrl, `select id from fee_schedule_version limit 1`)
  ).rows[0].id;
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

// One of everything the reset is meant to touch, so a count of zero
// afterwards means the whole chain was actually reached rather than one
// table happening to already be empty.
async function seedOneOfEverything() {
  const application = await run(
    appUrl,
    `insert into membership_application
       (membership_type_id, captured_by, status)
     values ($1, $2, 'approved')
     returning id`,
    [membershipTypeId, userId]
  );
  const applicationId = application.rows[0].id;

  await run(
    appUrl,
    `insert into application_party (application_id, subject, values)
     values ($1, 'applicant', '{}'::jsonb)`,
    [applicationId]
  );
  await run(
    appUrl,
    `insert into application_transition
       (application_id, from_status, to_status, actor_user_id)
     values ($1, 'draft', 'new', $2)`,
    [applicationId, userId]
  );

  const member = await run(
    appUrl,
    `insert into member (application_id, membership_type_id)
     values ($1, $2)
     returning id`,
    [applicationId, membershipTypeId]
  );
  const memberId = member.rows[0].id;

  await run(
    appUrl,
    `insert into account (member_id, account_type_id, is_membership_default)
     values ($1, $2, true)`,
    [memberId, accountTypeId]
  );

  const receipt = await run(
    appUrl,
    `insert into receipt_number (allocated_by, state)
     values ($1, 'issued')
     returning id`,
    [userId]
  );
  const receiptId = receipt.rows[0].id;

  const payment = await run(
    appUrl,
    `insert into payment
       (receipt_number_id, member_id, fee_version_id, method, total_amount,
        recorded_by)
     values ($1, $2, $3, 'cash', 100.00, $4)
     returning id`,
    [receiptId, memberId, feeVersionId, userId]
  );
  const paymentId = payment.rows[0].id;

  await run(
    appUrl,
    `insert into payment_line (payment_id, component_code, amount)
     values ($1, 'shares', 100.00)`,
    [paymentId]
  );
  await run(
    appUrl,
    `insert into receipt_print (payment_id, printed_by) values ($1, $2)`,
    [paymentId, userId]
  );
  await run(
    appUrl,
    `insert into financial_event (event_type, payment_id, receipt_no, payload)
     values ('payment.recorded', $1, 'RCT-000001', '{}'::jsonb)`,
    [paymentId]
  );
  await run(appUrl, `insert into sharepoint_folder (path) values ('/test')`);
  await run(
    appUrl,
    `insert into audit_event
       (actor_user_id, actor_description, action, entity_type, entity_id)
     values ($1, 'seed', 'test.seeded', 'test', '1')`,
    [userId]
  );
}

const BUSINESS_TABLES = [
  'membership_application',
  'application_party',
  'application_transition',
  'member',
  'account',
  'receipt_number',
  'payment',
  'payment_line',
  'receipt_print',
  'financial_event',
  'sharepoint_folder',
];

async function countsOf(tables: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await run(appUrl, `select count(*)::int as n from ${table}`);
    counts[table] = result.rows[0].n;
  }
  return counts;
}

describe('resetAllTestData', () => {
  it('refuses outside a non-production PUBLIC_APP_ENV, before touching the database', async () => {
    const { resetAllTestData, ResetError } = await load();
    process.env.PUBLIC_APP_ENV = 'production';

    await expect(resetAllTestData(actor)).rejects.toThrow(ResetError);
    await expect(resetAllTestData(actor)).rejects.toThrow(
      /not marked as a test environment/
    );
  });

  it('refuses when PUBLIC_APP_ENV is unset, same as production', async () => {
    const { resetAllTestData } = await load();
    delete process.env.PUBLIC_APP_ENV;

    await expect(resetAllTestData(actor)).rejects.toThrow(
      /not marked as a test environment/
    );
  });

  it('empties every table a member or an application touches', async () => {
    const { resetAllTestData } = await load();
    await seedOneOfEverything();

    const before = await countsOf(BUSINESS_TABLES);
    for (const table of BUSINESS_TABLES) {
      expect(before[table], table).toBeGreaterThan(0);
    }

    await resetAllTestData(actor);

    const after = await countsOf(BUSINESS_TABLES);
    for (const table of BUSINESS_TABLES) {
      expect(after[table], table).toBe(0);
    }
  });

  it('leaves exactly one audit row: the reset itself', async () => {
    const { resetAllTestData } = await load();
    await seedOneOfEverything();

    await resetAllTestData(actor);

    const events = await run(
      appUrl,
      `select actor_description, action, entity_type, entity_id
         from audit_event`
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      actor_description: 'admin@albarakah.mu',
      action: 'system.data_reset',
      entity_type: 'database',
      entity_id: 'all',
    });
  });

  it('leaves staff accounts, roles and reference configuration untouched', async () => {
    const { resetAllTestData } = await load();
    await seedOneOfEverything();

    const before = await run(
      appUrl,
      `select
         (select count(*)::int from app_user) as users,
         (select count(*)::int from role) as roles,
         (select count(*)::int from permission) as permissions,
         (select count(*)::int from membership_type) as membership_types`
    );

    await resetAllTestData(actor);

    const after = await run(
      appUrl,
      `select
         (select count(*)::int from app_user) as users,
         (select count(*)::int from role) as roles,
         (select count(*)::int from permission) as permissions,
         (select count(*)::int from membership_type) as membership_types`
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('does not reopen the guard for an ordinary delete afterwards', async () => {
    const { resetAllTestData } = await load();
    await seedOneOfEverything();
    await resetAllTestData(actor);

    // Seed one transition row directly and confirm the guard that made
    // reset_all_test_data() necessary in the first place still holds once
    // the reset's own transaction has ended.
    const application = await run(
      appUrl,
      `insert into membership_application
         (membership_type_id, captured_by, status)
       values ($1, $2, 'draft')
       returning id`,
      [membershipTypeId, userId]
    );
    await run(
      appUrl,
      `insert into application_transition
         (application_id, from_status, to_status, actor_user_id)
       values ($1, 'draft', 'new', $2)`,
      [application.rows[0].id, userId]
    );

    await expect(
      run(appUrl, 'delete from application_transition')
    ).rejects.toThrow(/append-only/);
  });
});
