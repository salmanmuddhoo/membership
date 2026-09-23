// Authorisation decisions, and the route permission map (S-107, S-108).
//
// Deny by default is the whole point: a route that nobody remembered to list
// is refused rather than served. Adding a feature and forgetting to protect it
// therefore produces a visible refusal in testing, not a silent hole in
// production.
import {
  hasPermission,
  isSystemAdministrator,
  type Principal,
} from './principal';

export type Decision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'undeclared-route' | 'missing-permission';
      required?: string;
    };

// Routes that require no permission beyond being a signed-in, active user.
// Kept explicit and small: everything here is readable by every member of
// staff, so each entry should be obviously harmless.
const OPEN_TO_ALL_USERS: ReadonlySet<string> = new Set(['/dashboard']);

// The permission each protected route requires. A route absent from both this
// map and the set above is undeclared, and undeclared means denied.
//
// Prefixes end with '/' and match a route and everything beneath it, so a new
// sub-page under an already-protected area inherits its protection instead of
// arriving unguarded.
const ROUTE_PERMISSIONS: ReadonlyArray<readonly [string, string]> = [
  // Administration (M2). Declared explicitly rather than relying on the
  // system-administrator exemption for undeclared routes: that exemption exists
  // so a NEW page is reachable before its permission is written, not as the way
  // finished pages are protected. Declaring them also means the permission can
  // be granted to someone who is not a system administrator.
  ['/admin/roles', 'role.view'],
  ['/admin/users', 'user.view'],
  ['/admin/reset-data', 'system.reset_data'],
  ['/admin/migration', 'system.migrate_members'],
  ['/admin/audit-log', 'audit.view'],
  // What the Society sent to members (S-904). Its own permission rather than
  // audit.view's: an officer about to ring a member who never replied needs
  // to know the email bounced, which is not a reason to give them the whole
  // audit trail.
  ['/admin/notifications', 'notification.view'],
  // The API reference (S-110). Its own permission because its audience is
  // whoever integrates with this system, who is often not the person who
  // administers roles. Note what it does NOT govern: a request made from that
  // page goes through the same middleware and the same per-endpoint
  // permission as any other caller, so the page can only ever do what the
  // officer using it could already do.
  ['/admin/api', 'api.explore'],
  // Issuing a credential creates a caller that reaches the system with no
  // person behind it, which is a different kind of act from reading the API
  // reference — so a different permission, and a narrower one (S-909).
  ['/admin/api-credentials', 'api_credential.manage'],

  // Reference configuration (M2 Feature 2.2). A prefix rule: every page under
  // it needs config.view to read, and each page checks config.manage itself
  // before it will change anything. Viewing what the fees are is a different
  // thing from setting them.
  ['/admin/configuration/', 'config.view'],
  // Bank accounts (S-1901): its own permission because an account number is
  // not a fee schedule. The longer prefix wins over the section rule above.
  ['/admin/configuration/bank-accounts', 'bank_account.view'],
  // The fee schedules (officer feedback): their own read permission, so a
  // Treasurer, who owns them (S-207), reaches this page and no other part
  // of Configuration.
  ['/admin/configuration/fees', 'fee.view'],

  // Membership applications (M3). A prefix rule so a sub-page added later is
  // covered. Capturing, submitting, reviewing and approving are separate
  // permissions the pages check themselves — being able to see an application
  // is not being able to act on it.
  ['/applications/', 'application.view'],
  ['/members/', 'member.view'],
  // The document directory (officer feedback): every member's filed papers,
  // reached from the dashboard and the menu. document.view is what the
  // member page's own Documents already need.
  ['/documents/', 'document.view'],
  // An account's balance and history (S-1309, S-1311): money has its own
  // permission, held by default by everyone who may see a member, and
  // removable from a role without taking the member's page away.
  ['/accounts/', 'account.view'],
  // Transactions (M13, M14). Seeing one, or the queue of what waits, is
  // transaction.view; starting one from a number rather than a person
  // (officer feedback) is transaction.capture, on the exact pages that do
  // it. Acting at a step is checked by the review page itself
  // (transaction.review, transaction.approve, transaction.post).
  ['/transactions/', 'transaction.view'],
  ['/transactions/deposit', 'transaction.capture'],
  ['/transactions/withdrawal', 'transaction.capture'],
  ['/transactions/transfer', 'transaction.capture'],
  ['/transactions/lookup.json', 'transaction.capture'],
  // A closure request being built (S-1702): the officer's own wizard,
  // reached from the member's page. Reviewing one is /transactions/<id>.
  ['/closures/', 'transaction.capture'],
  ['/deposits/', 'transaction.capture'],
  ['/resignations/', 'transaction.capture'],
  ['/demises/', 'transaction.capture'],
  // The cash drawer (S-2001): opening and closing your own is cash.session;
  // seeing every drawer is the separate, wider cash.view.
  ['/cashier', 'cash.session'],
  ['/cashier/sessions', 'cash.view'],
  // Details a member sent from the app (docs/member-app.md). Seeing the
  // queue is member.view like the rest of /members; acting on one needs
  // member.details_verify, which the page checks itself — the same split
  // as viewing an application against approving it.
  ['/members/details-updates', 'member.view'],

  // Reports (M9). A prefix rule: report.view reaches the page, and each
  // report additionally checks the data permission it names — member.view,
  // payment.view, audit.view — so a URL typed by hand is not a way past the
  // permission that governs the data underneath.
  ['/reports/', 'report.view'],

  // Receipts (M5). Reading a receipt is payment.view; auditing the sequence is
  // the Treasurer's own permission. The longer prefix wins, so the exact rule
  // for the reconciliation page tightens the broader one rather than being
  // shadowed by it.
  ['/receipts/', 'payment.view'],
  ['/receipts/reconciliation', 'receipt.reconcile'],

  // Further modules are added here as they land (members, financing,
  // documents, ...). The order does not matter: the longest matching prefix
  // wins, so a more specific rule can tighten a broader one.
];

export type RoutePermissions = ReadonlyArray<readonly [string, string]>;

export function requiredPermissionFor(
  pathname: string,
  routes: RoutePermissions = ROUTE_PERMISSIONS
): string | undefined {
  let match: { prefix: string; permission: string } | undefined;

  for (const [prefix, permission] of routes) {
    const matches = prefix.endsWith('/')
      ? pathname === prefix.slice(0, -1) || pathname.startsWith(prefix)
      : pathname === prefix;

    if (matches && (!match || prefix.length > match.prefix.length)) {
      match = { prefix, permission };
    }
  }

  return match?.permission;
}

// Decide whether a principal may reach a path.
//
// A system administrator passes an undeclared route — someone has to be able
// to reach a newly added page before its permission exists — but is NOT
// exempted from a declared one. An explicit permission means what it says;
// bypassing it for one role would make the map advisory rather than binding.
// `routes` is injectable so the rules can be tested against a representative
// map, and the tests also exercise the live map — a security property checked
// only against a fixture is one nobody has confirmed the application uses.
export function authorise(
  principal: Principal,
  pathname: string,
  routes: RoutePermissions = ROUTE_PERMISSIONS
): Decision {
  const required = requiredPermissionFor(pathname, routes);

  if (required === undefined) {
    if (OPEN_TO_ALL_USERS.has(pathname)) return { allowed: true };
    if (isSystemAdministrator(principal)) return { allowed: true };
    return { allowed: false, reason: 'undeclared-route' };
  }

  if (hasPermission(principal, required)) return { allowed: true };

  return { allowed: false, reason: 'missing-permission', required };
}
