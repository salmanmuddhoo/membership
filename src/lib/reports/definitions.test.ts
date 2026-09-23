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
  if (openPool) await openPool.closePool();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  openPool = await import('../db/pool');
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

  it('filters status as a choice, with Approved offered although the Applications list omits it', async () => {
    const { reports } = await load();
    const report = reports.reportByCode('applications')!;
    const statusFilter = report.filters.find(f => f.name === 'status')!;
    expect(statusFilter.kind).toBe('choice');
    const choices = await statusFilter.choices!();
    expect(choices).toContainEqual({ value: 'approved', label: 'Approved' });
    expect(choices).toContainEqual({ value: 'new', label: 'New' });

    const onlyApproved = await report.run({ status: 'approved' });
    expect(onlyApproved.rows.map(r => r.Applicant)).toEqual([
      'Al Barakah Trading Ltd',
    ]);
  });
});
