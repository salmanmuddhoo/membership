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

export async function listUsers(): Promise<UserSummary[]> {
  const result = await query<{
    id: string;
    email: string;
    display_name: string;
    is_active: boolean;
    has_signed_in: boolean;
    roles: string[];
  }>(
    `select u.id, u.email::text as email, u.display_name, u.is_active,
            (u.entra_subject is not null) as has_signed_in,
            coalesce(
              array_agg(distinct r.code) filter (where r.code is not null), '{}'
            ) as roles
       from app_user u
       left join user_role ur on ur.user_id = u.id
       left join role r on r.id = ur.role_id
      group by u.id
      order by u.display_name`
  );

  return result.rows.map(r => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    isActive: r.is_active,
    hasSignedIn: r.has_signed_in,
    roles: r.roles,
  }));
}
