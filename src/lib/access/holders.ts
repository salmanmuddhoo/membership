// Which roles hold a permission — for a screen that names who acts next
// (the chevron's Disbursement step says "Treasurer" because the Treasurer
// holds transaction.disburse, not because a screen says so). Read from the
// same tables the principal is built from, so moving a permission at
// Configuration → Roles moves the name.
import { query } from '../db/pool';

export async function rolesHoldingPermission(code: string): Promise<string[]> {
  const result = await query<{ name: string }>(
    `select r.name
       from role r
       join role_permission rp on rp.role_id = r.id
       join permission p on p.id = rp.permission_id
      where p.code = $1
      order by r.name`,
    [code]
  );
  return result.rows.map(r => r.name);
}
