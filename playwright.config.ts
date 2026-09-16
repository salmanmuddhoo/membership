// Functional tests against a running deployment (S-1004 support, manual QA).
//
// These are NOT the unit suite. `pnpm test` proves the code; this proves a
// DEPLOYMENT — the real Entra sign-in, the real database, the real SharePoint
// tenant, served the way Vercel actually serves it. Nothing here mocks
// anything, which is the point and also the reason it writes real data.
//
// Run it against Test. There is a guard in 00-environment.spec.ts that stops
// the run if the target does not identify itself as non-production, because
// every spec after it creates member records.
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4321';

// Normally leave this unset and let `npx playwright install chromium` put the
// browser where Playwright expects it. It exists for a container that already
// ships one at a fixed path, where the bundled version will not match and
// there is nowhere to download to.
const launch = process.env.E2E_CHROMIUM_PATH
  ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH } }
  : {};

export default defineConfig({
  testDir: './e2e',
  // One worker. These tests share one database and one workflow chain: an
  // application being approved by one worker while another reads the pending
  // count is a flake nobody can reproduce, and the suite is short enough that
  // parallelism buys little.
  workers: 1,
  fullyParallel: false,
  // A failing functional test is a bug report, not a flake to paper over.
  // Retrying would hide an intermittent defect, which is exactly the kind
  // worth finding.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: 'e2e-report', open: 'never' }]],
  use: {
    baseURL,
    // Evidence for the bug report. A functional failure that cannot be shown
    // to somebody is an argument; a trace and a video is a finding.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...launch },
    },
    {
      name: 'functional',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], ...launch },
    },
  ],
});
