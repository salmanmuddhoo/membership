// Managing roles, their permissions, and who holds them (S-201, S-202, S-204).
//
// Every change here alters what someone may do, so every change is audited in
// the same transaction as the change itself — a grant that happened without a
// record of who granted it is exactly what an auditor asks about.
import type { PoolClient } from 'pg';
import { recordAudit } from '../access/audit';
import { query, withTransaction } from '../db/pool';

export class AdminError extends Error {
  constructor(
    message: string,
    readonly reason:
      'not_found' | 'in_use' | 'system_role' | 'duplicate' | 'invalid'
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

export interface RoleSummary {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
}

export async function listRoles(): Promise<RoleSummary[]> {
  const result = await query<{
    id: string;
    code: string;
    name: string;
    description: string | null;
    is_system: boolean;
    permissions: string[];
    user_count: string;
  }>(
    `select r.id, r.code, r.name, r.description, r.is_system,
            coalesce(
              array_agg(distinct p.code) filter (where p.code is not null), '{}'
            ) as permissions,
            count(distinct ur.user_id)::text as user_count
       from role r
       left join role_permission rp on rp.role_id = r.id
       left join permission p on p.id = rp.permission_id
       left join user_role ur on ur.role_id = r.id
      group by r.id
      order by r.name`
  );

  return result.rows.map(r => ({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    isSystem: r.is_system,
    permissions: r.permissions,
    userCount: Number(r.user_count),
  }));
}

export interface CreateRoleInput {
  code: string;
  name: string;
  description?: string;
  permissions: string[];
}

export async function createRole(
  input: CreateRoleInput,
  actor: { userId: string; email: string }
): Promise<string> {
  if (!/^[a-z][a-z0-9_]{2,49}$/.test(input.code)) {
    throw new AdminError(
      'A role code must be lower-case letters, digits and underscores.',
      'invalid'
    );
  }

  return withTransaction(async client => {
    const existing = await client.query('select 1 from role where code = $1', [
      input.code,
    ]);
    if (existing.rowCount) {
      throw new AdminError(
        `A role with code ${input.code} already exists.`,
        'duplicate'
      );
    }

    const created = await client.query<{ id: string }>(
      `insert into role (code, name, description) values ($1, $2, $3)
       returning id`,
      [input.code, input.name, input.description ?? null]
    );
    const roleId = created.rows[0].id;

    await setRolePermissionsInTransaction(client, roleId, input.permissions);

    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'role.created',
        entityType: 'role',
        entityId: roleId,
        newValue: {
          code: input.code,
          name: input.name,
          permissions: input.permissions,
        },
      },
      client
    );

    return roleId;
  });
}

async function setRolePermissionsInTransaction(
  client: PoolClient,
  roleId: string,
  permissionCodes: string[]
): Promise<void> {
  // Reject an unknown permission rather than silently granting nothing: a typo
  // in a permission code would otherwise produce a role that looks right and
  // does nothing.
  if (permissionCodes.length > 0) {
    const known = await client.query<{ code: string }>(
      'select code from permission where code = any($1)',
      [permissionCodes]
    );
    const found = new Set(known.rows.map(r => r.code));
    const unknown = permissionCodes.filter(c => !found.has(c));
    if (unknown.length > 0) {
      throw new AdminError(
        `Unknown permission(s): ${unknown.join(', ')}.`,
        'invalid'
      );
    }
  }

  await client.query('delete from role_permission where role_id = $1', [
    roleId,
  ]);

  if (permissionCodes.length > 0) {
    await client.query(
      `insert into role_permission (role_id, permission_id)
       select $1, p.id from permission p where p.code = any($2)`,
      [roleId, permissionCodes]
    );
  }
}

// Replace a role's permissions wholesale.
//
// Holders lose a removed capability on their next request, with no cache to
// clear and no session to expire — permissions are resolved per request
// (S-107). That is the acceptance criterion, and it holds because of how the
// access layer reads, not because anything is invalidated here.
export async function setRolePermissions(
  roleId: string,
  permissionCodes: string[],
  actor: { userId: string; email: string }
): Promise<void> {
  await withTransaction(async client => {
    const role = await client.query<{ code: string }>(
      'select code from role where id = $1',
      [roleId]
    );
    if (role.rowCount === 0) throw new AdminError('No such role.', 'not_found');

    const before = await client.query<{ code: string }>(
      `select p.code from role_permission rp
         join permission p on p.id = rp.permission_id
        where rp.role_id = $1 order by p.code`,
      [roleId]
    );

    await setRolePermissionsInTransaction(client, roleId, permissionCodes);

    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'role.permissions_changed',
        entityType: 'role',
        entityId: roleId,
        previousValue: { permissions: before.rows.map(r => r.code) },
        newValue: { permissions: [...permissionCodes].sort() },
      },
      client
    );
  });
}

