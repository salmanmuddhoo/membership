import { afterEach, describe, expect, it, vi } from 'vitest';

// A local cluster is started by scripts/dev-db.sh; these tests use it as a real
// server rather than mocking the driver, since the behaviour under test is the
// driver's failure handling.
const LOCAL_URL =
  'postgresql://albarakah_app:devpassword@127.0.0.1:5433/albarakah';

async function loadPool(url: string) {
  vi.resetModules();
  process.env.DATABASE_URL = url;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  return import('./pool');
}

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe('query', () => {
  it('runs a statement against the pool', async () => {
    const { query, closePool } = await loadPool(LOCAL_URL);
    try {
      const result = await query<{ answer: number }>('select 1 as answer');
      expect(result.rows[0].answer).toBe(1);
    } finally {
      await closePool();
    }
  });

  it('passes parameters rather than interpolating them', async () => {
    const { query, closePool } = await loadPool(LOCAL_URL);
    try {
      // A value that would break out of a naively interpolated string.
      const hostile = "'; drop table members; --";
      const result = await query<{ echoed: string }>(
        'select $1::text as echoed',
        [hostile]
      );
      expect(result.rows[0].echoed).toBe(hostile);
    } finally {
      await closePool();
    }
  });

  it('reports an unreachable database safely and logs the cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Port 1 is reserved and never listening.
    const { query, closePool, DatabaseUnavailableError } = await loadPool(
      'postgresql://u:p@127.0.0.1:1/db'
    );

    try {
      await expect(query('select 1')).rejects.toBeInstanceOf(
        DatabaseUnavailableError
      );

      // S-101: the caller gets a non-technical message...
      await expect(query('select 1')).rejects.toThrowError(
        'The database is unavailable.'
      );
      // ...while the real cause is kept server-side.
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      await closePool();
    }
  });

  it('fails clearly when the environment has no database configured', async () => {
    vi.resetModules();
    delete process.env.DATABASE_URL;
    const { getPool } = await import('./pool');

    expect(() => getPool()).toThrowError(/DATABASE_URL is not set/);
  });
});

describe('withTransaction', () => {
  // The application role deliberately has no CREATE on schema public — DDL is
  // the migration runner's job, not the app's. Temporary tables are session
  // scoped, so these tests pin the pool to a single connection to make sure the
  // setup and the assertions see the same session.
  async function loadSingleConnectionPool() {
    process.env.DATABASE_POOL_MAX = '1';
    return loadPool(LOCAL_URL);
  }

  it('commits when the callback succeeds', async () => {
    const { withTransaction, query, closePool } =
      await loadSingleConnectionPool();
    try {
      await query('create temporary table t_commit (v int primary key)');

      await withTransaction(async client => {
        await client.query('insert into t_commit values (1), (2)');
      });

      const result = await query<{ count: string }>(
        'select count(*)::text as count from t_commit'
      );
      expect(result.rows[0].count).toBe('2');
    } finally {
      await closePool();
    }
  });

  it('rolls back and re-throws the original error', async () => {
    const { withTransaction, query, closePool } =
      await loadSingleConnectionPool();
    try {
      await query('create temporary table t_rollback (v int primary key)');

      await expect(
        withTransaction(async client => {
          await client.query('insert into t_rollback values (1)');
          // The failure surfaces after a write has already happened, which is
          // the case that matters: a change and its audit entry must not be
          // able to land separately.
          throw new Error('business rule failed');
        })
      ).rejects.toThrowError('business rule failed');

      const result = await query<{ count: string }>(
        'select count(*)::text as count from t_rollback'
      );
      expect(result.rows[0].count).toBe('0');
    } finally {
      await closePool();
    }
  });

  it('rolls back when the database rejects the write', async () => {
    const { withTransaction, query, closePool } =
      await loadSingleConnectionPool();
    try {
      await query('create temporary table t_constraint (v int primary key)');
      await query('insert into t_constraint values (1)');

      await expect(
        withTransaction(async client => {
          await client.query('insert into t_constraint values (2)');
          // Violates the primary key.
          await client.query('insert into t_constraint values (1)');
        })
      ).rejects.toThrowError(/duplicate key/);

      // The first insert in the transaction must not have survived either.
      const result = await query<{ count: string }>(
        'select count(*)::text as count from t_constraint'
      );
      expect(result.rows[0].count).toBe('1');
    } finally {
      await closePool();
    }
  });
});
