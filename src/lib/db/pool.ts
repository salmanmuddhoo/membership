// Pooled PostgreSQL access for serverless request handlers (S-101).
//
// Serverless scales by process, not by thread: every warm instance holds its
// own pool, so the connection count the server sees is poolMax x instances.
// Azure Flexible Server's smaller SKUs cap max_connections in the low tens,
// which is why the per-instance ceiling defaults to 3 and idle connections are
// returned quickly. For sustained load the answer is Azure's built-in PgBouncer
// (port 6432), not a larger pool here — see docs/database.md.
import pg from 'pg';
import { getDatabaseConfig } from '../config';

const { Pool } = pg;

// A driver-level failure we do not want to describe to the caller. The message
// can name the host, the user, or the shape of the network — none of which
// belongs in an HTTP response.
export class DatabaseUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('The database is unavailable.');
    this.name = 'DatabaseUnavailableError';
  }
}

let pool: pg.Pool | undefined;

// Reused across invocations on a warm instance; created on first use so that
// importing this module never opens a socket (and never throws at import time
// in an environment that has no database configured).
export function getPool(): pg.Pool {
  if (pool) return pool;

  const config = getDatabaseConfig();

  pool = new Pool({
    connectionString: config.connectionString,
    max: config.poolMax,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    // Azure terminates TLS with a publicly-chaining certificate, so the default
    // trust store is enough; we only need to insist that it is actually checked.
    // 'disable' means no TLS handshake at all, which is what a local plaintext
    // cluster needs — passing rejectUnauthorized:false would still negotiate
    // TLS and fail against a server that offers none.
    ssl: config.sslMode === 'verify' ? { rejectUnauthorized: true } : false,
  });

  // An idle client can fail between requests (server restart, failover, an idle
  // timeout at the far end). Without a listener that surfaces as an unhandled
  // 'error' event and takes the whole process down.
  pool.on('error', err => {
    console.error('[db] idle client error:', err);
  });

  return pool;
}

// Run a query against the pool. Driver failures are logged in full server-side
// and re-thrown as DatabaseUnavailableError so nothing about the connection
// reaches the caller.
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: readonly unknown[]
): Promise<pg.QueryResult<T>> {
  try {
    return await getPool().query<T>(text, params as unknown[]);
  } catch (err) {
    console.error('[db] query failed:', err);
    throw new DatabaseUnavailableError(err);
  }
}

// Run several statements on one connection inside a transaction, rolling back
// if the callback throws. Use for any write that spans more than one table —
// notably a change plus its audit entry, which must land together.
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await getPool().connect();
  } catch (err) {
    console.error('[db] could not acquire a connection:', err);
    throw new DatabaseUnavailableError(err);
  }

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // A failed ROLLBACK must not mask the error that caused it.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] rollback failed:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

// Close the pool. Used by tests and scripts; serverless instances are frozen
// rather than shut down, so request handlers should not call this.
export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
}
