// Resolving the signed-in principal to an application user, and that user to a
// set of permissions (S-106, S-107).
//
// Access is data, not code: the database is asked what a user may do, so
// granting a permission is a configuration change rather than a release. The
// resolution happens per request — a role revoked now takes effect on the very
// next request, with no cache to invalidate and no stale session to wait out.
import { query } from '../db/pool';
import type { AuthUser } from '../auth/types';

// A signed-in principal that has been matched to a record in this system.
export interface Principal {
  // Internal id. Every foreign key and audit row points here, never at the
  // external subject.
  userId: string;
  entraSubject: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: ReadonlySet<string>;
}

// Why a session did not produce a principal. The distinction matters: an
// unknown subject is a person who authenticated with Entra but has no account
// here, which is a provisioning gap worth logging, not a broken session.
export type PrincipalRejection =
  | { reason: 'no-session' }
  | { reason: 'unknown-subject'; subject: string }
  | { reason: 'deactivated'; subject: string; userId: string };

export type PrincipalResult =
  | { ok: true; principal: Principal }
  | { ok: false; rejection: PrincipalRejection };

interface PrincipalRow {
  user_id: string;
  entra_subject: string;
  email: string;
  display_name: string;
  is_active: boolean;
  roles: string[] | null;
  permissions: string[] | null;
}

// One round trip: the user, their roles, and the union of those roles'
// permissions. Doing this as three queries would be three network hops per
// request against a database that may be in another region.
const PRINCIPAL_QUERY = `
  select u.id                       as user_id,
         u.entra_subject            as entra_subject,
         u.email::text              as email,
         u.display_name             as display_name,
         u.is_active                as is_active,
         coalesce(
           array_agg(distinct r.code) filter (where r.code is not null),
           '{}'
         )                          as roles,
         coalesce(
           array_agg(distinct p.code) filter (where p.code is not null),
           '{}'
         )                          as permissions
    from app_user u
    left join user_role       ur on ur.user_id = u.id
    left join role            r  on r.id = ur.role_id
    left join role_permission rp on rp.role_id = r.id
    left join permission      p  on p.id = rp.permission_id
   where u.entra_subject = $1
   group by u.id
`;

// Claim a pre-provisioned account on first sign-in.
//
// An administrator cannot pre-provision by subject: the OIDC `sub` claim is
// pairwise — unique to this application — and is not visible anywhere in the
// Azure portal. Accounts are therefore created by email address, with no
// subject, and the subject is bound the first time that person signs in.
//
// This trusts the email claim, which is safe ONLY because self-service sign-up
// is disabled on the tenant (see docs/adr/0001-azure-native-backend.md): every
// account is created by an administrator, so nobody can obtain a token bearing
// an address they were not given. If sign-up is ever enabled, this becomes a
// route to claiming someone else's pre-provisioned account and must be removed.
//
// The update is the guard: it binds only a row that is active and still
// unbound, so it can happen exactly once and two concurrent sign-ins cannot
// both claim the same account.
const CLAIM_QUERY = `
  update app_user
     set entra_subject = $1, updated_at = now()
   where email = $2::citext
     and entra_subject is null
     and is_active
  returning id
`;

async function claimPreProvisionedAccount(
  subject: string,
  email: string | null
): Promise<boolean> {
  if (!email) return false;
  const claimed = await query<{ id: string }>(CLAIM_QUERY, [subject, email]);
  if (claimed.rowCount === 0) return false;

  console.info(`[access] bound pre-provisioned account ${email} to a subject`);
  return true;
}

// Resolve the session's subject to a principal.
//
// Deactivation is checked here rather than in the query so the caller can tell
// "no such user" from "user is switched off" — the second is a normal
// administrative state and should read that way in the logs.
export async function resolvePrincipal(
  user: AuthUser | null
): Promise<PrincipalResult> {
  if (!user?.id) {
    return { ok: false, rejection: { reason: 'no-session' } };
  }

  let result = await query<PrincipalRow>(PRINCIPAL_QUERY, [user.id]);

  if (result.rows.length === 0) {
    // No account bound to this subject yet — perhaps one is waiting under this
    // person's email address.
    if (await claimPreProvisionedAccount(user.id, user.email)) {
      result = await query<PrincipalRow>(PRINCIPAL_QUERY, [user.id]);
    }
  }

  const row = result.rows[0];

  if (!row) {
    return {
      ok: false,
      rejection: { reason: 'unknown-subject', subject: user.id },
    };
  }

  if (!row.is_active) {
    return {
      ok: false,
      rejection: {
        reason: 'deactivated',
        subject: user.id,
        userId: row.user_id,
      },
    };
  }

  return {
    ok: true,
    principal: {
      userId: row.user_id,
      entraSubject: row.entra_subject,
      email: row.email,
      displayName: row.display_name,
      roles: row.roles ?? [],
      permissions: new Set(row.permissions ?? []),
    },
  };
}

// The role that may reach a route which declares no permission of its own.
// Deliberately a single, named role rather than a "superuser" flag on the user,
// so the holders are visible in the same place as everyone else's access.
export const SYSTEM_ADMINISTRATOR_ROLE = 'system_administrator';

export function isSystemAdministrator(principal: Principal): boolean {
  return principal.roles.includes(SYSTEM_ADMINISTRATOR_ROLE);
}

export function hasPermission(
  principal: Principal,
  permission: string
): boolean {
  return principal.permissions.has(permission);
}
