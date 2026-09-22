import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../scripts/migrate';

// The job that watches the jobs: what on job_run counts as a concern, who
// is told, and — the part worth a database — that a run is written about
// once, however many times the watcher looks at it.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `job_watch_test_${Date.now()}`;
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

process.env.DATABASE_URL = appUrl;
process.env.DATABASE_ALLOW_INSECURE = 'true';
process.env.PUBLIC_APP_ENV = 'test';
process.env.NOTIFY_EMAIL_DELIVERY = 'log';
delete process.env.NOTIFY_WHATSAPP_DELIVERY;

const watch = await import('./watch');
const pool = await import('../db/pool');

const NOW = new Date('2026-09-22T09:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const runs: Record<string, string> = {};

async function jobRun(
  jobName: string,
  status: 'running' | 'succeeded' | 'failed',
  startedHoursAgo: number,
  updatedHoursAgo: number = startedHoursAgo,
  error: string | null = null
) {
  const finished = status === 'running' ? null : hoursAgo(updatedHoursAgo);
  const row = await run(
    appUrl,
    `insert into job_run
       (job_name, status, started_at, updated_at, finished_at, error)
     values ($1, $2, $3, $4, $5, $6) returning id::text`,
    [
      jobName,
      status,
      hoursAgo(startedHoursAgo),
      hoursAgo(updatedHoursAgo),
      finished,
      error,
    ]
  );
  return row.rows[0].id as string;
}

async function told() {
  const result = await run(
    appUrl,
    `select event_code, entity_id, recipient
       from notification
      where entity_type = 'job_run'
      order by entity_id, event_code, recipient`
  );
  return result.rows;
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  // Two administrators, one of them deactivated; one officer who is not.
  await run(
    appUrl,
    `with users as (
       insert into app_user
         (entra_subject, email, display_name, is_active, deactivated_at)
       values ('admin-1', 'admin@albarakah.mu', 'Admin One', true, null),
              ('admin-2', 'gone@albarakah.mu', 'Admin Gone', false, now()),
              ('officer', 'officer@albarakah.mu', 'Officer', true, null)
       returning id, email::text as email
     )
     insert into user_role (user_id, role_id)
     select u.id, r.id from users u
       join role r on r.code = case when u.email like 'admin%' or u.email like 'gone%'
                                    then 'system_administrator'
                                    else 'account_officer' end`
  );

  // Stalled: open for seven hours, nothing written for seven hours.
  runs.stalled = await jobRun('dormancy-detection', 'running', 7);
  // Live: open, but written to an hour ago.
  runs.live = await jobRun('retention-disposal', 'running', 9, 1);
  // Failed and nothing since.
  runs.failed = await jobRun(
    'ledger-verify',
    'failed',
    3,
    3,
    'connection refused'
  );
  // Failed, then succeeded: not a concern.
  await jobRun('document-expiry', 'failed', 30, 30, 'timeout');
  await jobRun('document-expiry', 'succeeded', 5, 5);
}, 60_000);

afterAll(async () => {
  await pool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('what the watcher finds', () => {
  it('a run left open for hours, and a job whose last run failed — nothing else', async () => {
    const concerns = await watch.findJobConcerns(NOW);
    expect(concerns.map(c => [c.jobName, c.kind, c.runId])).toEqual([
      ['dormancy-detection', 'stalled', runs.stalled],
      ['ledger-verify', 'failed', runs.failed],
    ]);
    expect(concerns[1].error).toBe('connection refused');
  });
});

describe('who is told, and how often', () => {
  it('every active System Administrator, once per run', async () => {
    const first = await watch.watchJobs(NOW);
    expect(first.reported).toBe(2);
    expect(await told()).toEqual([
      {
        event_code: 'job.stalled',
        entity_id: runs.stalled,
        recipient: 'admin@albarakah.mu',
      },
      {
        event_code: 'job.failed',
        entity_id: runs.failed,
        recipient: 'admin@albarakah.mu',
      },
    ]);

    // Looking again finds the same two and says nothing new.
    const again = await watch.watchJobs(new Date(NOW.getTime() + 3_600_000));
    expect(again.concerns).toHaveLength(2);
    expect(again.reported).toBe(0);
    expect(await told()).toHaveLength(2);
  });

  it('a stalled run that resumes and then fails is news again, as a failure', async () => {
    await run(
      appUrl,
      `update job_run
          set status = 'failed', attempt = 2, finished_at = $2, updated_at = $2,
              error = 'died again'
        where id = $1::bigint`,
      [runs.stalled, hoursAgo(0)]
    );
    const result = await watch.watchJobs(NOW);
    expect(result.reported).toBe(1);
    expect(await told()).toContainEqual({
      event_code: 'job.failed',
      entity_id: runs.stalled,
      recipient: 'admin@albarakah.mu',
    });
  });
});
