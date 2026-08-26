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

describe('deny by default (S-108)', () => {
  it('refuses an ordinary user a route nobody declared', async () => {
    // The property that matters: shipping a page and forgetting to protect it
    // produces a refusal, not an open door.
    const decision = authorise(principal(), '/members/secret-new-page');

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe('undeclared-route');
  });

  it('refuses even a user who holds unrelated permissions', async () => {
    const decision = authorise(
      principal({ permissions: new Set(['member.create', 'payment.record']) }),
      '/reports/unlisted'
    );

    expect(decision.allowed).toBe(false);
  });

  it('lets a system administrator through an undeclared route', async () => {
    // Someone has to reach a newly added page before its permission exists.
    const decision = authorise(
      principal({ roles: ['system_administrator'] }),
      '/members/secret-new-page'
    );

    expect(decision.allowed).toBe(true);
  });

  it('allows the routes open to every signed-in user', async () => {
    expect(authorise(principal(), '/dashboard').allowed).toBe(true);
  });
});

// A representative map, so the rules are exercised rather than described. The
// live map is empty until the first module lands.
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
