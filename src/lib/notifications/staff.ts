// Who on the staff to write to (S-1804, S-1805). A member's address is on
// their application; an officer's is on app_user, which has an email and
// nothing else — so staff events go by email only, and a deactivated user
// is not written to whatever roles they still hold.
import { query } from '../db/pool';

export interface StaffRecipient {
  userId: string;
  name: string;
  email: string;
}

const SELECT = `select distinct u.id, u.display_name, u.email::text as email
                  from app_user u`;

function assemble(rows: { id: string; display_name: string; email: string }[]) {
  return rows.map(r => ({
    userId: r.id,
    name: r.display_name,
    email: r.email,
  }));
}

// Every active holder of a role, by its code.
export async function staffWithRole(
  roleCode: string
): Promise<StaffRecipient[]> {
  const result = await query<{
    id: string;
    display_name: string;
    email: string;
  }>(
    `${SELECT}
       join user_role ur on ur.user_id = u.id
       join role r on r.id = ur.role_id
      where u.is_active and r.code = $1
      order by u.display_name`,
    [roleCode]
  );
  return assemble(result.rows);
}

// Every active user who holds a permission through any of their roles.
export async function staffWithPermission(
  permissionCode: string
): Promise<StaffRecipient[]> {
  const result = await query<{
    id: string;
    display_name: string;
    email: string;
  }>(
    `${SELECT}
       join user_role ur on ur.user_id = u.id
       join role_permission rp on rp.role_id = ur.role_id
       join permission p on p.id = rp.permission_id
      where u.is_active and p.code = $1
      order by u.display_name`,
    [permissionCode]
  );
  return assemble(result.rows);
}

// One user, if they are still active.
export async function staffMember(
  userId: string
): Promise<StaffRecipient | null> {
  const result = await query<{
    id: string;
    display_name: string;
    email: string;
  }>(`${SELECT} where u.is_active and u.id = $1`, [userId]);
  return assemble(result.rows)[0] ?? null;
}
