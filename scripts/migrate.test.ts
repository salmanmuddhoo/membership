import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, status, checksum, loadMigrations } from './migrate';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';

// Each test gets its own database so that a failure in one cannot leave state
// behind that changes the outcome of another.
let dbName: string;
let dbUrl: string;
let dir: string;

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_URL, ssl: false });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function queryDb<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl, ssl: false });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

async function writeMigration(name: string, sql: string): Promise<void> {
  await writeFile(path.join(dir, name), sql, 'utf8');
}

beforeEach(async () => {
  dbName = `mig_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin(`create database ${dbName}`);
  dbUrl = `postgresql://postgres@127.0.0.1:5433/${dbName}`;
  dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await admin(`drop database if exists ${dbName} with (force)`);
});

describe('migrate', () => {
  it('applies pending migrations in filename order', async () => {
    await writeMigration('0002_second.sql', 'create table b (id int);');
    await writeMigration('0001_first.sql', 'create table a (id int);');

    const result = await migrate(dbUrl, dir);

    expect(result.applied).toEqual(['0001_first.sql', '0002_second.sql']);
    expect(result.skipped).toEqual([]);
  });

  it('skips already-applied migrations and still succeeds', async () => {
    await writeMigration('0001_first.sql', 'create table a (id int);');
    await migrate(dbUrl, dir);

    // S-102: running the pipeline again must be a successful no-op.
    const second = await migrate(dbUrl, dir);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['0001_first.sql']);
  });

  it('applies only the new migration when one is added', async () => {
    await writeMigration('0001_first.sql', 'create table a (id int);');
    await migrate(dbUrl, dir);

    await writeMigration('0002_second.sql', 'create table b (id int);');
    const result = await migrate(dbUrl, dir);

    expect(result.applied).toEqual(['0002_second.sql']);
    expect(result.skipped).toEqual(['0001_first.sql']);
  });

  it('fails loudly and leaves the database in its prior state', async () => {
    await writeMigration('0001_first.sql', 'create table a (id int);');
    await writeMigration(
      '0002_broken.sql',
      'create table b (id int); this is not sql;'
    );

    await expect(migrate(dbUrl, dir)).rejects.toThrowError(
      /0002_broken\.sql failed and was rolled back/
    );

    // S-102: the failed migration left nothing behind...
    const tables = await queryDb<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename"
    );
    expect(tables.map(t => t.tablename)).toEqual(['a', 'schema_migrations']);

    // ...and is not recorded as applied.
    const applied = await queryDb<{ name: string }>(
      'select name from schema_migrations'
    );
    expect(applied.map(r => r.name)).toEqual(['0001_first.sql']);
  });

  it('refuses to run when an applied migration has been edited', async () => {
    await writeMigration('0001_first.sql', 'create table a (id int);');
    await migrate(dbUrl, dir);

    // Editing an applied migration means the database and the repository no
    // longer agree about what the schema is.
    await writeMigration('0001_first.sql', 'create table a (id bigint);');

    await expect(migrate(dbUrl, dir)).rejects.toThrowError(
      /has changed since it was applied/
    );
  });

  it('refuses to run against a database ahead of the checkout', async () => {
    await writeMigration('0001_first.sql', 'create table a (id int);');
    await writeMigration('0002_second.sql', 'create table b (id int);');
    await migrate(dbUrl, dir);

    // Simulate deploying an older revision, which no longer contains 0002.
    await rm(path.join(dir, '0002_second.sql'));

    await expect(migrate(dbUrl, dir)).rejects.toThrowError(
      /recorded as applied but is not in the migrations directory/
    );
  });

  it('records a checksum for each applied migration', async () => {
    const sql = 'create table a (id int);';
    await writeMigration('0001_first.sql', sql);
    await migrate(dbUrl, dir);

    const rows = await queryDb<{ name: string; checksum: string }>(
      'select name, checksum from schema_migrations'
    );
    expect(rows[0].checksum).toBe(checksum(sql));
  });
});

describe('status', () => {
  it('reports pending and applied without changing anything', async () => {
    await writeMigration('0001_first.sql', 'create table a (id int);');
    await writeMigration('0002_second.sql', 'create table b (id int);');

    expect(await status(dbUrl, dir)).toEqual([
      { name: '0001_first.sql', applied: false },
      { name: '0002_second.sql', applied: false },
    ]);

    await migrate(dbUrl, dir);

    expect(await status(dbUrl, dir)).toEqual([
      { name: '0001_first.sql', applied: true },
      { name: '0002_second.sql', applied: true },
    ]);
  });
});

describe('loadMigrations', () => {
  it('ignores files that are not .sql', async () => {
    await writeMigration('0001_first.sql', 'select 1;');
    await writeMigration('README.md', 'not a migration');

    const migrations = await loadMigrations(dir);
    expect(migrations.map(m => m.name)).toEqual(['0001_first.sql']);
  });

  it('treats line endings as insignificant', () => {
    expect(checksum('a\r\nb')).toBe(checksum('a\nb'));
  });
});
