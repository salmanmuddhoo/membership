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

// Every table in the schema is on exactly one of these two lists, and the
// test below fails when one is added to neither: whoever adds a table decides
// whether "Reset test data" clears it (it records activity) or keeps it (it
// is how the system is set up). Officer request: the reset leaves a fresh
// database, configuration aside.
const CLEARED_TABLES = [
  'account',
  'account_balance',
  'account_entry',
  'account_number_counter',
  'application_account_selection',
  'application_checklist_item',
  'application_party',
  'application_step_signoff',
  'application_transition',
  'audit_event',
  'cash_session',
  'config_entry_history',
  'customer',
  'document',
  'document_version',
  'financial_event',
  'job_run',
  'member',
  'member_details_request',
  'member_login_challenge',
  'member_session',
  'membership_application',
  'notification',
  'payment',
  'payment_account_line',
  'payment_line',
  'rate_limit_window',
  'receipt_number',
  'receipt_print',
  'sharepoint_folder',
  'transaction',
  'transaction_transition',
  'transfer',
];

// app_user and user_role keep one account: the System Administrator running
// the reset, with their roles (see the test below).
const KEPT_TABLES = [
  'account_type',
  'account_type_membership_type',
  'api_credential',
  'app_user',
  'approval_rule',
  'bank_account',
  'config_entry',
  'document_checklist',
  'document_checklist_item',
  'document_type',
  'fee_component',
  'fee_schedule',
  'fee_schedule_version',
  'membership_type',
  'membership_type_field',
  'notification_template',
  'payment_method',
  'permission',
  'retention_policy',
  'role',
  'role_permission',
  'schema_migrations',
  'segregation_rule',
  'user_role',
  'workflow_definition',
  'workflow_status',
  'workflow_step',
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

  // Officer feedback: numbering used to survive a reset untouched, so a
  // fresh test member still came out AB0047, not AB0001. Test-only — the
  // production caution (a number is on a member's card) does not apply to
  // a database this refuses to run against outside PUBLIC_APP_ENV != production.
  it('restarts every reference-number sequence and counter', async () => {
    const { resetAllTestData } = await load();
    await seedOneOfEverything();
    // A customer account number counter, advanced past its start — the
    // thing this reset must also put back to zero.
    await run(
      appUrl,
      `insert into account_number_counter (account_type_id, next_serial)
       values ($1, 5)`,
      [accountTypeId]
    );

    await resetAllTestData(actor);

    const nextvals = await run(
      appUrl,
      `select nextval('application_reference_seq') as app,
              nextval('member_number_seq') as member,
              nextval('receipt_number_seq') as receipt`
    );
    expect(nextvals.rows[0]).toEqual({ app: '1', member: '1', receipt: '1' });
    // Transactions and transfers number from the start again too.
    const ledgerNumbers = await run(
      ownerUrl,
      `select nextval('transaction_reference_seq') as transaction,
              nextval('transfer_reference_seq') as transfer`
    );
    expect(ledgerNumbers.rows[0]).toEqual({ transaction: '1', transfer: '1' });

    const counters = await run(
      appUrl,
      `select count(*)::int as n from account_number_counter`
    );
    expect(counters.rows[0].n).toBe(0);
  });

  it('clears every message sent', async () => {
    const { resetAllTestData } = await load();
    await run(
      appUrl,
      `insert into notification (event_code, channel, recipient, body)
       values ('receipt.issued', 'email', 'someone@example.com', 'Sent')`
    );
    await resetAllTestData(actor);
    const left = await run(
      appUrl,
      `select count(*)::int as n from notification`
    );
    expect(left.rows[0].n).toBe(0);
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

  // Officer request: staff accounts go too, all but the one running the
  // reset — nobody could sign in to add the others back otherwise.
  it('removes every staff account but the one running the reset, and keeps configuration', async () => {
    const { resetAllTestData } = await load();
    await seedOneOfEverything();
    const admin = await run(
      ownerUrl,
      `insert into user_role (user_id, role_id)
       select $1, id from role where code = 'system_administrator'
       on conflict do nothing`,
      [userId]
    );
    expect(admin.rowCount).toBe(1);
    const other = await run(
      ownerUrl,
      `insert into app_user (email, display_name)
       values ('officer@albarakah.mu', 'Officer')
       returning id`
    );
    const otherId = other.rows[0].id;
    await run(
      ownerUrl,
      `insert into user_role (user_id, role_id, granted_by)
       select $1, id, $1 from role where code = 'system_administrator'`,
      [otherId]
    );
    // A setting last changed by the staff member about to go.
    await run(
      ownerUrl,
      `with actor as (
         select set_config('albarakah.actor_description', 'test', false)
       )
       update notification_template set updated_by = $1
         from actor
        where id = (select id from notification_template limit 1)`,
      [otherId]
    );
    const template = await run(
      ownerUrl,
      `select id, updated_at from notification_template where updated_by = $1`,
      [otherId]
    );

    const configuration = `select
         (select count(*)::int from role) as roles,
         (select count(*)::int from permission) as permissions,
         (select count(*)::int from role_permission) as role_permissions,
         (select count(*)::int from membership_type) as membership_types,
         (select count(*)::int from config_entry) as settings,
         (select count(*)::int from notification_template) as templates,
         (select count(*)::int from fee_schedule_version) as fee_versions`;
    const before = await run(ownerUrl, configuration);

    await resetAllTestData(actor);

    const users = await run(ownerUrl, `select id from app_user`);
    expect(users.rows).toEqual([{ id: userId }]);
    const roles = await run(
      ownerUrl,
      `select r.code from user_role ur join role r on r.id = ur.role_id
        where ur.user_id = $1`,
      [userId]
    );
    expect(roles.rows).toEqual([{ code: 'system_administrator' }]);
    expect((await run(ownerUrl, configuration)).rows[0]).toEqual(
      before.rows[0]
    );
    // The setting stays as it was, only no longer naming who changed it.
    const after = await run(
      ownerUrl,
      `select updated_by, updated_at from notification_template where id = $1`,
      [template.rows[0].id]
    );
    expect(after.rows[0]).toEqual({
      updated_by: null,
      updated_at: template.rows[0].updated_at,
    });
  });

  it('clears the history of setting changes', async () => {
    const { resetAllTestData } = await load();
    await run(
      ownerUrl,
      `set albarakah.actor_description = 'test';
       update config_entry set value = value
        where key = (select key from config_entry limit 1);`
    );
    const before = await run(
      ownerUrl,
      `select count(*)::int as n from config_entry_history`
    );
    expect(before.rows[0].n).toBeGreaterThan(0);

    await resetAllTestData(actor);

    const after = await run(
      ownerUrl,
      `select count(*)::int as n from config_entry_history`
    );
    expect(after.rows[0].n).toBe(0);
  });

  it('refuses without the staff account running it', async () => {
    const { resetAllTestData } = await load();
    await expect(
      resetAllTestData({
        userId: '00000000-0000-0000-0000-000000000000',
        email: 'nobody@albarakah.mu',
      })
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/staff account running it/) },
    });
    const users = await run(
      ownerUrl,
      `select count(*)::int as n from app_user where id = $1`,
      [userId]
    );
    expect(users.rows[0].n).toBe(1);
  });

  it('places every table on the cleared list or the kept list', async () => {
    const tables = await run(
      ownerUrl,
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`
    );
    const all = tables.rows.map(r => r.table_name as string);
    const unplaced = all.filter(
      t => !CLEARED_TABLES.includes(t) && !KEPT_TABLES.includes(t)
    );
    expect(unplaced, 'tables on neither list').toEqual([]);
    const missing = [...CLEARED_TABLES, ...KEPT_TABLES].filter(
      t => !all.includes(t)
    );
    expect(missing, 'listed tables that no longer exist').toEqual([]);
  });

  it('leaves every cleared table empty, the reset itself aside', async () => {
    const { resetAllTestData } = await load();
    await seedOneOfEverything();
    await run(
      ownerUrl,
      `insert into job_run (job_name, status, finished_at)
       values ('dormancy', 'succeeded', now())`
    );

    await resetAllTestData(actor);

    const after = await countsOf(CLEARED_TABLES);
    for (const table of CLEARED_TABLES) {
      expect(after[table], table).toBe(table === 'audit_event' ? 1 : 0);
    }
  });

  it('restarts every numbering sequence but those of kept tables', async () => {
    const { resetAllTestData } = await load();
    // Every sequence outside the kept tables — reference numbers, ledger,
    // audit, job runs, setting history — starts again.
    const sequences = await run(
      ownerUrl,
      `select s.relname as sequence, t.relname as owner
         from pg_class s
         join pg_namespace n on n.oid = s.relnamespace
         left join pg_depend d
           on d.objid = s.oid and d.deptype in ('a', 'i')
          and d.classid = 'pg_class'::regclass
         left join pg_class t on t.oid = d.refobjid
        where s.relkind = 'S' and n.nspname = 'public'`
    );
    const restarted = sequences.rows
      .filter(r => !KEPT_TABLES.includes(r.owner as string))
      .map(r => r.sequence as string);
    expect(restarted.length).toBeGreaterThan(5);
    for (const sequence of restarted) {
      await run(ownerUrl, `select nextval('${sequence}')`);
    }

    await resetAllTestData(actor);

    const values = await run(
      ownerUrl,
      `select sequencename, last_value from pg_sequences
        where schemaname = 'public'`
    );
    const lastValue = new Map(
      values.rows.map(r => [r.sequencename as string, r.last_value])
    );
    for (const sequence of restarted) {
      // The reset writes one audit row of its own, so that one reads 1.
      expect(lastValue.get(sequence), sequence).toBe(
        sequence === 'audit_event_id_seq' ? '1' : null
      );
    }
  });

  it('keeps API credentials but forgets when they were last used', async () => {
    const { resetAllTestData } = await load();
    await run(
      ownerUrl,
      `insert into api_credential
         (name, client_id, secret_hash, scopes, last_used_at, created_by)
       values ('Website', 'website-client', 'hash', '{}', now(), $1)`,
      [userId]
    );

    await resetAllTestData(actor);

    const credentials = await run(
      ownerUrl,
      `select name, last_used_at from api_credential`
    );
    expect(credentials.rows).toEqual([{ name: 'Website', last_used_at: null }]);
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