// Delete a role, refusing while anyone holds it.
//
// The database would refuse anyway — user_role references role with ON DELETE
// RESTRICT — but a foreign-key violation is not an explanation. The check here
// exists to say WHY, and how many people are affected.
export async function deleteRole(
  roleId: string,
  actor: { userId: string; email: string }
): Promise<void> {
  await withTransaction(async client => {
    const role = await client.query<{ code: string; is_system: boolean }>(
      'select code, is_system from role where id = $1',
      [roleId]
    );
    if (role.rowCount === 0) throw new AdminError('No such role.', 'not_found');

    if (role.rows[0].is_system) {
      throw new AdminError(
        `${role.rows[0].code} is a system role and cannot be deleted.`,
        'system_role'
      );
    }

    const holders = await client.query<{ count: string }>(
      'select count(*)::text as count from user_role where role_id = $1',
      [roleId]
    );
    const count = Number(holders.rows[0].count);
    if (count > 0) {
      throw new AdminError(
        `${role.rows[0].code} is held by ${count} user(s). Remove it from them first.`,
        'in_use'
      );
    }

    await client.query('delete from role_permission where role_id = $1', [
      roleId,
    ]);
    await client.query('delete from role where id = $1', [roleId]);

    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'role.deleted',
        entityType: 'role',
        entityId: roleId,
        previousValue: { code: role.rows[0].code },
      },
      client
    );
  });
}

// Replace a user's roles. Several at once is the normal case, not an edge one:
// FRD 6.1 expects a Regional Officer to also cover Clerk duties.
/**
 * Create a staff account (S-202, S-204 — the "create" half of user.manage).
 *
 * Accounts are created by EMAIL, never by Entra subject: the OIDC `sub` claim
 * is pairwise to this application and is not visible anywhere in the Azure
 * portal, so there is nothing an administrator could look up. The subject is
 * bound the first time that person signs in (see access/principal.ts).
 *
 * That binding trusts the email claim, which is safe ONLY because self-service
 * sign-up is disabled on the tenant. Creating an account here is therefore the
 * moment access is really granted — the person named simply signs in and
 * receives it. It is gated on user.manage and audited for that reason.
 */
export async function createStaffAccount(
  input: { email: string; displayName: string; roleCodes: string[] },
  actor: { userId: string; email: string }
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();

  // Deliberately permissive: the authority on whether an address exists is the
  // Entra tenant, not a regular expression, and a rule that rejects a real
  // colleague's address is worse than one that lets a typo through — a typo
  // simply never signs in, and the account can be deactivated.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AdminError(
      'That does not look like an email address.',
      'invalid'
    );
  }
  if (displayName === '') {
    throw new AdminError(
      'A name is required, so colleagues can tell who this is.',
      'invalid'
    );
  }

  return withTransaction(async client => {
    const existing = await client.query<{ id: string; is_active: boolean }>(
      'select id, is_active from app_user where email = $1::citext',
      [email]
    );
    if (existing.rowCount) {
      // Say which case it is. "Already exists" sends an administrator hunting
      // for an account that the list does not show because it is deactivated.
      throw new AdminError(
        existing.rows[0].is_active
          ? `${email} already has an account. Change its roles below instead.`
          : `${email} has a deactivated account. Reactivate it below rather ` +
              'than creating a second one — their history points at the first.',
        'duplicate'
      );
    }

    if (input.roleCodes.length > 0) {
      const known = await client.query<{ code: string }>(
        'select code from role where code = any($1)',
        [input.roleCodes]
      );
      const found = new Set(known.rows.map(r => r.code));
      const unknown = input.roleCodes.filter(c => !found.has(c));
      if (unknown.length > 0) {
        throw new AdminError(
          `Unknown role(s): ${unknown.join(', ')}.`,
          'invalid'
        );
      }
    }

    const created = await client.query<{ id: string }>(
      `insert into app_user (email, display_name) values ($1::citext, $2)
       returning id`,
      [email, displayName]
    );
    const userId = created.rows[0].id;

    if (input.roleCodes.length > 0) {
      await client.query(
        `insert into user_role (user_id, role_id, granted_by)
         select $1, r.id, $3 from role r where r.code = any($2)`,
        [userId, input.roleCodes, actor.userId]
      );
    }

    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'user.created',
        entityType: 'app_user',
        entityId: userId,
        newValue: {
          email,
          displayName,
          roles: [...input.roleCodes].sort(),
        },
      },
      client
    );

    return userId;
  });
}

