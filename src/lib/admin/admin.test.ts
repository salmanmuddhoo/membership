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

describe('creating a staff account from the administration screen', () => {
  it('creates the account with its roles, ready to sign in', async () => {
    const { roles } = await load();

    const id = await roles.createStaffAccount(
      {
        email: 'New.Recruit@albarakah.mu',
        displayName: 'New Officer',
        roleCodes: ['system_administrator'],
      },
      actor
    );

    const created = (await roles.listUsers()).users.find(u => u.id === id)!;
    // Stored lower-case: the column is citext, but a consistent stored form
    // keeps the audit trail and the Entra claim comparable by eye.
    expect(created.email).toBe('new.recruit@albarakah.mu');
    expect(created.displayName).toBe('New Officer');
    expect(created.roles).toEqual(['system_administrator']);

    // No subject yet. It binds on first sign-in, which is what makes an
    // account created by email safe to hand out.
    expect(created.hasSignedIn).toBe(false);
  });

  it('creates an account with no roles at all', async () => {
    const { roles } = await load();
    const id = await roles.createStaffAccount(
      { email: 'norole@albarakah.mu', displayName: 'No Role', roleCodes: [] },
      actor
    );

    const created = (await roles.listUsers()).users.find(u => u.id === id)!;
    expect(created.roles).toEqual([]);
    // Deny by default means such a person can sign in and reach nothing,
    // which is the right starting state rather than an error.
    expect(created.isActive).toBe(true);
  });

  it('records who created the account, and with what', async () => {
    const { roles } = await load();
    const id = await roles.createStaffAccount(
      {
        email: 'audited@albarakah.mu',
        displayName: 'Audited',
        roleCodes: ['system_administrator'],
      },
      actor
    );

    const audited = await run(
      appUrl,
      `select actor_description, new_value->>'email' as email,
              new_value->'roles' as roles
         from audit_event
        where action = 'user.created' and entity_id = $1`,
      [id]
    );
    expect(audited.rowCount).toBe(1);
    expect(audited.rows[0].actor_description).toBe(actor.email);
    expect(audited.rows[0].email).toBe('audited@albarakah.mu');
    expect(audited.rows[0].roles).toEqual(['system_administrator']);
  });

  it('refuses a second account for an address that already has one', async () => {
    const { roles } = await load();
    await roles.createStaffAccount(
      { email: 'dup@albarakah.mu', displayName: 'First', roleCodes: [] },
      actor
    );

    await expect(
      roles.createStaffAccount(
        { email: 'DUP@albarakah.mu', displayName: 'Second', roleCodes: [] },
        actor
      )
    ).rejects.toThrowError(/already has an account/);
  });

  it('points at the deactivated account rather than letting a second be made', async () => {
    const { roles } = await load();
    const id = await roles.createStaffAccount(
      { email: 'leaver@albarakah.mu', displayName: 'Leaver', roleCodes: [] },
      actor
    );
    await roles.setUserActive(id, false, actor);

    // A deactivated account does not stand out in the list, so "already
    // exists" would send an administrator hunting. A second account would also
    // split that person's history across two records.
    await expect(
      roles.createStaffAccount(
        {
          email: 'leaver@albarakah.mu',
          displayName: 'Returner',
          roleCodes: [],
        },
        actor
      )
    ).rejects.toThrowError(/deactivated account. Reactivate it/);
  });

  it('refuses an unknown role, creating nothing', async () => {
    const { roles } = await load();
    const before = await run(appUrl, 'select count(*) as n from app_user');

    await expect(
      roles.createStaffAccount(
        {
          email: 'badrole@albarakah.mu',
          displayName: 'Bad Role',
          roleCodes: ['not_a_role'],
        },
        actor
      )
    ).rejects.toThrowError(/Unknown role/);

    const after = await run(appUrl, 'select count(*) as n from app_user');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('refuses input that is obviously not an address or has no name', async () => {
    const { roles } = await load();
    await expect(
      roles.createStaffAccount(
        { email: 'not-an-address', displayName: 'X', roleCodes: [] },
        actor
      )
    ).rejects.toThrowError(/email address/);

    await expect(
      roles.createStaffAccount(
        { email: 'noname@albarakah.mu', displayName: '  ', roleCodes: [] },
        actor
      )
    ).rejects.toThrowError(/name is required/);
  });
});

describe('deleting a staff account', () => {
  it('deletes an account that has never been used', async () => {
    const { roles } = await load();
    // The real case: an address typed wrongly, or someone provisioned who
    // never joined. Nothing points at the row, so nothing is lost.
    const id = await roles.createStaffAccount(
      { email: 'typo@albarakah.mu', displayName: 'Typo', roleCodes: [] },
      actor
    );

    await roles.deleteStaffAccount(id, actor);

    const gone = await run(appUrl, 'select 1 from app_user where id = $1', [
      id,
    ]);
    expect(gone.rowCount).toBe(0);
  });

  it('takes its role grants with it', async () => {
    const { roles } = await load();
    const id = await roles.createStaffAccount(
      {
        email: 'withrole@albarakah.mu',
        displayName: 'With Role',
        roleCodes: ['system_administrator'],
      },
      actor
    );

    await roles.deleteStaffAccount(id, actor);

    const orphans = await run(
      appUrl,
      'select 1 from user_role where user_id = $1',
      [id]
    );
    expect(orphans.rowCount).toBe(0);
  });

  it('records the deletion, with what was deleted', async () => {
    const { roles } = await load();
    const id = await roles.createStaffAccount(
      {
        email: 'recorded@albarakah.mu',
        displayName: 'Recorded',
        roleCodes: [],
      },
      actor
    );
    await roles.deleteStaffAccount(id, actor);

    const audited = await run(
      appUrl,
      `select actor_description, previous_value->>'email' as email
         from audit_event where action = 'user.deleted' and entity_id = $1`,
      [id]
    );
    // The row is gone, so the audit entry is the only remaining evidence the
    // account ever existed. It has to say what it was.
    expect(audited.rowCount).toBe(1);
    expect(audited.rows[0].actor_description).toBe(actor.email);
    expect(audited.rows[0].email).toBe('recorded@albarakah.mu');
  });

  it('refuses once the account has done anything', async () => {
    const { roles } = await load();
    const id = await roles.createStaffAccount(
      { email: 'active@albarakah.mu', displayName: 'Active', roleCodes: [] },
      actor
    );

    // They act: one audit row is enough to make them part of the record.
    await run(
      appUrl,
      `insert into audit_event
         (actor_user_id, actor_description, action, entity_type, entity_id)
       values ($1, 'active@albarakah.mu', 'something.happened', 'thing', 'x')`,
      [id]
    );

    await expect(roles.deleteStaffAccount(id, actor)).rejects.toThrowError(
      /cannot be deleted/
    );

    const still = await run(appUrl, 'select 1 from app_user where id = $1', [
      id,
    ]);
    expect(still.rowCount).toBe(1);
  });

  it('refuses an officer who captured an application', async () => {
    const { roles } = await load();
    const id = await roles.createStaffAccount(
      {
        email: 'captured@albarakah.mu',
        displayName: 'Captured',
        roleCodes: [],
      },
      actor
    );

    const type = await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    );
    await run(
      appUrl,
      `insert into membership_application (membership_type_id, captured_by)
       values ($1, $2)`,
      [type.rows[0].id, id]
    );

    // Deleting them would leave the application's captured_by pointing at
    // nothing, and segregation of duties reads that column.
    await expect(roles.deleteStaffAccount(id, actor)).rejects.toThrowError(
      /cannot be deleted/
    );
  });

  it('finds a reference in a table nobody remembered to list', async () => {
    const { roles } = await load();
    const id = await roles.createStaffAccount(
      { email: 'future@albarakah.mu', displayName: 'Future', roleCodes: [] },
      actor
    );

    // Stands in for a table a later milestone adds. The check reads the
    // catalogue, so it covers this without anyone updating a hand-written
    // list — which is the whole reason it is written that way.
    await run(
      ownerUrl,
      `create table if not exists a_later_module (
         id uuid primary key default gen_random_uuid(),
         acted_by uuid not null references app_user(id)
       )`
    );
    await run(
      ownerUrl,
      'grant select, insert on a_later_module to albarakah_app'
    );
    await run(appUrl, 'insert into a_later_module (acted_by) values ($1)', [
      id,
    ]);

    try {
      expect(await roles.referencesTo(id)).toEqual(
        expect.arrayContaining([expect.stringContaining('a_later_module')])
      );
      await expect(roles.deleteStaffAccount(id, actor)).rejects.toThrowError(
        /cannot be deleted/
      );
    } finally {
      await run(ownerUrl, 'drop table a_later_module');
    }
  });

  it('refuses to let an administrator delete themselves', async () => {
    const { roles } = await load();
    await expect(
      roles.deleteStaffAccount(actor.userId, actor)
    ).rejects.toThrowError(/your own account/);
  });
});

describe('the working list hides leavers unless asked', () => {
  it('leaves them out by default but still counts them when asked', async () => {
    const { roles } = await load();
    const id = await roles.createStaffAccount(
      { email: 'gone@albarakah.mu', displayName: 'Gone Away', roleCodes: [] },
      actor
    );
    await roles.setUserActive(id, false, actor);

    const working = await roles.listUsers({ includeInactive: false });
    expect(working.users.map(u => u.id)).not.toContain(id);

    const everyone = await roles.listUsers({ includeInactive: true });
    expect(everyone.users.map(u => u.id)).toContain(id);

    // Default stays "everyone", so the API and any other caller are unchanged.
    const byDefault = await roles.listUsers();
    expect(byDefault.users.map(u => u.id)).toContain(id);
  });

  it('counts only what it shows', async () => {
    const { roles } = await load();
    const working = await roles.listUsers({ includeInactive: false });
    const everyone = await roles.listUsers({ includeInactive: true });

    expect(working.total).toBeLessThan(everyone.total);
    expect(working.users.every(u => u.isActive)).toBe(true);
  });
});

describe('counting deactivated accounts', () => {
  it('counts them all, not just those inside a page of results', async () => {
    const { roles } = await load();
    const before = await roles.countDeactivatedUsers();

    const id = await roles.createStaffAccount(
      { email: 'counted@albarakah.mu', displayName: 'Counted', roleCodes: [] },
      actor
    );
    await roles.setUserActive(id, false, actor);

    expect(await roles.countDeactivatedUsers()).toBe(before + 1);

    // The point of counting in the database: with more accounts than the page
    // limit, filtering a page would miss any deactivated account beyond it.
    await run(
      appUrl,
      `insert into app_user (email, display_name, is_active)
       select 'pad' || i || '@albarakah.mu', 'Pad ' || i, true
         from generate_series(1, $1) as i`,
      [roles.USER_PAGE_LIMIT + 10]
    );
    try {
      const page = await roles.listUsers({ includeInactive: true });
      expect(page.users).toHaveLength(roles.USER_PAGE_LIMIT);
      // Still correct, even though the deactivated account may now sit beyond
      // the page.
      expect(await roles.countDeactivatedUsers()).toBe(before + 1);
    } finally {
      await run(appUrl, `delete from app_user where email like 'pad%'`);
    }
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
    // Counted rather than assumed: other tests in this file create accounts,
    // and hard-coding the fixture's two would break this for a reason that has
    // nothing to do with paging.
    const baseline = Number(
      (await run(appUrl, 'select count(*) as n from app_user')).rows[0].n
    );
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
      expect(page.total).toBe(baseline + extra);
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
