import { describe, expect, it } from 'vitest';
import { authorise, requiredPermissionFor } from './authorise';
import type { Principal } from './principal';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: '00000000-0000-0000-0000-000000000001',
    entraSubject: 'sub-1',
    email: 'officer@albarakah.mu',
    displayName: 'Officer',
    roles: [],
    permissions: new Set(),
    ...overrides,
  };
}

// A path chosen so the live map does not claim it. The tests below assert
// that first: as modules land, a prefix rule can quietly start covering
// whatever fixture path was picked years earlier, and the test would then fail
// for a reason that has nothing to do with what it is checking. /members/
// was exactly that until M3 declared it.
const UNDECLARED = '/nothing-has-declared-this';

describe('deny by default (S-108)', () => {
  it('has a fixture path the live map really does not cover', () => {
    expect(requiredPermissionFor(UNDECLARED)).toBeUndefined();
  });

  it('refuses an ordinary user a route nobody declared', async () => {
    // The property that matters: shipping a page and forgetting to protect it
    // produces a refusal, not an open door.
    const decision = authorise(principal(), UNDECLARED);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe('undeclared-route');
  });

  it('refuses even a user who holds unrelated permissions', async () => {
    const decision = authorise(
      principal({ permissions: new Set(['member.create', 'payment.record']) }),
      UNDECLARED
    );

    expect(decision.allowed).toBe(false);
  });

  it('lets a system administrator through an undeclared route', async () => {
    // Someone has to reach a newly added page before its permission exists.
    const decision = authorise(
      principal({ roles: ['system_administrator'] }),
      UNDECLARED
    );

    expect(decision.allowed).toBe(true);
  });

  it('allows the routes open to every signed-in user', async () => {
    expect(authorise(principal(), '/dashboard').allowed).toBe(true);
  });
});

// A representative map, so the rules are exercised rather than described. The
// live map is exercised separately, in 'the live route map' below.
const ROUTES = [
  ['/members/', 'member.view'],
  ['/members/new', 'member.create'],
  ['/payments/', 'payment.record'],
] as const;

describe('declared routes', () => {
  it('grants when the principal holds the required permission', () => {
    const decision = authorise(
      principal({ permissions: new Set(['member.view']) }),
      '/members/ABM-000001',
      ROUTES
    );
    expect(decision.allowed).toBe(true);
  });

  it('refuses, and names the permission that was missing', () => {
    const decision = authorise(
      principal({ permissions: new Set(['payment.record']) }),
      '/members/ABM-000001',
      ROUTES
    );

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe('missing-permission');
    expect(decision.required).toBe('member.view');
  });

  it('protects everything beneath a declared prefix', () => {
    // A sub-page added later inherits protection instead of arriving unguarded.
    expect(requiredPermissionFor('/members/ABM-1/documents/3', ROUTES)).toBe(
      'member.view'
    );
    // And the prefix covers the bare path too.
    expect(requiredPermissionFor('/members', ROUTES)).toBe('member.view');
  });

  it('lets the most specific rule tighten a broader one', () => {
    // /members/ requires member.view, but /members/new requires member.create.
    expect(requiredPermissionFor('/members/new', ROUTES)).toBe('member.create');

    const viewer = principal({ permissions: new Set(['member.view']) });
    expect(authorise(viewer, '/members/new', ROUTES).allowed).toBe(false);
  });

  it('treats an unmatched path as having no requirement', () => {
    expect(requiredPermissionFor('/nothing/here', ROUTES)).toBeUndefined();
  });
});

describe('a declared permission binds everyone', () => {
  it('does not exempt a system administrator from an explicit requirement', () => {
    // A route in the map means what it says. If the administrator role bypassed
    // declared permissions, the map would be advisory rather than binding, and
    // an administrator could perform an action nobody granted them.
    const admin = principal({ roles: ['system_administrator'] });

    const decision = authorise(admin, '/members/ABM-000001', ROUTES);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.required).toBe('member.view');
  });

  it('still lets that administrator through an UNdeclared route', () => {
    // The exemption is narrow: it covers only routes with no rule at all.
    const admin = principal({ roles: ['system_administrator'] });
    expect(authorise(admin, '/brand-new-page', ROUTES).allowed).toBe(true);
  });
});

describe('the live route map', () => {
  // These assert the REAL map, not a fixture. The administration pages exist
  // and are reachable from the sidebar, so what they require has to be true —
  // a menu entry whose permission does not match the route's is how a person
  // ends up clicking a link and being refused.
  it('protects the administration pages by name', () => {
    expect(requiredPermissionFor('/admin/roles')).toBe('role.view');
    expect(requiredPermissionFor('/admin/users')).toBe('user.view');
    expect(requiredPermissionFor('/admin/reset-data')).toBe(
      'system.reset_data'
    );
  });

  it('covers every configuration page with one prefix rule', () => {
    // The index and each section, including ones added later: a rule that
    // covered only the pages listed today would leave the next one open to
    // whoever the undeclared-route exemption admits.
    expect(requiredPermissionFor('/admin/configuration')).toBe('config.view');
    for (const page of [
      '/admin/configuration/membership-types',
      '/admin/configuration/account-types',
      '/admin/configuration/fees',
      '/admin/configuration/checklists',
      '/admin/configuration/workflows',
      '/admin/configuration/something-added-later',
    ]) {
      expect(requiredPermissionFor(page)).toBe('config.view');
    }
  });

  it('separates seeing the configuration from changing it', () => {
    // config.view opens the pages; each page checks config.manage itself
    // before it will write. Someone granted only the first can read what the
    // fees are without being able to set them.
    const viewer = principal({ permissions: new Set(['config.view']) });
    expect(authorise(viewer, '/admin/configuration/fees').allowed).toBe(true);

    const manager = principal({ permissions: new Set(['config.manage']) });
    expect(authorise(manager, '/admin/configuration/fees').allowed).toBe(false);
  });

  it('does not rely on the system-administrator exemption for them', () => {
    // The exemption exists so a NEW page is reachable before its permission is
    // written. A finished page relying on it could not be delegated to anyone
    // who is not a system administrator.
    const admin = principal({ roles: ['system_administrator'] });

    expect(authorise(admin, '/admin/roles').allowed).toBe(false);
    expect(authorise(admin, '/admin/users').allowed).toBe(false);
    expect(authorise(admin, '/admin/configuration').allowed).toBe(false);
    expect(authorise(admin, '/admin/configuration/fees').allowed).toBe(false);
  });

  it('admits someone holding only the declared permission', () => {
    const viewer = principal({ permissions: new Set(['role.view']) });

    expect(authorise(viewer, '/admin/roles').allowed).toBe(true);
    // ...and not the page they were not granted.
    expect(authorise(viewer, '/admin/users').allowed).toBe(false);
  });

  // M5. Reading a receipt and auditing the sequence are different jobs, and
  // the exact rule for the reconciliation page has to beat the prefix rule
  // that would otherwise let any receipt reader in.
  it('separates reading a receipt from auditing the sequence', () => {
    expect(requiredPermissionFor('/receipts/some-uuid')).toBe('payment.view');
    expect(requiredPermissionFor('/receipts/reconciliation')).toBe(
      'receipt.reconcile'
    );

    const officer = principal({ permissions: new Set(['payment.view']) });
    expect(authorise(officer, '/receipts/some-uuid').allowed).toBe(true);
    expect(authorise(officer, '/receipts/reconciliation').allowed).toBe(false);

    const treasurer = principal({
      permissions: new Set(['payment.view', 'receipt.reconcile']),
    });
    expect(authorise(treasurer, '/receipts/reconciliation').allowed).toBe(true);
  });
});