export async function setUserRoles(
  userId: string,
  roleCodes: string[],
  actor: { userId: string; email: string }
): Promise<void> {
  await withTransaction(async client => {
    const user = await client.query<{ email: string }>(
      'select email::text as email from app_user where id = $1',
      [userId]
    );
    if (user.rowCount === 0) throw new AdminError('No such user.', 'not_found');

    if (roleCodes.length > 0) {
      const known = await client.query<{ code: string }>(
        'select code from role where code = any($1)',
        [roleCodes]
      );
      const found = new Set(known.rows.map(r => r.code));
      const unknown = roleCodes.filter(c => !found.has(c));
      if (unknown.length > 0) {
        throw new AdminError(
          `Unknown role(s): ${unknown.join(', ')}.`,
          'invalid'
        );
      }
    }

    const before = await client.query<{ code: string }>(
      `select r.code from user_role ur join role r on r.id = ur.role_id
        where ur.user_id = $1 order by r.code`,
      [userId]
    );

    await client.query('delete from user_role where user_id = $1', [userId]);

    if (roleCodes.length > 0) {
      await client.query(
        `insert into user_role (user_id, role_id, granted_by)
         select $1, r.id, $3 from role r where r.code = any($2)`,
        [userId, roleCodes, actor.userId]
      );
    }

    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'user.roles_changed',
        entityType: 'app_user',
        entityId: userId,
        previousValue: { roles: before.rows.map(r => r.code) },
        newValue: { roles: [...roleCodes].sort() },
      },
      client
    );
  });
}

/**
 * What still points at this account.
 *
 * Read from the catalogue rather than a hand-written list, so a table added by
 * a later milestone is covered without anyone remembering to update this. Every
 * foreign key into app_user is found and probed.
 */
export async function referencesTo(userId: string): Promise<string[]> {
  const keys = await query<{ table_name: string; column_name: string }>(
    `select c.conrelid::regclass::text as table_name, a.attname as column_name
       from pg_constraint c
       join pg_attribute a
         on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.confrelid = 'app_user'::regclass and c.contype = 'f'`
  );

  const holding: string[] = [];
  for (const key of keys.rows) {
    // These identifiers come from the catalogue, not from a request, so they
    // cannot be hostile. regclass::text already quotes a table name that needs
    // it; the column name is quoted here for the same reason, and because a
    // reader should not have to work out why one is safe and the other is.
    const column = `"${key.column_name.replace(/"/g, '""')}"`;
    const used = await query<{ n: string }>(
      `select count(*) as n from ${key.table_name} where ${column} = $1`,
      [userId]
    );
    if (Number(used.rows[0].n) > 0) {
      holding.push(`${key.table_name} (${used.rows[0].n})`);
    }
  }
  return holding;
}

/**
 * Delete a staff account outright.
 *
 * Only possible when nothing points at the account. That is a real case worth
 * supporting — an address typed wrongly, or someone provisioned who never
 * joined — and deleting such a row loses nothing at all.
 *
 * The moment an account has done anything, deletion stops being available and
 * deactivation is the answer instead. Not as a policy this code chooses: audit
 * rows, granted-by references and the approval chain all point here, and the
 * retention period outlives anyone's employment. Removing the row would leave
 * the record of what they did pointing at nothing, which for a financial
 * institution is the one thing the audit trail must never allow.
 */
export async function deleteStaffAccount(
  userId: string,
  actor: { userId: string; email: string }
): Promise<void> {
  if (userId === actor.userId) {
    throw new AdminError('You cannot delete your own account.', 'invalid');
  }

  const user = await query<{ email: string; display_name: string }>(
    'select email::text as email, display_name from app_user where id = $1',
    [userId]
  );
  if (user.rowCount === 0) {
    throw new AdminError('That account no longer exists.', 'not_found');
  }

  // user_role rows are this account's own grants, not history of what it did,
  // and cascade with it. Everything else is history.
  const holding = (await referencesTo(userId)).filter(
    r => !r.startsWith('user_role (')
  );

  if (holding.length > 0) {
    throw new AdminError(
      `${user.rows[0].email} has already been used in the system, so the ` +
        'account cannot be deleted — records of what they did point at it. ' +
        'Deactivate them instead: they lose access immediately and their ' +
        'history stays readable.',
      'in_use'
    );
  }

  await withTransaction(async client => {
    await client.query('delete from user_role where user_id = $1', [userId]);
    await client.query('delete from app_user where id = $1', [userId]);

    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: 'user.deleted',
        entityType: 'app_user',
        entityId: userId,
        previousValue: {
          email: user.rows[0].email,
          displayName: user.rows[0].display_name,
        },
      },
      client
    );
  });
}

