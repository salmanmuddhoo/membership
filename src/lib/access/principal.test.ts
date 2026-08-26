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

// Exercised against a real database: the query under test does the role and
// permission joins, so a mock would only assert the shape we already assumed.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `principal_test_${Date.now()}`;
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
  return import('./principal');
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

  // An officer with two roles whose permissions overlap, so the union is
  // genuinely exercised rather than a single role's list.
  await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('sub-officer', 'officer@albarakah.mu', 'Officer'),
            ('sub-dormant', 'dormant@albarakah.mu', 'Dormant'),
            ('sub-admin',   'admin@albarakah.mu',   'Administrator')`
  );
  await run(
    appUrl,
    // system_administrator is seeded by migration 0006, not created here.
    `insert into role (code, name)
     values ('officer', 'Officer'), ('cashier', 'Cashier')`
  );
  await run(
    appUrl,
    `insert into permission (code, description)
     values ('member.create', 'x'), ('member.view', 'x'), ('payment.record', 'x')`
  );
  // officer: member.create + member.view;  cashier: member.view + payment.record
  await run(
    appUrl,
    `insert into role_permission (role_id, permission_id)
     select r.id, p.id from role r, permission p
      where (r.code = 'officer' and p.code in ('member.create', 'member.view'))
         or (r.code = 'cashier' and p.code in ('member.view', 'payment.record'))`
  );
  await run(
    appUrl,
    `insert into user_role (user_id, role_id)
     select u.id, r.id from app_user u, role r
      where (u.entra_subject = 'sub-officer' and r.code in ('officer', 'cashier'))
         or (u.entra_subject = 'sub-admin' and r.code = 'system_administrator')`
  );
  await run(
    appUrl,
    `update app_user set is_active = false, deactivated_at = now()
      where entra_subject = 'sub-dormant'`
  );
}, 30_000);

afterAll(async () => {
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('resolvePrincipal (S-106)', () => {
  it('attaches the user when the subject matches', async () => {
    const { resolvePrincipal } = await load();

    const result = await resolvePrincipal({
      id: 'sub-officer',
      email: null,
      name: null,
      roles: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.email).toBe('officer@albarakah.mu');
    // The internal id, not the Entra subject — audit rows point at this.
    expect(result.principal.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.principal.entraSubject).toBe('sub-officer');
  });

  it('refuses a valid session whose subject has no account here', async () => {
    const { resolvePrincipal } = await load();

    const result = await resolvePrincipal({
      id: 'sub-nobody',
      email: null,
      name: null,
      roles: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toBe('unknown-subject');
  });

  it('refuses a deactivated user, and says so distinctly', async () => {
    const { resolvePrincipal } = await load();

    const result = await resolvePrincipal({
      id: 'sub-dormant',
      email: null,
      name: null,
      roles: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Distinguished from unknown-subject: an administrator reading the audit
    // trail needs to tell "switched off" from "never existed".
    expect(result.rejection.reason).toBe('deactivated');
  });

  it('reports no session without touching the database', async () => {
    const { resolvePrincipal } = await load();

    const result = await resolvePrincipal(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toBe('no-session');
  });
});

describe('permission resolution (S-107)', () => {
  it('is the union of every role, without duplicates', async () => {
    const { resolvePrincipal } = await load();

    const result = await resolvePrincipal({
      id: 'sub-officer',
      email: null,
      name: null,
      roles: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // officer ∪ cashier — member.view is in both and must appear once.
    expect([...result.principal.permissions].sort()).toEqual([
      'member.create',
      'member.view',
      'payment.record',
    ]);
    expect(result.principal.roles.sort()).toEqual(['cashier', 'officer']);
  });

  it('reflects a role change on the very next request', async () => {
    const { resolvePrincipal } = await load();
    const subject = { id: 'sub-officer', email: null, name: null, roles: [] };

    const before = await resolvePrincipal(subject);
    expect(
      before.ok && before.principal.permissions.has('payment.record')
    ).toBe(true);

    // Revoke the cashier role — no cache to clear, no session to expire.
    await run(
      appUrl,
      `delete from user_role
        where role_id = (select id from role where code = 'cashier')`
    );

    const after = await resolvePrincipal(subject);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.principal.permissions.has('payment.record')).toBe(false);
    // The permission the two roles shared survives, via the role still held.
    expect(after.principal.permissions.has('member.view')).toBe(true);
  });

  it('gives a user with no roles an empty permission set, not an error', async () => {
    const { resolvePrincipal } = await load();

    const result = await resolvePrincipal({
      id: 'sub-admin',
      email: null,
      name: null,
      roles: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // system_administrator carries no explicit permissions in this fixture.
    expect(result.principal.permissions.size).toBe(0);
    expect(result.principal.roles).toEqual(['system_administrator']);
  });
});

describe('claiming a pre-provisioned account (first sign-in)', () => {
  it('binds the subject to an account created by email', async () => {
    const { resolvePrincipal } = await load();

    // Created by an administrator with no subject — they cannot know it.
    await run(
      appUrl,
      `insert into app_user (email, display_name)
       values ('newjoiner@albarakah.mu', 'New Joiner')`
    );

    const result = await resolvePrincipal({
      id: 'sub-newjoiner',
      email: 'newjoiner@albarakah.mu',
      name: null,
      roles: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.entraSubject).toBe('sub-newjoiner');

    const stored = await run(
      appUrl,
      `select entra_subject from app_user where email = 'newjoiner@albarakah.mu'`
    );
    expect(stored.rows[0].entra_subject).toBe('sub-newjoiner');
  });

  it('matches the address case-insensitively', async () => {
    const { resolvePrincipal } = await load();
    await run(
      appUrl,
      `insert into app_user (email, display_name)
       values ('MixedCase@albarakah.mu', 'Mixed Case')`
    );

    const result = await resolvePrincipal({
      id: 'sub-mixedcase',
      email: 'mixedcase@albarakah.mu',
      name: null,
      roles: [],
    });

    expect(result.ok).toBe(true);
  });

  it('cannot be claimed a second time by a different subject', async () => {
    const { resolvePrincipal } = await load();
    await run(
      appUrl,
      `insert into app_user (email, display_name)
       values ('once@albarakah.mu', 'Once')`
    );

    const first = await resolvePrincipal({
      id: 'sub-first',
      email: 'once@albarakah.mu',
      name: null,
      roles: [],
    });
    expect(first.ok).toBe(true);

    // Someone else presenting the same address must not take the account over.
    const second = await resolvePrincipal({
      id: 'sub-impostor',
      email: 'once@albarakah.mu',
      name: null,
      roles: [],
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.rejection.reason).toBe('unknown-subject');
  });

  it('will not claim a deactivated account', async () => {
    const { resolvePrincipal } = await load();
    await run(
      appUrl,
      `insert into app_user (email, display_name, is_active, deactivated_at)
       values ('left@albarakah.mu', 'Left', false, now())`
    );

    const result = await resolvePrincipal({
      id: 'sub-left',
      email: 'left@albarakah.mu',
      name: null,
      roles: [],
    });

    // Refused as unknown rather than bound: a departed member of staff must not
    // be able to reactivate themselves by signing in.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toBe('unknown-subject');
  });

  it('does not claim anything when the token carries no email', async () => {
    const { resolvePrincipal } = await load();
    await run(
      appUrl,
      `insert into app_user (email, display_name)
       values ('noemail@albarakah.mu', 'No Email')`
    );

    const result = await resolvePrincipal({
      id: 'sub-noemail',
      email: null,
      name: null,
      roles: [],
    });

    expect(result.ok).toBe(false);
  });
});
