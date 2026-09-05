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
// Type-only: the modules themselves are imported dynamically per test so each
// gets a fresh registry, but a dynamic import's binding is a value, not a
// namespace, so the type has to come from a static import.
import type { SweepCheckpoint } from './chunked-sweep';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `jobs_test_${Date.now()}`;
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

// The pool the last load() built.
//
// Each load() calls vi.resetModules(), which builds a NEW pool on the next
// import. The one it replaces has to be given back: an abandoned pool holds
// its connections until they idle out, and a suite that loads this often then
// exhausts the server's connection slots — which fails as
// "remaining connection slots are reserved", far from the test that caused it.
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
  return {
    runner: await import('./runner'),
    sweep: await import('./chunked-sweep'),
  };
}

// Every app_user row the sweep will see: the 250 seeded below plus whatever
// the migrations themselves create.
let totalUsers = 250;

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  // 250 users, so a chunk size of 100 needs three chunks and the last is short.
  const values = Array.from(
    { length: 250 },
    (_, i) => `('user${i}@albarakah.mu', 'User ${i}')`
  ).join(',');
  await run(
    appUrl,
    `insert into app_user (email, display_name) values ${values}`
  );
  // The migrations seed users of their own (the member-app system user,
  // migration 0039), and the sweep walks them too.
  const counted = await run(appUrl, 'select count(*)::int as n from app_user');
  totalUsers = counted.rows[0].n;
}, 60_000);

afterAll(async () => {
  // Before the drop, so the last pool's connections are handed back rather
  // than terminated out from under it.
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('runJob: one at a time', () => {
  it('refuses to start a second copy of the same job', async () => {
    const { runner } = await load();
    let releaseFirst: () => void = () => {};
    const firstReachedWork = new Promise<void>(resolve => {
      const held = new Promise<void>(r => {
        releaseFirst = r;
      });
      void runner
        .runJob({
          name: 'exclusive-test',
          run: async () => {
            resolve();
            await held;
          },
        })
        .catch(() => {});
    });

    await firstReachedWork;

    try {
      // Two dormancy sweeps running together would each read the same members
      // and each write the same changes.
      await expect(
        runner.runJob({ name: 'exclusive-test', run: async () => {} })
      ).rejects.toBeInstanceOf(runner.JobAlreadyRunning);
    } finally {
      releaseFirst();
    }
  }, 20_000);

  it('lets a different job run at the same time', async () => {
    const { runner } = await load();
    let release: () => void = () => {};
    const held = new Promise<void>(r => {
      release = r;
    });
    const first = runner.runJob({
      name: 'job-a',
      run: async () => {
        await held;
      },
    });

    // The lock is per job name, not global.
    const second = await runner.runJob({ name: 'job-b', run: async () => {} });
    expect(second.status).toBe('succeeded');

    release();
    await first;
  }, 20_000);
});

describe('runJob: resumes rather than restarts', () => {
  it('continues an interrupted run from its checkpoint', async () => {
    const { runner, sweep } = await load();
    const seenFirst: string[] = [];

    // First attempt: stop after two chunks, as an eviction would.
    let chunks = 0;
    let stop = false;
    const controller = new AbortController();

    const first = await runner.runJob<SweepCheckpoint>(
      {
        name: 'resume-test',
        run: context =>
          sweep.runChunkedSweep(context, {
            chunkSize: 100,
            processChunk: async ids => {
              seenFirst.push(...ids);
              chunks += 1;
              if (chunks === 2 && !stop) {
                stop = true;
                controller.abort();
              }
            },
          }),
      },
      { signal: controller.signal }
    );

    expect(first.status).toBe('stopped');
    expect(first.processedCount).toBe(200);

    // The run stays open so the next start finds it.
    const open = await run(
      appUrl,
      `select status, attempt, processed_count from job_run
        where job_name = 'resume-test'`
    );
    expect(open.rows[0].status).toBe('running');

    // Second attempt: must continue, not start again.
    const seenSecond: string[] = [];
    const second = await runner.runJob<SweepCheckpoint>({
      name: 'resume-test',
      run: context =>
        sweep.runChunkedSweep(context, {
          chunkSize: 100,
          processChunk: async ids => {
            seenSecond.push(...ids);
          },
        }),
    });

    expect(second.status).toBe('succeeded');
    expect(second.attempt).toBe(2);
    // Every user, 200 done before the stop.
    expect(second.processedCount).toBe(totalUsers);

    // The point: the second attempt did NOT redo the first 200.
    expect(seenSecond).toHaveLength(totalUsers - 200);
    const overlap = seenSecond.filter(id => seenFirst.includes(id));
    expect(overlap).toHaveLength(0);

    // And no member was missed: the two attempts together cover everyone once.
    expect(new Set([...seenFirst, ...seenSecond]).size).toBe(totalUsers);
  }, 30_000);
});

describe('runJob: records what happened', () => {
  it('marks a failed run and keeps the message for an operator', async () => {
    const { runner } = await load();

    const result = await runner.runJob({
      name: 'failing-test',
      run: async () => {
        throw new Error('the legacy extract was malformed');
      },
    });

    expect(result.status).toBe('failed');

    const row = await run(
      appUrl,
      `select status, error, finished_at from job_run where job_name = 'failing-test'`
    );
    expect(row.rows[0].status).toBe('failed');
    expect(row.rows[0].error).toContain('the legacy extract was malformed');
    expect(row.rows[0].finished_at).not.toBeNull();
  }, 20_000);

  it('marks a successful run finished', async () => {
    const { runner } = await load();
    const result = await runner.runJob({
      name: 'succeeding-test',
      run: async () => {},
    });

    expect(result.status).toBe('succeeded');
    const row = await run(
      appUrl,
      `select status, finished_at, error from job_run where job_name = 'succeeding-test'`
    );
    expect(row.rows[0].status).toBe('succeeded');
    expect(row.rows[0].finished_at).not.toBeNull();
    expect(row.rows[0].error).toBeNull();
  }, 20_000);
});

describe('chunked sweep', () => {
  it('walks every row exactly once, in chunks', async () => {
    const { runner, sweep } = await load();
    const seen: string[] = [];

    const result = await runner.runJob<SweepCheckpoint>({
      name: 'walk-test',
      run: context =>
        sweep.runChunkedSweep(context, {
          chunkSize: 60,
          processChunk: async ids => {
            seen.push(...ids);
          },
        }),
    });

    expect(result.processedCount).toBe(totalUsers);
    expect(seen).toHaveLength(totalUsers);
    // Keyset pagination, so no row is repeated even though the set is large.
    expect(new Set(seen).size).toBe(totalUsers);
  }, 30_000);

  it('is not disturbed by rows inserted while it runs', async () => {
    // OFFSET pagination would silently skip or repeat members here. Keyset
    // pagination by id means a row inserted behind the cursor is simply not in
    // this sweep, which is correct and predictable.
    const { runner, sweep } = await load();
    const seen: string[] = [];

    const result = await runner.runJob<SweepCheckpoint>({
      name: 'insert-during-test',
      run: context =>
        sweep.runChunkedSweep(context, {
          chunkSize: 50,
          processChunk: async ids => {
            seen.push(...ids);
            if (seen.length === 50) {
              await run(
                appUrl,
                `insert into app_user (email, display_name)
                 values ('late@albarakah.mu', 'Late Arrival')`
              );
            }
          },
        }),
    });

    // Every id seen is distinct — the insert did not cause a repeat.
    expect(new Set(seen).size).toBe(seen.length);
    expect(result.status).toBe('succeeded');
  }, 30_000);
});
