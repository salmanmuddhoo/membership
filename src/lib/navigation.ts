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
  '/reports/bank-accounts':
    'What each bank account holds, and every payment in and out.',
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
  // One item, "API", can land on either page depending on which permission
  // the person holds — keyed by both so the dashboard card finds its text
  // either way (it looks up NAV_DESCRIPTIONS by the item's own href).
  '/admin/api':
    'The API reference, and the credentials of the systems that call it.',
  '/admin/api-credentials':
    'The API reference, and the credentials of the systems that call it.',
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
                icon: 'applications',
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
                icon: 'transactions',
                badge:
                  input.transactionsBadge > 0
                    ? input.transactionsBadge
                    : undefined,
              },
            ]
          : []),
        ...(can('cash.session')
          ? [{ label: 'Cash drawer', href: '/cashier', icon: 'cashDrawer' }]
          : []),
        ...(can('cash.view')
          ? [
              {
                label: 'Cash drawers',
                href: '/cashier/sessions',
                icon: 'cashDrawers',
              },
            ]
          : []),
        ...(can('bank_account.view')
          ? [
              {
                label: 'Bank accounts',
                href: '/reports/bank-accounts',
                icon: 'bank',
              },
            ]
          : []),
        ...(can('receipt.reconcile')
          ? [
              {
                label: 'Receipt reconciliation',
                href: '/receipts/reconciliation',
                icon: 'reconciliation',
              },
            ]
          : []),
      ],
    },
    {
      label: 'Administration',
      items: [
        ...(can('role.view')
          ? [{ label: 'Roles', href: '/admin/roles', icon: 'roles' }]
          : []),
        ...(can('user.view')
          ? [{ label: 'Staff accounts', href: '/admin/users', icon: 'staff' }]
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
                  icon: 'fees',
                },
              ]
            : []),
        ...(can('system.reset_data') && !input.production
          ? [
              {
                label: 'Reset test data',
                href: '/admin/reset-data',
                icon: 'reset',
              },
            ]
          : []),
        ...(can('system.migrate_members')
          ? [
              {
                label: 'Migration',
                href: '/admin/migration',
                icon: 'migration',
              },
            ]
          : []),
        ...(can('audit.view')
          ? [{ label: 'Audit log', href: '/admin/audit-log', icon: 'audit' }]
          : []),
        ...(can('report.view')
          ? [{ label: 'Reports', href: '/reports', icon: 'reports' }]
          : []),
        ...(can('notification.view')
          ? [
              {
                label: 'Notifications',
                href: '/admin/notifications',
                icon: 'notifications',
              },
            ]
          : []),
        // One door, whichever half of it the person holds: the reference
        // for someone who explores it, credentials for someone who only
        // issues them (officer feedback: two menu items for what reads as
        // one thing, "the API").
        ...(can('api.explore') || can('api_credential.manage')
          ? [
              {
                label: 'API',
                href: can('api.explore')
                  ? '/admin/api'
                  : '/admin/api-credentials',
                icon: 'api',
              },
            ]
          : []),
      ],
    },
    // A group with nothing the person may see is dropped entirely, so the heading
    // does not sit above an empty space.
  ].filter(group => group.items.length > 0);
}

// The API item's href is whichever of the two API pages the person's
// permission sends them to, but the item itself lights up on both — they
// read as one destination ("API") on the menu, and a plain prefix match
// does not connect them: '/admin/api-credentials' does not start with
// '/admin/api/'.
const API_PATHS: ReadonlySet<string> = new Set([
  '/admin/api',
  '/admin/api-credentials',
]);

// Which item lights up for the page the person is on. Matches on the
// pathname alone, so an href carrying a query string (e.g.
// /reports/bank-accounts?all=1) still highlights while on that page, and
// picks the longest matching pathname, so a sub-page (Bank accounts, under
// /reports) lights up its own link rather than also lighting up Reports.
export function activeNavHref(
  groups: NavGroup[],
  pathname: string
): string | undefined {
  let best: string | undefined;
  let bestLength = -1;
  for (const group of groups) {
    for (const item of group.items) {
      const itemPath = item.href.split('?')[0];
      const matches =
        pathname === itemPath ||
        pathname.startsWith(`${itemPath}/`) ||
        (API_PATHS.has(itemPath) && API_PATHS.has(pathname));
      if (matches && itemPath.length > bestLength) {
        best = item.href;
        bestLength = itemPath.length;
      }
    }
  }
  return best;
}
