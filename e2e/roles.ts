// The people the suite signs in as, and why there has to be more than one.
//
// Segregation of duties (S-203) means the officer who captures an application
// may not review it and the Secretary may not approve it. A suite running as
// one account could therefore never walk an application to approved — it would
// be stopped by the control it is meant to be testing. So each step of the
// chain needs its own account, and the Society has to provision five of them.
//
// That is not an inconvenience the tests invented. It is S-1004's own work:
// provisioning real people with real roles, tested before go-live rather than
// on it.
export const ROLES = [
  'officer',
  'secretary',
  'president',
  'treasurer',
  'admin',
] as const;

export type Role = (typeof ROLES)[number];

export interface RoleSpec {
  role: Role;
  // The role code as Configuration → Roles knows it. What the account must
  // actually hold for the suite to get past that role's step.
  roleCode: string;
  label: string;
}

export const ROLE_SPECS: Record<Role, RoleSpec> = {
  officer: {
    role: 'officer',
    roleCode: 'regional_officer',
    label: 'Regional Officer',
  },
  secretary: {
    role: 'secretary',
    roleCode: 'secretary',
    label: 'Secretary',
  },
  president: {
    role: 'president',
    roleCode: 'president',
    label: 'President / Chairperson',
  },
  treasurer: {
    role: 'treasurer',
    roleCode: 'treasurer',
    label: 'Treasurer',
  },
  admin: {
    role: 'admin',
    roleCode: 'system_administrator',
    label: 'System Administrator',
  },
};

export function storageStatePath(role: Role): string {
  return `e2e/.auth/${role}.json`;
}
