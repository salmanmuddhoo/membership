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

const dbName = `ratelimit_test_${Date.now()}`;
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

async function load(env: Record<string, string> = {}) {
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  delete process.env.RATE_LIMIT_DISABLED;
  Object.assign(process.env, env);
  return import('./rate-limit');
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);
}, 30_000);

afterAll(async () => {
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('checkRateLimit (S-111)', () => {
  it('allows requests up to the limit, then refuses', async () => {
    const { checkRateLimit } = await load({ RATE_LIMIT_MAX_REQUESTS: '3' });
    const subject = `user-${Math.random()}`;

    expect((await checkRateLimit(subject, 'c')).allowed).toBe(true);
    expect((await checkRateLimit(subject, 'c')).allowed).toBe(true);
    const third = await checkRateLimit(subject, 'c');
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    const fourth = await checkRateLimit(subject, 'c');
    expect(fourth.allowed).toBe(false);
    // So the caller knows when to come back rather than hammering.
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts each subject separately', async () => {
    const { checkRateLimit } = await load({ RATE_LIMIT_MAX_REQUESTS: '1' });
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;

    expect((await checkRateLimit(a, 'c')).allowed).toBe(true);
    expect((await checkRateLimit(a, 'c')).allowed).toBe(false);
    // One caller exhausting their allowance must not affect anyone else.
    expect((await checkRateLimit(b, 'c')).allowed).toBe(true);
  });

  it('shares the count across callers, not per process', async () => {
    // The point of keeping this in the database: two "instances" resolving the
    // limiter independently still see one another's requests.
    const first = await load({ RATE_LIMIT_MAX_REQUESTS: '2' });
    const subject = `shared-${Math.random()}`;
    expect((await first.checkRateLimit(subject, 'c')).allowed).toBe(true);

    const second = await load({ RATE_LIMIT_MAX_REQUESTS: '2' });
    expect((await second.checkRateLimit(subject, 'c')).allowed).toBe(true);

    const third = await load({ RATE_LIMIT_MAX_REQUESTS: '2' });
    expect((await third.checkRateLimit(subject, 'c')).allowed).toBe(false);
  });

  it('counts concurrent requests without losing any', async () => {
    // A read-then-write limiter would let simultaneous requests both see the
    // same count and both pass. The increment is one statement precisely so
    // that cannot happen.
    const { checkRateLimit } = await load({ RATE_LIMIT_MAX_REQUESTS: '5' });
    const subject = `concurrent-${Math.random()}`;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => checkRateLimit(subject, 'c'))
    );

    expect(results.filter(r => r.allowed)).toHaveLength(5);
    expect(results.filter(r => !r.allowed)).toHaveLength(5);
  });

  it('can be switched off entirely for local work', async () => {
    const { checkRateLimit } = await load({
      RATE_LIMIT_MAX_REQUESTS: '1',
      RATE_LIMIT_DISABLED: 'true',
    });
    const subject = `off-${Math.random()}`;

    expect((await checkRateLimit(subject, 'c')).allowed).toBe(true);
    expect((await checkRateLimit(subject, 'c')).allowed).toBe(true);
  });

  it('ignores a nonsense limit rather than locking everyone out', async () => {
    const { checkRateLimit } = await load({ RATE_LIMIT_MAX_REQUESTS: 'lots' });
    const subject = `bad-config-${Math.random()}`;

    // Falls back to the default rather than treating the limit as zero.
    expect((await checkRateLimit(subject, 'c')).allowed).toBe(true);
  });

  it('fails open, loudly, when the counter is unavailable', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    // Point at a database that is not listening.
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/db';
    process.env.DATABASE_ALLOW_INSECURE = 'true';
    process.env.PUBLIC_APP_ENV = 'test';
    delete process.env.RATE_LIMIT_DISABLED;
    const { checkRateLimit } = await import('./rate-limit');

    try {
      // The limiter slows abuse; it is not the access control, and the request
      // has already been authenticated and authorised. Failing closed here
      // would take the API down to guard something already permitted.
      const result = await checkRateLimit('someone', 'c');
      expect(result.allowed).toBe(true);
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
