// Capture a signed-in session for the functional suite, once per role.
//
// This exists because signing in through Entra cannot reliably be scripted:
// MFA, conditional access and Microsoft's own changing login pages all defeat
// a typed password, and a suite that depends on one breaks for reasons that
// have nothing to do with this application. So a person signs in, in a real
// browser, and the session is saved for the tests to reuse.
//
//   pnpm e2e:login officer
//   pnpm e2e:login            (every role in turn)
//
// The saved file is a live session for a real account. It is git-ignored, and
// the application's own eight-hour expiry applies — the suite refuses a
// session older than seven.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';

const ROLES = ['officer', 'secretary', 'president', 'treasurer', 'admin'];

const LABELS: Record<string, string> = {
  officer: 'Regional Officer',
  secretary: 'Secretary',
  president: 'President / Chairperson',
  treasurer: 'Treasurer',
  admin: 'System Administrator',
};

const BASE_URL = process.env.E2E_BASE_URL;

async function capture(role: string): Promise<void> {
  const statePath = path.join('e2e', '.auth', `${role}.json`);

  console.log(`\n── ${LABELS[role]} ──`);
  console.log(`Sign in as an account holding the ${role} role.`);
  console.log('The browser closes by itself once you are through.\n');

  // Headed, and with no timeout worth speaking of: a person is doing this, and
  // finding a phone for a one-time code takes as long as it takes.
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/login`);

  // Signed in is "reached a page inside the application that is not /login".
  await page.waitForURL(
    url =>
      !url.pathname.startsWith('/login') &&
      url.origin === new URL(BASE_URL!).origin,
    { timeout: 10 * 60 * 1000 }
  );
  // And confirmed by something only a signed-in page has.
  await page.getByRole('button', { name: 'User menu' }).waitFor({
    timeout: 60_000,
  });

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  await context.storageState({ path: statePath });
  await browser.close();

  console.log(`Saved ${statePath}`);
}

async function main(): Promise<void> {
  if (!BASE_URL) {
    console.error(
      'E2E_BASE_URL must be set to the deployment you are testing, e.g.\n' +
        '  E2E_BASE_URL=https://test.example pnpm e2e:login officer'
    );
    process.exit(2);
  }

  const requested = process.argv.slice(2);
  const roles = requested.length > 0 ? requested : ROLES;

  for (const role of roles) {
    if (!ROLES.includes(role)) {
      console.error(`Unknown role "${role}". One of: ${ROLES.join(', ')}`);
      process.exit(2);
    }
  }

  for (const role of roles) await capture(role);

  console.log('\nDone. Run the suite with:  pnpm e2e');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
