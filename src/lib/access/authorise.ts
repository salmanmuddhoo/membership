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

  // Reference configuration (M2 Feature 2.2). A prefix rule: every page under
  // it needs config.view to read, and each page checks config.manage itself
  // before it will change anything. Viewing what the fees are is a different
  // thing from setting them.
  ['/admin/configuration/', 'config.view'],

  // Membership applications (M3). A prefix rule so a sub-page added later is
  // covered. Capturing, submitting, reviewing and approving are separate
  // permissions the pages check themselves — being able to see an application
  // is not being able to act on it.
  ['/applications/', 'application.view'],
  ['/members/', 'member.view'],

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
