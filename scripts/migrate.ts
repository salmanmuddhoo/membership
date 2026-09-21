// Forward-only migration runner (S-102).
//
// Deliberately not a migration framework: the schema of a financial system is
// small enough to read, and a runner we can audit in one sitting is worth more
// than features we would not use. Rules:
//
//   * Migrations are plain .sql files in migrations/, applied in filename
//     order, and never edited once merged.
//   * Each runs inside its own transaction, so a failure leaves the database
//     exactly as it was.
//   * What has been applied is recorded in schema_migrations, and a file whose
//     checksum no longer matches what was applied is a hard error rather than
//     a silent divergence.
//   * An advisory lock keeps two concurrent pipeline runs from racing.
//
// Run with:  pnpm migrate        (applies)
//            pnpm migrate:status (reports, changes nothing)
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

// Distinct from any application lock; the value itself is arbitrary but must
// stay stable.
const ADVISORY_LOCK_KEY = 4471921;

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
  appliedAt: Date;
}

export function checksum(sql: string): string {
  // Newlines are normalised so that a checkout with different line endings
  // does not read as a modified migration.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const entries = await readdir(dir);
  const files = entries.filter(f => f.endsWith('.sql')).sort();

  return Promise.all(
    files.map(async name => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      return { name, sql, checksum: checksum(sql) };
    })
  );
}

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      name        text        primary key,
      checksum    text        not null,
      applied_at  timestamptz not null default now()
    )
  `);
}

export async function readApplied(
  client: pg.Client
): Promise<Map<string, AppliedMigration>> {
  const result = await client.query<{
    name: string;
    checksum: string;
    applied_at: Date;
  }>('select name, checksum, applied_at from schema_migrations order by name');

  return new Map(
    result.rows.map(r => [
      r.name,
      { name: r.name, checksum: r.checksum, appliedAt: r.applied_at },
    ])
  );
}

// A migration that was applied and has since been edited means the database and
// the repository disagree about what the schema is. That is never safe to paper
// over, so it stops the run.
function assertUnchanged(
  migrations: Migration[],
  applied: Map<string, AppliedMigration>
): void {
  for (const migration of migrations) {
    const record = applied.get(migration.name);
    if (record && record.checksum !== migration.checksum) {
      throw new Error(
        `Migration ${migration.name} has changed since it was applied ` +
          `(recorded ${record.checksum.slice(0, 12)}, ` +
          `file ${migration.checksum.slice(0, 12)}). Migrations are ` +
          'forward-only: add a new migration instead of editing this one.'
      );
    }
  }

  // A migration recorded in the database but missing from the repository means
  // the checkout is older than the database, which would silently "re-apply"
  // history if we carried on.
  const known = new Set(migrations.map(m => m.name));
  for (const name of applied.keys()) {
    if (!known.has(name)) {
      throw new Error(
        `Migration ${name} is recorded as applied but is not in the ` +
          'migrations directory. Deploying an older revision over a newer ' +
          'database is not supported.'
      );
    }
  }
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(
  connectionString: string,
  dir: string,
  options: { ssl?: pg.ClientConfig['ssl']; log?: (msg: string) => void } = {}
): Promise<MigrateResult> {
  const log = options.log ?? (() => {});
  const migrations = await loadMigrations(dir);

  const client = new Client({ connectionString, ssl: options.ssl ?? false });
  await client.connect();

  const result: MigrateResult = { applied: [], skipped: [] };

  try {
    // Serialise concurrent runs; released automatically when the session ends.
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await ensureMigrationsTable(client);

    const applied = await readApplied(client);
    assertUnchanged(migrations, applied);

    for (const migration of migrations) {
      if (applied.has(migration.name)) {
        result.skipped.push(migration.name);
        continue;
      }

      log(`applying ${migration.name}`);

      // One transaction per migration: a failure rolls back that migration
      // whole, and migrations already applied in this run stay applied.
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'insert into schema_migrations (name, checksum) values ($1, $2)',
          [migration.name, migration.checksum]
        );
        await client.query('COMMIT');
        result.applied.push(migration.name);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(
          `Migration ${migration.name} failed and was rolled back: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }

    return result;
  } finally {
    await client
      .query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
      .catch(() => {});
    await client.end();
  }
}

export async function status(
  connectionString: string,
  dir: string,
  options: { ssl?: pg.ClientConfig['ssl'] } = {}
): Promise<{ name: string; applied: boolean }[]> {
  const migrations = await loadMigrations(dir);
  const client = new Client({ connectionString, ssl: options.ssl ?? false });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await readApplied(client);
    return migrations.map(m => ({
      name: m.name,
      applied: applied.has(m.name),
    }));
  } finally {
    await client.end();
  }
}
