// The navigation: what this person may reach, built from the permissions
// they hold, so a link is never shown to someone the middleware would
// refuse. The permission named here must match the one the route declares
// in src/lib/access/authorise.ts — otherwise the menu and the guard
// disagree, and the person meets a refusal page instead of a missing link.
//
// One model for the sidebar and the dashboard (officer feedback): the
// dashboard's cards are these same groups and items, with a line each, so
// the two can never offer different doors.

export interface NavItem {
  label: string;
  href: string;
  icon: string;
  badge?: number;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

// What each door is for, in the officer's words, for the dashboard card.
export const NAV_DESCRIPTIONS: Record<string, string> = {
  '/dashboard': 'Where you are.',
  '/applications':
    'Membership and account applications, and what waits on you.',
  '/members': 'Every member and non-member, their accounts and standing.',
  '/documents': 'What is filed for each member, in one place.',
  '/transactions':
    'Deposits, withdrawals and transfers, and the ones waiting on you.',
  '/cashier': 'Your cash drawer: open, count, close.',
  '/cashier/sessions': 'Every cash drawer, with its count and over or short.',
  '/receipts/reconciliation':
    'Gaps, duplicates and voids in the receipt numbers.',
  '/admin/roles': 'Who may do what.',
  '/admin/users': 'Staff sign-ins and their roles.',
  '/admin/configuration':
    'Fees, forms, chains, wording and every other setting.',
  '/admin/configuration/fees': 'Entrance, share and account fees.',
  '/admin/reset-data': 'Wipe this test environment back to empty.',
  '/admin/migration': 'Bring members in from the old register.',
  '/admin/audit-log': 'Who did what, when.',
  '/reports':
    'Membership, finance and operations, on screen or as a spreadsheet.',
  '/admin/notifications': 'What was sent to members, and whether it arrived.',
  '/admin/api': 'The API reference, with a request to try.',
  '/admin/api-credentials': 'Credentials for systems that call the API.',
};

export function navigationFor(input: {
  permissions: ReadonlySet<string>;
  applicationsBadge: number;
  transactionsBadge: number;
  production: boolean;
}): NavGroup[] {
  const can = (permission: string) => input.permissions.has(permission);
  return [
    { items: [{ label: 'Dashboard', href: '/dashboard', icon: 'dashboard' }] },
    {
      label: 'Membership',
      items: [
        ...(can('application.view')
          ? [
              {
                label: 'Applications',
                href: '/applications',
                icon: 'members',
                badge:
                  input.applicationsBadge > 0
                    ? input.applicationsBadge
                    : undefined,
              },
            ]
          : []),
        ...(can('member.view')
          ? [{ label: 'Members', href: '/members', icon: 'members' }]
          : []),
        ...(can('document.view')
          ? [{ label: 'Documents', href: '/documents', icon: 'documents' }]
          : []),
      ],
    },
    {
      label: 'Finance',
      items: [
        ...(can('transaction.view')
          ? [
              {
                label: 'Transactions',
                href: '/transactions',
                icon: 'reports',
                badge:
                  input.transactionsBadge > 0
                    ? input.transactionsBadge
                    : undefined,
              },
            ]
          : []),
        ...(can('cash.session')
          ? [{ label: 'Cash drawer', href: '/cashier', icon: 'reports' }]
          : []),
        ...(can('cash.view')
          ? [
              {
                label: 'Cash drawers',
                href: '/cashier/sessions',
                icon: 'reports',
              },
            ]
          : []),
        ...(can('receipt.reconcile')
          ? [
              {
                label: 'Receipt reconciliation',
                href: '/receipts/reconciliation',
                icon: 'reports',
              },
            ]
          : []),
      ],
    },
    {
      label: 'Administration',
      items: [
        ...(can('role.view')
          ? [{ label: 'Roles', href: '/admin/roles', icon: 'settings' }]
          : []),
        ...(can('user.view')
          ? [{ label: 'Staff accounts', href: '/admin/users', icon: 'members' }]
          : []),
        ...(can('config.view')
          ? [
              {
                label: 'Configuration',
                href: '/admin/configuration',
                icon: 'settings',
              },
            ]
          : can('fee.view')
            ? [
                {
                  label: 'Fee schedules',
                  href: '/admin/configuration/fees',
                  icon: 'settings',
                },
              ]
            : []),
        ...(can('system.reset_data') && !input.production
          ? [
              {
                label: 'Reset test data',
                href: '/admin/reset-data',
                icon: 'settings',
              },
            ]
          : []),
        ...(can('system.migrate_members')
          ? [{ label: 'Migration', href: '/admin/migration', icon: 'members' }]
          : []),
        ...(can('audit.view')
          ? [{ label: 'Audit log', href: '/admin/audit-log', icon: 'reports' }]
          : []),
        ...(can('report.view')
          ? [{ label: 'Reports', href: '/reports', icon: 'reports' }]
          : []),
        ...(can('notification.view')
          ? [
              {
                label: 'Notifications',
                href: '/admin/notifications',
                icon: 'reports',
              },
            ]
          : []),
        ...(can('api.explore')
          ? [{ label: 'API', href: '/admin/api', icon: 'settings' }]
          : []),
        ...(can('api_credential.manage')
          ? [
              {
                label: 'API credentials',
                href: '/admin/api-credentials',
                icon: 'settings',
              },
            ]
          : []),
      ],
    },
    // A group with nothing the person may see is dropped entirely, so the heading
    // does not sit above an empty space.
  ].filter(group => group.items.length > 0);
}
