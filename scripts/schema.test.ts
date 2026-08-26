import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './migrate';

// Exercises the real migrations in migrations/, not fixtures: these assert the
// acceptance criteria for S-103, S-104 and S-105 against an actual database.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations'
);

const dbName = `schema_test_${Date.now()}`;
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

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);
}, 30_000);

afterAll(async () => {
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('S-103 identity and access', () => {
  it('keys users on an internal id, separate from the Entra subject', async () => {
    const result = await run(
      appUrl,
      `insert into app_user (entra_subject, email, display_name)
       values ($1, $2, $3) returning id, is_active`,
      ['entra-sub-1', 'Officer@albarakah.mu', 'Test Officer']
    );
    expect(result.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.rows[0].is_active).toBe(true);
  });

  it('treats email as case-insensitive so one person cannot be created twice', async () => {
    await expect(
      run(
        appUrl,
        `insert into app_user (email, display_name) values ($1, $2)`,
        ['OFFICER@albarakah.mu', 'Duplicate']
      )
    ).rejects.toThrowError(/duplicate key/);
  });

  it('lets a user hold several roles, each with several permissions', async () => {
    await run(
      appUrl,
      `insert into role (code, name) values ('officer', 'Officer'), ('secretary', 'Secretary')`
    );
    await run(
      appUrl,
      `insert into permission (code, description) values ('member.create', 'Create'), ('member.approve', 'Approve')`
    );
    await run(
      appUrl,
      // Scoped to the roles and permissions this test creates. A blanket cross
      // join would also re-grant the seeded system_administrator pairs and
      // collide — and would be asserting about seed data rather than about the
      // schema.
      `insert into role_permission (role_id, permission_id)
       select r.id, p.id from role r cross join permission p
        where r.code in ('officer', 'secretary')
          and p.code in ('member.create', 'member.approve')`
    );
    await run(
      appUrl,
      `insert into user_role (user_id, role_id)
       select u.id, r.id from app_user u cross join role r
        where r.code in ('officer', 'secretary')
          and u.entra_subject = 'entra-sub-1'`
    );

    const result = await run(
      appUrl,
      `select count(distinct p.code)::int as permissions
         from app_user u
         join user_role ur on ur.user_id = u.id
         join role_permission rp on rp.role_id = ur.role_id
         join permission p on p.id = rp.permission_id
        where u.entra_subject = 'entra-sub-1'`
    );
    expect(result.rows[0].permissions).toBe(2);
  });

  it('deactivates without deleting, and requires a deactivation timestamp', async () => {
    // The check constraint must reject a half-done deactivation.
    await expect(
      run(
        appUrl,
        `update app_user set is_active = false where entra_subject = 'entra-sub-1'`
      )
    ).rejects.toThrowError(/app_user_deactivated_at_agrees_with_is_active/);

    await run(
      appUrl,
      `update app_user set is_active = false, deactivated_at = now()
        where entra_subject = 'entra-sub-1'`
    );

    // The row is still there, with its roles intact.
    const result = await run(
      appUrl,
      `select is_active from app_user where entra_subject = 'entra-sub-1'`
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].is_active).toBe(false);
  });
});

describe('S-104 configuration', () => {
  it('keeps every previous value readable after a change', async () => {
    await run(
      appUrl,
      `insert into config_entry (key, value, value_type, description)
       values ('dormancy.share_threshold', '15000'::jsonb, 'number', 'MUR')`
    );
    await run(
      appUrl,
      `update config_entry set value = '20000'::jsonb where key = 'dormancy.share_threshold'`
    );

    const history = await run(
      appUrl,
      `select value, (replaced_at is null) as is_current
         from config_entry_history
        where config_key = 'dormancy.share_threshold'
        order by effective_at`
    );
    expect(history.rows.map(r => Number(r.value))).toEqual([15000, 20000]);
    expect(history.rows.map(r => r.is_current)).toEqual([false, true]);
  });

  it('rejects an unknown value type', async () => {
    await expect(
      run(
        appUrl,
        `insert into config_entry (key, value, value_type, description)
         values ('bad', '1'::jsonb, 'guess', 'x')`
      )
    ).rejects.toThrowError(/value_type/);
  });

  it('does not let the application write history directly', async () => {
    await expect(
      run(
        appUrl,
        `insert into config_entry_history (config_key, value, value_type, effective_at)
         values ('forged', '1'::jsonb, 'number', now())`
      )
    ).rejects.toThrowError(/permission denied/);
  });
});

describe('S-105 append-only audit log', () => {
  it('accepts an audit row', async () => {
    const result = await run(
      appUrl,
      `insert into audit_event (actor_description, action, entity_type, entity_id, new_value)
       values ('system', 'member.created', 'member', 'ABM-000001', '{"a":1}'::jsonb)
       returning id`
    );
    expect(Number(result.rows[0].id)).toBeGreaterThan(0);
  });

  it('refuses an update, for the application and for the owner alike', async () => {
    await expect(
      run(appUrl, `update audit_event set action = 'tampered'`)
    ).rejects.toThrowError(/permission denied/);

    // Defence in depth: the trigger refuses it even where the grant would not.
    await expect(
      run(ownerUrl, `update audit_event set action = 'tampered'`)
    ).rejects.toThrowError(/append-only; UPDATE is not permitted/);
  });

  it('refuses a delete and a truncate', async () => {
    await expect(run(ownerUrl, `delete from audit_event`)).rejects.toThrowError(
      /append-only; DELETE is not permitted/
    );

    // TRUNCATE bypasses row-level triggers, so it needs its own guard.
    await expect(run(ownerUrl, `truncate audit_event`)).rejects.toThrowError(
      /append-only; TRUNCATE is not permitted/
    );
  });

  it('leaves no orphaned audit row when the business change is rolled back', async () => {
    const client = new pg.Client({ connectionString: appUrl, ssl: false });
    await client.connect();
    try {
      const before = await client.query(
        'select count(*)::int as n from audit_event'
      );

      await client.query('BEGIN');
      await client.query(
        `insert into app_user (email, display_name) values ('rollback@albarakah.mu', 'Rolled Back')`
      );
      await client.query(
        `insert into audit_event (actor_description, action, entity_type, entity_id)
         values ('system', 'user.created', 'app_user', 'rollback')`
      );
      await client.query('ROLLBACK');

      const after = await client.query(
        'select count(*)::int as n from audit_event'
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);

      const user = await client.query(
        `select 1 from app_user where email = 'rollback@albarakah.mu'`
      );
      expect(user.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

describe('least privilege', () => {
  it('denies the application any schema changes', async () => {
    await expect(
      run(appUrl, 'create table sneaky (id int)')
    ).rejects.toThrowError(/permission denied for schema public/);

    await expect(run(appUrl, 'drop table audit_event')).rejects.toThrowError(
      /must be owner|permission denied/
    );
  });

  it('denies the application any write to the migration ledger', async () => {
    await expect(
      run(appUrl, `delete from schema_migrations`)
    ).rejects.toThrowError(/permission denied/);
  });
});
