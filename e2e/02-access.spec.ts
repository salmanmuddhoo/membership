// Who can reach what — checked as each role, against the deployment.
//
// The unit suite already proves the route map is complete and deny-by-default.
// What it cannot prove is that THIS deployment's roles hold the permissions
// the Society thinks they do: the role-to-permission grants are configuration,
// edited from Configuration → Roles, and a well-meaning "just give them access
// so they can get on" is exactly the change nobody writes a unit test for.
//
// So these are read as a report on the deployment's own configuration rather
// than as a specification. Where a role's access is a judgement call, the
// result is logged; where it is a control the Society relies on, it is
// asserted.
import { expect, test } from './fixtures';
import { ROLES, ROLE_SPECS, type Role } from './roles';

// Pages a role should not reach. Each is a control somebody would be relying
// on, not a preference.
const MUST_BE_DENIED: Array<{ role: Role; path: string; why: string }> = [
  {
    role: 'officer',
    path: '/admin/roles',
    why: 'An officer who can grant themselves permissions has every permission.',
  },
  {
    role: 'officer',
    path: '/admin/users',
    why: 'Creating staff accounts is not a capture officer’s job.',
  },
  {
    role: 'officer',
    path: '/admin/api-credentials',
    why:
      'An API credential reaches the system with no person behind it. ' +
      'Issuing one is a narrower act than anything capture involves.',
  },
  {
    role: 'treasurer',
    path: '/admin/roles',
    why: 'Same reason as the officer: self-granted permissions are no control.',
  },
  {
    role: 'president',
    path: '/admin/users',
    why:
      'Deciding applications is not administering accounts. The President ' +
      'approving their own new staff account would defeat segregation.',
  },
  {
    role: 'secretary',
    path: '/admin/reset-data',
    why: 'Resetting the environment wipes every application and member.',
  },
];

// Pages a role must reach, or they cannot do their job at all. A failure here
// is usually a missing grant on this deployment rather than a code defect.
const MUST_BE_ALLOWED: Array<{ role: Role; path: string; why: string }> = [
  {
    role: 'officer',
    path: '/applications',
    why: 'Capture is their whole job.',
  },
  { role: 'secretary', path: '/applications', why: 'They review them.' },
  { role: 'president', path: '/applications', why: 'They decide them.' },
  {
    role: 'treasurer',
    path: '/receipts/reconciliation',
    why:
      'Gaps and duplicates in the receipt sequence are the Treasurer’s own ' +
      'control (S-502), and nobody else is looking.',
  },
  {
    role: 'admin',
    path: '/admin/roles',
    why: 'Administering roles is the role.',
  },
  {
    role: 'admin',
    path: '/admin/audit-log',
    why: 'The trail has to be readable.',
  },
];

test.describe('what each role can reach', () => {
  for (const { role, path, why } of MUST_BE_DENIED) {
    test(`${ROLE_SPECS[role].label} is refused ${path}`, async ({ as }) => {
      const page = await as(role);
      await page.goto(path);

      expect(
        page.url(),
        `${ROLE_SPECS[role].label} reached ${path}. ${why} Check ` +
          'Configuration → Roles on this deployment.'
      ).toContain('/denied');
    });
  }

  for (const { role, path, why } of MUST_BE_ALLOWED) {
    test(`${ROLE_SPECS[role].label} can reach ${path}`, async ({ as }) => {
      const page = await as(role);
      const response = await page.goto(path);

      expect(
        page.url(),
        `${ROLE_SPECS[role].label} was refused ${path}. ${why} The account ` +
          `needs the ${ROLE_SPECS[role].roleCode} role and that role needs ` +
          'the permission this page declares.'
      ).not.toContain('/denied');

      // Not refused is not the same as working. A page that answers 404 or
      // 500 passes a "was I denied" check while being no use to anybody, so
      // the status is asserted too.
      expect(
        response?.status(),
        `${path} answered ${response?.status()} for ` +
          `${ROLE_SPECS[role].label}. ${why}`
      ).toBeLessThan(400);
    });
  }

  test('an unknown page is refused rather than found', async ({ as }) => {
    // Deny by default (S-108). A page nobody declared is not reachable, which
    // is what makes adding one safe.
    const page = await as('admin');
    const response = await page.goto('/not-a-real-page-at-all');

    const status = response?.status() ?? 0;
    expect(
      status === 404 || page.url().includes('/denied'),
      `A page that does not exist answered ${status} and landed on ` +
        `${page.url()}. It should be refused or not found, never rendered.`
    ).toBe(true);
  });

  test('signing out actually ends the session', async ({ as }) => {
    const page = await as('officer');
    await page.goto('/');
    await page.getByRole('button', { name: 'User menu' }).click();

    // By href rather than by role and name: the link sits inside a menu, so
    // its computed role is not the plain `link` the obvious selector asks
    // for, and the destination is the thing this test actually means.
    const signOut = page.locator('a[href="/auth/logout"]');
    await expect(
      signOut,
      'The user menu opened but offers no way to sign out.'
    ).toBeVisible();
    await signOut.click();
    await page.waitForURL(/\/login|logout|microsoftonline/, {
      timeout: 20_000,
    });

    // Back to a page that needs a session. It must not still be readable.
    await page.goto('/applications');
    expect(
      page.url(),
      'After signing out, an internal page was still reachable. The session ' +
        'cookie was not cleared.'
    ).toMatch(/\/login|microsoftonline/);
  });
});

test.describe('the access map, as this deployment has it', () => {
  // Not assertions — a printed report, so whoever is testing can see the whole
  // picture rather than only the lines somebody thought to assert.
  const SURVEY = [
    '/applications',
    '/members',
    '/receipts',
    '/receipts/reconciliation',
    '/reports',
    '/admin/audit-log',
    '/admin/notifications',
    '/admin/api',
    '/admin/api-credentials',
    '/admin/configuration',
    '/admin/configuration/retention',
    '/admin/roles',
    '/admin/users',
  ];

  for (const role of ROLES) {
    test(`what ${ROLE_SPECS[role].label} can open`, async ({ as }) => {
      const page = await as(role);
      const allowed: string[] = [];
      const denied: string[] = [];

      for (const path of SURVEY) {
        const response = await page.goto(path);
        const status = response?.status() ?? 0;
        if (page.url().includes('/denied')) {
          denied.push(path);
        } else {
          // The status is carried through so a page that is reachable but
          // broken does not read the same as one that works.
          allowed.push(status < 400 ? path : `${path} (HTTP ${status})`);
        }
      }

      console.log(
        `\n[access] ${ROLE_SPECS[role].label}\n` +
          `  can open: ${allowed.join(', ') || '(nothing)'}\n` +
          `  refused : ${denied.join(', ') || '(nothing)'}`
      );
    });
  }
});
