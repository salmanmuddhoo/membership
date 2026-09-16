// Getting signed in, five times, before anything else runs.
//
// Three modes, because the honest answer to "can a script sign in through
// Entra" is "it depends on what your tenant asks for":
//
//   manual   (default) — a person signs in once per role, in a real browser,
//                        and the session is saved. Survives MFA, conditional
//                        access, a changed Microsoft login page, anything:
//                        whatever a person can do, this can use. Capture with
//                        `pnpm e2e:login`.
//
//   password          — the script types the credentials. Only works where the
//                        test accounts have no MFA and no conditional access,
//                        which is worth knowing either way: if this mode
//                        cannot sign in, neither could anything else
//                        automated.
//
//   local             — no Entra at all. Mints the session cookie directly
//                        against a local AUTH_SESSION_SECRET. For running the
//                        suite against a developer's own machine; it proves
//                        every screen and journey, and proves nothing about
//                        sign-in.
//
// Whichever mode, the result is the same: five saved sessions the functional
// specs pick up.
import { expect, test as setup } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ROLES, ROLE_SPECS, storageStatePath, type Role } from './roles';

type Mode = 'manual' | 'password' | 'local';

const MODE = (process.env.E2E_AUTH_MODE ?? 'manual') as Mode;

function envFor(role: Role, key: string): string | undefined {
  return process.env[`E2E_${role.toUpperCase()}_${key}`];
}

// Fresh enough to still be valid for the run. A saved session older than the
// application's own eight hours is expired, and failing here with that said
// plainly beats every spec failing at a redirect to /login.
const MAX_SESSION_AGE_MS = 7 * 60 * 60 * 1000;

async function signInWithPassword(
  page: import('@playwright/test').Page,
  role: Role
): Promise<void> {
  const email = envFor(role, 'EMAIL');
  const password = envFor(role, 'PASSWORD');
  if (!email || !password) {
    throw new Error(
      `E2E_${role.toUpperCase()}_EMAIL and E2E_${role.toUpperCase()}_PASSWORD ` +
        'must be set in password mode.'
    );
  }

  await page.goto('/login');
  await page.getByRole('link', { name: /sign in/i }).click();

  // Microsoft's own pages. Deliberately loose selectors: this markup is not
  // ours and changes without notice, and a failure here means "switch to
  // manual mode", not "the application is broken".
  await page.fill('input[type="email"]', email);
  await page.getByRole('button', { name: /next/i }).click();
  await page.fill('input[type="password"]', password);
  await page.getByRole('button', { name: /sign in/i }).click();

  const staySignedIn = page.getByRole('button', { name: /^yes$/i });
  if (await staySignedIn.isVisible().catch(() => false)) {
    await staySignedIn.click();
  }
}

async function signInLocally(
  context: import('@playwright/test').BrowserContext,
  role: Role,
  baseURL: string
): Promise<void> {
  const secret = process.env.AUTH_SESSION_SECRET;
  const subject = envFor(role, 'SUBJECT');
  const email = envFor(role, 'EMAIL');
  if (!secret || !subject || !email) {
    throw new Error(
      'Local mode needs AUTH_SESSION_SECRET and, per role, ' +
        `E2E_${role.toUpperCase()}_SUBJECT and E2E_${role.toUpperCase()}_EMAIL.`
    );
  }

  // Imported here rather than at the top so the other two modes, which are
  // what runs against a deployment, never load a signing library at all.
  const { SignJWT } = await import('jose');
  const token = await new SignJWT({ email, name: role, roles: [] })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(new TextEncoder().encode(secret));

  const url = new URL(baseURL);
  await context.addCookies([
    {
      name: 'ab_session',
      value: token,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      // Matches how the application sets it, except over plain http locally,
      // where a secure cookie would never be sent back.
      secure: url.protocol === 'https:',
      sameSite: 'Lax',
    },
  ]);
}

for (const role of ROLES) {
  setup(`sign in as ${ROLE_SPECS[role].label}`, async ({ page, context }) => {
    const statePath = storageStatePath(role);
    const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4321';

    if (MODE === 'manual') {
      // Nothing to do but check the saved session is there and usable. The
      // capture step is a person's job, once.
      if (!fs.existsSync(statePath)) {
        throw new Error(
          `No saved session for ${ROLE_SPECS[role].label}.\n` +
            `Run:  pnpm e2e:login ${role}\n` +
            'and sign in as an account holding the ' +
            `${ROLE_SPECS[role].roleCode} role.`
        );
      }
      const age = Date.now() - fs.statSync(statePath).mtimeMs;
      if (age > MAX_SESSION_AGE_MS) {
        throw new Error(
          `The saved session for ${ROLE_SPECS[role].label} is ` +
            `${Math.round(age / 3_600_000)} hours old and the application ` +
            'signs people out after eight.\n' +
            `Run:  pnpm e2e:login ${role}`
        );
      }
      return;
    }

    if (MODE === 'local') {
      await signInLocally(context, role, baseURL);
    } else {
      await signInWithPassword(page, role);
    }

    // Whatever got us here, prove it actually worked before saving it. A
    // storage state captured from a failed sign-in is the kind of thing that
    // makes every later spec fail somewhere far away from the cause.
    await page.goto('/');
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();

    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await context.storageState({ path: statePath });
  });
}
