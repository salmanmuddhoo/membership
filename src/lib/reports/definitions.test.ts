// The Applications report (S-905/S-906/S-907 follow-up): who applied and
// where the application currently sits, read the same way the Applications
// list page reads it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../scripts/migrate';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `reports_applications_test_${Date.now()}`;
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

async function load() {
  // db/pool's own pool is a module-level singleton, shared with whatever
  // else in this file last pointed it at a database (the transactions
  // report's own fixture, below) — closed unconditionally, not only when
  // this describe's own last-seen reference says one is open, so the next
  // query always opens fresh against DATABASE_URL as just set.
  openPool = await import('../db/pool');
  await openPool.closePool();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  return { reports: await import('./definitions') };
}

let officerId: string;
let individualTypeId: string;
let corporateTypeId: string;

// With the Secretary (default chain, migration 0011): capture takes a draft
// to 'new', and the Secretary acts on 'new' directly.
let withSecretary: string; // individual, status 'new'
// Nothing waits on an approved application any more — it is a member from
// here on, not a row this report's "With" column still names anyone against.
let approvedCorporate: string;
// No party captured at all, sent back for correction.
let returnedNoParty: string;

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('test-officer', 'officer@albarakah.mu', 'Officer')
     returning id`
  );
  officerId = user.rows[0].id;

  const types = await run(
    appUrl,
    `select code, id from membership_type where code in ('individual', 'corporate')`
  );
  individualTypeId = types.rows.find(r => r.code === 'individual')!.id;
  corporateTypeId = types.rows.find(r => r.code === 'corporate')!.id;

  const app1 = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'new') returning id`,
    [individualTypeId, officerId]
  );
  withSecretary = app1.rows[0].id;
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb)`,
    [withSecretary, JSON.stringify({ name: 'John', surname: 'Doe' })]
  );

  const app2 = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [corporateTypeId, officerId]
  );
  approvedCorporate = app2.rows[0].id;
  // A corporate applicant's whole name is captured under 'name' alone — no
  // 'surname' field exists for that type (migration 0010) — so the same
  // trim(name || ' ' || surname) the report shares with the Members report
  // already reads it correctly.
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, $2::jsonb)`,
    [approvedCorporate, JSON.stringify({ name: 'Al Barakah Trading Ltd' })]
  );

  const app3 = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'returned') returning id`,
    [individualTypeId, officerId]
  );
  returnedNoParty = app3.rows[0].id;
  await run(
    appUrl,
    `insert into application_transition
       (application_id, from_status, to_status, actor_user_id, actor_role)
     values ($1, 'new', 'returned', $2, 'Regional Manager')`,
    [returnedNoParty, officerId]
  );
}, 60_000);

afterAll(async () => {
  if (openPool) await openPool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('applications report', () => {
  it('names the applicant, the human status, and where it currently sits', async () => {
    const { reports } = await load();
    const report = reports.reportByCode('applications')!;
    const result = await report.run({});

    const byId = new Map(result.rows.map(r => [r.Reference as string, r]));
    // Reference isn't known ahead of the insert (it's generated), so match
    // rows by the fields the test itself set instead.
    const john = result.rows.find(r => r.Applicant === 'John Doe')!;
    expect(john.Status).toBe('New');
    expect(john.With).toBe('With the Secretary');

    const corporate = result.rows.find(
      r => r.Applicant === 'Al Barakah Trading Ltd'
    )!;
    expect(corporate.Status).toBe('Approved');
    expect(corporate.With).toBe('');

    const returned = result.rows.find(
      r => r.Status === 'Returned for Correction'
    )!;
    expect(returned.Applicant).toBe('');
    expect(returned.With).toBe('Returned by the Regional Manager');

    expect(byId.size).toBeGreaterThan(0); // rows are keyed by Reference
  });

  it('filters by where an application stands, with Approved offered although the Applications list omits it', async () => {
    const { reports } = await load();
    const report = reports.reportByCode('applications')!;
    const statusFilter = report.filters.find(f => f.name === 'status')!;
    expect(statusFilter.kind).toBe('choice');
    const choices = await statusFilter.choices!();
    expect(choices).toContainEqual({ value: 'approved', label: 'Approved' });
    // Officer feedback: a stage per step of the chain in place of the raw
    // 'new' / 'submitted_for_approval', which say nothing about who holds it.
    expect(choices).toContainEqual({
      value: 'with:secretary_review',
      label: 'With the Secretary',
    });
    expect(choices.map(c => c.value)).not.toContain('new');
    expect(choices.map(c => c.value)).not.toContain('submitted_for_review');

    const onlyApproved = await report.run({ status: 'approved' });
    expect(onlyApproved.rows.map(r => r.Applicant)).toEqual([
      'Al Barakah Trading Ltd',
    ]);
    const withSecretary = await report.run({ status: 'with:secretary_review' });
    expect(withSecretary.rows.map(r => r.Applicant)).toEqual(['John Doe']);
    const withRegional = await report.run({ status: 'with:regional_review' });
    expect(withRegional.rows).toEqual([]);
  });
});

// A separate database: one withdrawal on its chain, at the Secretary step,
// is enough to show the Status column reads where it is and the filter
// finds it by role.
describe('transactions report', () => {
  const txDbName = `reports_transactions_test_${Date.now()}`;
  const txOwnerUrl = `postgresql://postgres@127.0.0.1:5433/${txDbName}`;
  const txAppUrl = `postgresql://albarakah_app:devpassword@127.0.0.1:5433/${txDbName}`;

  let txPool: typeof import('../db/pool') | null = null;
  async function loadTx() {
    // See load()'s own comment: closed unconditionally, since the pool this
    // reaches may be the applications describe's, not this one's.
    txPool = await import('../db/pool');
    await txPool.closePool();
    process.env.DATABASE_URL = txAppUrl;
    process.env.DATABASE_ALLOW_INSECURE = 'true';
    process.env.PUBLIC_APP_ENV = 'test';
    return { reports: await import('./definitions') };
  }

  let atSecretaryReference: string;

  beforeAll(async () => {
    await run(ADMIN_URL, `create database ${txDbName}`);
    await run(txOwnerUrl, 'revoke all on schema public from public');
    await run(
      txOwnerUrl,
      `grant connect on database ${txDbName} to albarakah_app`
    );
    await migrate(txOwnerUrl, MIGRATIONS_DIR);

    const user = await run(
      txAppUrl,
      `insert into app_user (entra_subject, email, display_name)
       values ('test-officer-tx', 'officer-tx@albarakah.mu', 'Officer')
       returning id`
    );
    const txOfficerId = user.rows[0].id;

    const membershipTypeId = (
      await run(
        txAppUrl,
        `select id from membership_type where code = 'individual'`
      )
    ).rows[0].id;
    const msaTypeId = (
      await run(txAppUrl, `select id from account_type where code = 'msa'`)
    ).rows[0].id;
    // The default chain every transaction kind is seeded with (migration
    // 0070): Secretary review, then President decision.
    const withdrawalDefinitionId = (
      await run(
        txAppUrl,
        `select id from workflow_definition where code = 'transaction_withdrawal'`
      )
    ).rows[0].id;

    const application = await run(
      txAppUrl,
      `insert into membership_application (membership_type_id, captured_by, status)
       values ($1, $2, 'approved') returning id`,
      [membershipTypeId, txOfficerId]
    );
    const member = await run(
      txAppUrl,
      `insert into member (application_id, membership_type_id)
       values ($1, $2) returning id`,
      [application.rows[0].id, membershipTypeId]
    );
    const memberId = member.rows[0].id;
    const accountId = (
      await run(
        txAppUrl,
        `insert into account (member_id, account_type_id, is_membership_default)
         values ($1, $2, true) returning id`,
        [memberId, msaTypeId]
      )
    ).rows[0].id;

    const transaction = await run(
      txAppUrl,
      `insert into transaction
         (kind, member_id, account_id, amount, method, status, captured_by,
          workflow_definition_id, current_step_code)
       values ('withdrawal', $1, $2, 500, 'cash', 'submitted', $3, $4,
               'secretary_review')
       returning reference`,
      [memberId, accountId, txOfficerId, withdrawalDefinitionId]
    );
    atSecretaryReference = transaction.rows[0].reference;
  }, 60_000);

  afterAll(async () => {
    if (txPool) await txPool.closePool();
    await run(ADMIN_URL, `drop database if exists ${txDbName} with (force)`);
  });

  it('reads Status as where the transaction is now, not its bare workflow status', async () => {
    const { reports } = await loadTx();
    const report = reports.reportByCode('transactions')!;
    const result = await report.run({});
    const row = result.rows.find(r => r.Reference === atSecretaryReference)!;
    expect(row.Status).toBe('With Secretary');
  });

  it('offers a Status choice per role on a transaction chain, and finds one by it', async () => {
    const { reports } = await loadTx();
    const report = reports.reportByCode('transactions')!;
    const statusFilter = report.filters.find(f => f.name === 'status')!;
    expect(statusFilter.kind).toBe('choice');
    const choices = await statusFilter.choices!();
    expect(choices).toContainEqual({
      value: 'with:secretary',
      label: 'With Secretary',
    });
    expect(choices).toContainEqual({
      value: 'with:president',
      label: 'With President / Chairperson',
    });
    expect(choices).toContainEqual({ value: 'approved', label: 'To disburse' });
    expect(choices).toContainEqual({ value: 'returned', label: 'Returned' });
    expect(choices).toContainEqual({
      value: 'done',
      label: 'Posted or disbursed',
    });
    expect(choices).toContainEqual({ value: 'rejected', label: 'Rejected' });
    expect(choices).toContainEqual({ value: 'cancelled', label: 'Cancelled' });

    const atSecretary = await report.run({ status: 'with:secretary' });
    expect(atSecretary.rows.map(r => r.Reference)).toEqual([
      atSecretaryReference,
    ]);
    const atPresident = await report.run({ status: 'with:president' });
    expect(atPresident.rows).toEqual([]);
  });
});
