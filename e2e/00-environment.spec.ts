// The guard, and it runs first.
//
// Every spec after this one creates member records, takes payments and issues
// receipt numbers. Against Production that is not a test, it is corruption of
// the Society's own books — and a receipt serial, once consumed, cannot be
// given back (S-502). So this establishes that the target is not Production
// before anything else is allowed to run, and the badge it reads is the same
// one an officer looks at to answer the same question.
import { expect, test } from './fixtures';

test.describe('before anything is written', () => {
  test('the deployment identifies itself as NOT production', async ({ as }) => {
    const page = await as('admin');

    const badge = page.locator('span[title*="environment"]').first();

    await expect(
      badge,
      'This deployment shows no environment badge, which is how Production ' +
        'presents itself. This suite writes real member data, so it will not ' +
        'run against it. If this IS a test deployment, PUBLIC_APP_ENV is ' +
        'unset on it — fix that before testing anything else, because an ' +
        'officer has no way to tell either.'
    ).toBeVisible();

    const label = ((await badge.textContent()) ?? '').trim().toUpperCase();
    expect(label, `The badge reads "${label}". Refusing to run.`).not.toBe(
      'PRODUCTION'
    );
  });

  test('the database and its integrations answer', async ({ as }) => {
    const page = await as('admin');
    const response = await page.request.get('/api/v1/health');

    expect(
      response.ok(),
      `Health returned ${response.status()}. Nothing below this will mean ` +
        'anything until the deployment is reachable and its database is up.'
    ).toBe(true);

    const body = await response.json();
    // Reported rather than asserted: an environment without SharePoint
    // configured is a legitimate state to test most of the system in, and the
    // document specs say so themselves when they skip.
    console.log('[health]', JSON.stringify(body));
  });

  test('a signed-in officer reaches their own dashboard', async ({ as }) => {
    const page = await as('officer');
    await expect(page).not.toHaveURL(/\/login|\/denied/);
    await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
  });
});