// Deactivate a leaver (S-204).
//
// Never a delete. Audit rows, approvals and granted-by references point at this
// person, and the retention period outlives their employment; removing the row
// would leave the record of what they did pointing at nothing.
export async function setUserActive(
  userId: string,
  isActive: boolean,
  actor: { userId: string; email: string }
): Promise<void> {
  await withTransaction(async client => {
    const user = await client.query<{ email: string; is_active: boolean }>(
      'select email::text as email, is_active from app_user where id = $1',
      [userId]
    );
    if (user.rowCount === 0) throw new AdminError('No such user.', 'not_found');

    if (user.rows[0].is_active === isActive) return;

    await client.query(
      `update app_user
          set is_active = $2,
              deactivated_at = case when $2 then null else now() end,
              updated_at = now()
        where id = $1`,
      [userId, isActive]
    );

    await recordAudit(
      {
        actorUserId: actor.userId,
        actorDescription: actor.email,
        action: isActive ? 'user.reactivated' : 'user.deactivated',
        entityType: 'app_user',
        entityId: userId,
        previousValue: { isActive: user.rows[0].is_active },
        newValue: { isActive },
      },
      client
    );
  });
}

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  hasSignedIn: boolean;
  roles: string[];
}

// How many accounts are deactivated. Counted in the database rather than by
// filtering a page of results, which would only ever count the deactivated
// accounts that happened to fall inside the page limit.
export async function countDeactivatedUsers(): Promise<number> {
  const result = await query<{ n: string }>(
    'select count(*) as n from app_user where not is_active'
  );
  return Number(result.rows[0].n);
}

export interface UserPage {
  users: UserSummary[];
  /** Accounts matching the search, before the page limit is applied. */
  total: number;
  /** True when the limit hid some of them, so the caller can say so. */
  truncated: boolean;
}

/**
 * The staff list grows without bound, and rendering all of it into one page
 * is what makes it unusable rather than merely long. So it is always bounded
 * and always says how many it left out; `search` is how you reach the rest.
 */
export const USER_PAGE_LIMIT = 100;

export async function listUsers(
  options: { search?: string; limit?: number; includeInactive?: boolean } = {}
): Promise<UserPage> {
  const search = options.search?.trim() ? options.search.trim() : null;
  // Defaults to showing everyone, so the API and any other caller keep the
  // whole picture. The administration screen chooses to hide deactivated
  // accounts, because a leaver on the list every day is noise — but that is a
  // presentation decision and it belongs to the page, not here.
  const includeInactive = options.includeInactive ?? true;
  const limit = Math.min(
    Math.max(options.limit ?? USER_PAGE_LIMIT, 1),
    USER_PAGE_LIMIT
  );

  const result = await query<{
    id: string;
    email: string;
    display_name: string;
    is_active: boolean;
    has_signed_in: boolean;
    roles: string[];
    total_count: string;
  }>(
    // count(*) over () is evaluated before LIMIT, so it reports the size of
    // the whole match, not of the page.
    `select u.id, u.email::text as email, u.display_name, u.is_active,
            (u.entra_subject is not null) as has_signed_in,
            coalesce(
              array_agg(distinct r.code) filter (where r.code is not null), '{}'
            ) as roles,
            count(*) over () as total_count
       from app_user u
       left join user_role ur on ur.user_id = u.id
       left join role r on r.id = ur.role_id
      where ($3::boolean or u.is_active)
        and ($1::text is null
             or strpos(lower(u.display_name), lower($1::text)) > 0
             or strpos(lower(u.email::text), lower($1::text)) > 0)
      group by u.id
      order by u.display_name
      limit $2::int`,
    [search, limit, includeInactive]
  );

  const users = result.rows.map(r => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    isActive: r.is_active,
    hasSignedIn: r.has_signed_in,
    roles: r.roles,
  }));

  const total = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;

  return { users, total, truncated: users.length < total };
}
