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

const dbName = `audit_test_${Date.now()}`;
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

async function load() {
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  return import('./audit');
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

describe('recordAudit', () => {
  it('records a refusal with its actor, action and reason (S-108)', async () => {
    const { recordAudit } = await load();

    await recordAudit({
      actorDescription: 'officer@albarakah.mu',
      action: 'access.denied',
      entityType: 'route',
      entityId: '/members/new',
      newValue: { reason: 'missing-permission', required: 'member.create' },
      ipAddress: '203.0.113.7',
    });

    const rows = await run(
      appUrl,
      // host() rather than ::text: casting inet to text appends the /32 mask.
      `select action, entity_id, new_value, host(ip_address) as ip
         from audit_event where action = 'access.denied'`
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].entity_id).toBe('/members/new');
    expect(rows.rows[0].new_value).toEqual({
      reason: 'missing-permission',
      required: 'member.create',
    });
    expect(rows.rows[0].ip).toBe('203.0.113.7');
  });

  it('accepts a system actor with no user id', async () => {
    const { recordAudit } = await load();

    await recordAudit({
      actorUserId: null,
      actorDescription: 'scheduled-job:dormancy-sweep',
      action: 'member.marked_dormant',
      entityType: 'member',
      entityId: 'ABM-000042',
    });

    const rows = await run(
      appUrl,
      `select actor_user_id, actor_description from audit_event
        where action = 'member.marked_dormant'`
    );
    expect(rows.rows[0].actor_user_id).toBeNull();
    expect(rows.rows[0].actor_description).toBe('scheduled-job:dormancy-sweep');
  });

  it('rejects an entry that names no actor at all', async () => {
    const { recordAudit } = await load();

    // The check constraint: every action must be attributable to someone or
    // something. An empty description with no user id is neither.
    await expect(
      recordAudit({
        actorUserId: null,
        actorDescription: '',
        action: 'mystery',
        entityType: 'thing',
        entityId: '1',
      })
    ).rejects.toThrow();
  });

  it('shares a transaction with the change it describes', async () => {
    const { recordAudit } = await load();
    const { withTransaction, query, closePool } = await import('../db/pool');

    try {
      const before = await query<{ n: number }>(
        'select count(*)::int as n from audit_event'
      );

      await expect(
        withTransaction(async client => {
          await client.query(
            `insert into app_user (entra_subject, email, display_name)
             values ('sub-tx', 'tx@albarakah.mu', 'Tx')`
          );
          await recordAudit(
            {
              actorDescription: 'system',
              action: 'user.created',
              entityType: 'app_user',
              entityId: 'sub-tx',
            },
            client
          );
          throw new Error('business rule failed');
        })
      ).rejects.toThrowError('business rule failed');

      // Neither the user nor its audit row survived: no record of a change
      // that did not happen.
      const after = await query<{ n: number }>(
        'select count(*)::int as n from audit_event'
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);

      const user = await query(
        `select 1 from app_user where entra_subject = 'sub-tx'`
      );
      expect(user.rows).toHaveLength(0);
    } finally {
      await closePool();
    }
  });
});

describe('recordAuditQuietly', () => {
  it('does not throw when the write fails, but logs loudly', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { recordAuditQuietly } = await load();

    try {
      // Violates the actor check constraint.
      await expect(
        recordAuditQuietly({
          actorUserId: null,
          actorDescription: '',
          action: 'mystery',
          entityType: 'thing',
          entityId: '1',
        })
      ).resolves.toBeUndefined();

      // A hole in the audit trail must never be silent. The pool logs the
      // driver error first, so look across the calls rather than at the first.
      const messages = logged.mock.calls.map(call => String(call[0]));
      expect(messages.some(m => m.includes('FAILED TO RECORD'))).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });
});
