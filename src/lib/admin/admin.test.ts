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

const dbName = `admin_test_${Date.now()}`;
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
  return {
    roles: await import('./roles'),
    segregation: await import('./segregation'),
    audit: await import('../access/audit'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let adminId: string;
let officerId: string;
let actor: { userId: string; email: string };

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('admin@albarakah.mu', 'Administrator'),
            ('officer@albarakah.mu', 'Officer')
     returning id, email::text as email`
  );
  adminId = users.rows.find(r => r.email === 'admin@albarakah.mu').id;
  officerId = users.rows.find(r => r.email === 'officer@albarakah.mu').id;
  actor = { userId: adminId, email: 'admin@albarakah.mu' };
}, 60_000);

afterAll(async () => {
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('S-201: roles and their permissions', () => {
  it('creates a role with permissions and audits it', async () => {
    const { roles } = await load();

    const id = await roles.createRole(
      {
        code: 'treasurer',
        name: 'Treasurer',
        description: 'Manages fees',
        permissions: ['role.view', 'user.view'],
      },
      actor
    );

    const listed = (await roles.listRoles()).find(r => r.id === id);
    expect(listed?.permissions.sort()).toEqual(['role.view', 'user.view']);

    const audited = await run(
      appUrl,
      `select actor_user_id, new_value from audit_event
        where action = 'role.created' and entity_id = $1`,
      [id]
    );
    expect(audited.rows[0].actor_user_id).toBe(adminId);
  });

  it('refuses an unknown permission rather than granting nothing', async () => {
    const { roles } = await load();

    // A typo would otherwise produce a role that looks right and does nothing.
    await expect(
      roles.createRole(
        { code: 'typo_role', name: 'Typo', permissions: ['user.mange'] },
        actor
      )
    ).rejects.toThrowError(/Unknown permission/);

    // And nothing was left behind by the failed attempt.
    const listed = (await roles.listRoles()).find(r => r.code === 'typo_role');
    expect(listed).toBeUndefined();
  });

  it('refuses a duplicate code', async () => {
    const { roles } = await load();
    await roles.createRole(
      { code: 'clerk', name: 'Clerk', permissions: [] },
      actor
    );
    await expect(
      roles.createRole(
        { code: 'clerk', name: 'Clerk Again', permissions: [] },
        actor
      )
    ).rejects.toThrowError(/already exists/);
  });

  it('refuses deletion while the role is held, and says by how many', async () => {
    const { roles } = await load();
    const id = await roles.createRole(
      { code: 'in_use_role', name: 'In Use', permissions: [] },
      actor
    );
    await roles.setUserRoles(officerId, ['in_use_role'], actor);

    // The foreign key would refuse anyway; this exists to explain WHY.
    await expect(roles.deleteRole(id, actor)).rejects.toThrowError(
      /held by 1 user/
    );

    await roles.setUserRoles(officerId, [], actor);
    await expect(roles.deleteRole(id, actor)).resolves.toBeUndefined();
  });

  it('refuses to delete a system role', async () => {
    const { roles } = await load();
    const sysadmin = (await roles.listRoles()).find(
      r => r.code === 'system_administrator'
    );
    // Deleting it would leave nobody able to reach an undeclared route.
    await expect(roles.deleteRole(sysadmin!.id, actor)).rejects.toThrowError(
      /system role/
    );
  });

  it('records the before and after when permissions change', async () => {
    const { roles } = await load();
    const id = await roles.createRole(
      { code: 'changing', name: 'Changing', permissions: ['role.view'] },
      actor
    );

    await roles.setRolePermissions(id, ['user.view', 'user.manage'], actor);

    const audited = await run(
      appUrl,
      `select previous_value, new_value from audit_event
        where action = 'role.permissions_changed' and entity_id = $1`,
      [id]
    );
    expect(audited.rows[0].previous_value).toEqual({
      permissions: ['role.view'],
    });
    expect(audited.rows[0].new_value).toEqual({
      permissions: ['user.manage', 'user.view'],
    });
  });
});

describe('S-202: a user may hold several roles', () => {
  it('assigns more than one, as FRD 6.1 expects', async () => {
    const { roles } = await load();
    await roles.createRole(
      { code: 'admin_test_officer', name: 'RO', permissions: [] },
      actor
    );
    await roles.createRole(
      { code: 'admin_test_clerk', name: 'Clerk', permissions: [] },
      actor
    );

    await roles.setUserRoles(
      officerId,
      ['admin_test_officer', 'admin_test_clerk'],
      actor
    );

    const user = (await roles.listUsers()).users.find(u => u.id === officerId);
    expect(user?.roles.sort()).toEqual([
      'admin_test_clerk',
      'admin_test_officer',
    ]);
  });

  it('refuses an unknown role', async () => {
    const { roles } = await load();
    await expect(
      roles.setUserRoles(officerId, ['not_a_role'], actor)
    ).rejects.toThrowError(/Unknown role/);
  });
});

describe('S-204: deactivation, never deletion', () => {
  it('deactivates without losing the user or their history', async () => {
    const { roles } = await load();
    await roles.setUserActive(officerId, false, actor);

    const user = (await roles.listUsers()).users.find(u => u.id === officerId);
    expect(user).toBeDefined();
    expect(user?.isActive).toBe(false);

    const audited = await run(
      appUrl,
      `select action from audit_event
        where entity_id = $1 and action = 'user.deactivated'`,
      [officerId]
    );
    expect(audited.rowCount).toBe(1);

    await roles.setUserActive(officerId, true, actor);
  });

  it('is a no-op when the state already matches', async () => {
    const { roles } = await load();
    const before = await run(
      appUrl,
      `select count(*)::int as n from audit_event where action = 'user.reactivated'`
    );
    await roles.setUserActive(officerId, true, actor); // already active
    const after = await run(
      appUrl,
      `select count(*)::int as n from audit_event where action = 'user.reactivated'`
    );
    // No audit noise from a change that did not happen.
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('the staff list stays bounded', () => {
  it('caps the page and reports how many it left out', async () => {
    const { roles } = await load();
    // Two accounts exist from the fixture; add enough to cross the cap.
    const extra = roles.USER_PAGE_LIMIT + 5;
    await run(
      appUrl,
      `insert into app_user (email, display_name)
       select 'bulk' || i || '@albarakah.mu', 'Bulk ' || i
         from generate_series(1, $1) as i`,
      [extra]
    );

    try {
      const page = await roles.listUsers();
      expect(page.users).toHaveLength(roles.USER_PAGE_LIMIT);
      expect(page.total).toBe(extra + 2);
      expect(page.truncated).toBe(true);
    } finally {
      await run(appUrl, `delete from app_user where email like 'bulk%'`);
    }
  });

  it('finds an account by a fragment of its email, whatever the case', async () => {
    const { roles } = await load();
    const page = await roles.listUsers({ search: 'OFFICER@albarakah' });

    expect(page.users.map(u => u.id)).toEqual([officerId]);
    expect(page.total).toBe(1);
    expect(page.truncated).toBe(false);
  });

  it('treats a wildcard as text, not as a pattern', async () => {
    const { roles } = await load();
    // A LIKE-based search would match every account here.
    const page = await roles.listUsers({ search: '%' });

    expect(page.users).toHaveLength(0);
    expect(page.total).toBe(0);
  });
});

describe('S-203: segregation of duties, per record', () => {
  const APPLICATION = 'APP-0001';
  const OTHER_APPLICATION = 'APP-0002';

  it('allows an action nobody has a conflicting history with', async () => {
    const { segregation } = await load();
    const verdict = await segregation.checkSegregation(
      officerId,
      'membership_application',
      APPLICATION,
      'membership.application.approved'
    );
    expect(verdict.allowed).toBe(true);
  });

  it('refuses the approver who captured that same application', async () => {
    const { segregation, audit } = await load();

    await audit.recordAudit({
      actorUserId: officerId,
      actorDescription: 'officer@albarakah.mu',
      action: 'membership.application.captured',
      entityType: 'membership_application',
      entityId: APPLICATION,
    });

    const verdict = await segregation.checkSegregation(
      officerId,
      'membership_application',
      APPLICATION,
      'membership.application.approved'
    );

    expect(verdict.allowed).toBe(false);
    // The person is told which of their own actions is in the way.
    expect(verdict.conflict?.earlierAction).toBe(
      'membership.application.captured'
    );
    expect(verdict.conflict?.description).toContain('may not approve it');
  });

  it('blocks per record, not per role', async () => {
    const { segregation } = await load();

    // Same officer, same action, a DIFFERENT application: allowed. Blocking the
    // role combination instead would break FRD 6.1's operating model.
    const verdict = await segregation.checkSegregation(
      officerId,
      'membership_application',
      OTHER_APPLICATION,
      'membership.application.approved'
    );
    expect(verdict.allowed).toBe(true);
  });

  it('does not block a different person', async () => {
    const { segregation } = await load();
    const verdict = await segregation.checkSegregation(
      adminId,
      'membership_application',
      APPLICATION,
      'membership.application.approved'
    );
    expect(verdict.allowed).toBe(true);
  });

  it('cannot be evaded by erasing the earlier action', async () => {
    // The check reads audit_event, which refuses UPDATE and DELETE even to the
    // table owner. The control and its evidence are the same rows.
    await expect(
      run(
        ownerUrl,
        `delete from audit_event
          where entity_id = $1 and action = 'membership.application.captured'`,
        [APPLICATION]
      )
    ).rejects.toThrowError(/append-only/);

    const { segregation } = await load();
    const verdict = await segregation.checkSegregation(
      officerId,
      'membership_application',
      APPLICATION,
      'membership.application.approved'
    );
    expect(verdict.allowed).toBe(false);
  });

  it('honours a rule being disabled', async () => {
    const { segregation } = await load();
    await run(
      appUrl,
      `update segregation_rule set is_enabled = false
        where later_action = 'membership.application.approved'
          and earlier_action = 'membership.application.captured'`
    );

    const verdict = await segregation.checkSegregation(
      officerId,
      'membership_application',
      APPLICATION,
      'membership.application.approved'
    );
    expect(verdict.allowed).toBe(true);

    await run(
      appUrl,
      `update segregation_rule set is_enabled = true
        where later_action = 'membership.application.approved'
          and earlier_action = 'membership.application.captured'`
    );
  });

  it('ships with the conflicts FRD Section 6 names', async () => {
    const { segregation } = await load();
    const rules = await segregation.listSegregationRules();
    const pairs = rules.map(r => `${r.earlierAction} -> ${r.laterAction}`);

    expect(pairs).toContain(
      'membership.application.captured -> membership.application.approved'
    );
    expect(pairs).toContain(
      'membership.application.captured -> membership.application.reviewed'
    );
    expect(pairs).toContain(
      'membership.application.reviewed -> membership.application.approved'
    );
  });
});
