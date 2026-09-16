// Shared machinery: a page signed in as a given role, and the data the suite
// invents.
import { test as base, expect, type Page } from '@playwright/test';
import { ROLE_SPECS, storageStatePath, type Role } from './roles';

// Everything this suite creates carries this, so a person looking at the Test
// database afterwards can tell the suite's rows from an officer's real ones,
// and so a second run does not collide with the first.
export const RUN_ID = (
  process.env.E2E_RUN_ID ?? `T${Date.now().toString(36).toUpperCase()}`
).slice(0, 12);

// Invented, and visibly so. Real-looking personal data in a shared Test
// database gets mistaken for a real member sooner or later, and a name that
// announces itself as a test does not.
export function applicant(suffix: string) {
  return {
    surname: `Testcase-${RUN_ID}`,
    name: suffix,
    // Mauritian NIC shape, deliberately not a valid one.
    nic: `T${RUN_ID}${suffix}`.slice(0, 14).toUpperCase(),
    mobile: '57000000',
    email: `no-reply+${RUN_ID}@example.invalid`,
    address: `${suffix} Test Street, Port Louis`,
  };
}

type Fixtures = {
  as: (role: Role) => Promise<Page>;
};

export const test = base.extend<Fixtures>({
  as: async ({ browser }, use) => {
    const open: Page[] = [];

    await use(async (role: Role) => {
      const context = await browser.newContext({
        storageState: storageStatePath(role),
      });
      const page = await context.newPage();
      open.push(page);

      // Signed in as the right person, and holding the role the step needs.
      // Checked once per page rather than assumed: the commonest reason this
      // suite fails on a fresh environment is an account that exists but was
      // never granted its role, and saying so here beats a mystified failure
      // three steps into a journey.
      await page.goto('/');
      if (page.url().includes('/login')) {
        throw new Error(
          `Not signed in as ${ROLE_SPECS[role].label}. The saved session is ` +
            'expired or was captured against a different deployment.'
        );
      }
      return page;
    });

    for (const page of open) await page.context().close();
  },
});

export { expect };

/**
 * Fill every field the form marks mandatory, whatever they are.
 *
 * Deliberately not a hardcoded list. Which fields an Individual application
 * asks for is configuration (S-205), and the Society can change it from
 * Configuration → Membership types without a release — so a suite naming six
 * fields would pass on the deployment it was written against and fail on the
 * one it is meant to test. The form marks each mandatory input
 * `data-mandatory="yes"`, which is the system's own answer to "what must be
 * filled", so this asks it rather than assuming.
 *
 * Values are derived from the field key, because a NIC box and an email box
 * reject each other's contents. Anything unrecognised gets text, which is what
 * a new text field would want anyway.
 */
export async function fillEveryMandatoryField(
  page: Page,
  person: ReturnType<typeof applicant>
): Promise<string[]> {
  const fields = page.locator('[data-mandatory="yes"]');
  const count = await fields.count();

  expect(
    count,
    'The capture form marks no field as mandatory. Either this membership ' +
      'type has no mandatory fields configured, or the form is not rendering ' +
      'its configuration.'
  ).toBeGreaterThan(0);

  const filled: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const field = fields.nth(i);
    const name = (await field.getAttribute('name')) ?? '';
    const key = name.split('.').pop() ?? '';
    const tag = await field.evaluate(el => el.tagName.toLowerCase());

    if (tag === 'select') {
      // The first real option. A configured select's own values are the only
      // ones it accepts, so anything invented here would be rejected.
      const value = await field
        .locator('option')
        .evaluateAll(
          options =>
            (options as HTMLOptionElement[]).find(o => o.value !== '')?.value ??
            ''
        );
      expect(value, `The ${key} list offers nothing to choose.`).not.toBe('');
      await field.selectOption(value);
      filled.push(`${name}=${value}`);
      continue;
    }

    const type = (await field.getAttribute('type')) ?? 'text';
    const value = valueFor(key, type, person);
    await field.fill(value);
    filled.push(`${name}=${value}`);
  }

  return filled;
}

function valueFor(
  key: string,
  type: string,
  person: ReturnType<typeof applicant>
): string {
  if (type === 'date') return '1990-01-15';
  if (type === 'number') return '25000';
  if (type === 'email' || key.includes('email')) return person.email;
  if (type === 'tel' || key.includes('mobile') || key.includes('telephone')) {
    return person.mobile;
  }
  if (key.includes('nic')) return person.nic;
  if (key.includes('surname')) return person.surname;
  if (key.includes('address')) return person.address;
  if (key === 'name' || key.endsWith('_name')) return person.name;
  return `${person.name} ${RUN_ID}`;
}

/**
 * Fill one named field, when a test cares about a specific one.
 *
 * Addressed by input name rather than by label. The names come straight from
 * the membership type's own field keys, so they are the system's actual
 * contract — and a test that breaks because a field key changed is reporting
 * something real, where one that breaks because a label was reworded is noise.
 */
export async function fillField(
  page: Page,
  subject: string,
  key: string,
  value: string
): Promise<void> {
  const field = page.locator(`[name="field.${subject}.1.${key}"]`);
  await expect(
    field,
    `The capture form has no ${key} field for the ${subject}. Either the ` +
      'membership type is configured differently on this deployment, or the ' +
      'field has been removed.'
  ).toBeVisible();
  await field.fill(value);
}

/** The reference of the application currently open, read from the page. */
export async function referenceOnPage(page: Page): Promise<string> {
  await page.waitForLoadState('domcontentloaded');
  const heading = await page.textContent('body');
  const match = heading?.match(/APP-\d{4}-\d{6}/);
  expect(
    match,
    'No application reference on the page. Expected one in the form ' +
      'APP-YYYY-NNNNNN.'
  ).not.toBeNull();
  return match![0];
}

/**
 * File something against every required document the checklist still wants.
 *
 * Which documents an application needs is configuration (S-208), and differs
 * per membership type and per deployment, so this reads the checklist the page
 * is showing rather than naming documents. Optional items are left alone —
 * that is what optional means, and leaving them proves the submit gate counts
 * only the required ones.
 *
 * The file input is `sr-only` and disabled until the page's own script enables
 * it (CLAUDE.md: hide the control, drive it from a label), which is why this
 * needs a real browser rather than a form post.
 */
export async function uploadOutstandingDocuments(
  page: Page,
  filePath: string
): Promise<string[]> {
  const uploaded: string[] = [];

  const outstanding = () =>
    page
      .locator('li')
      .filter({ has: page.locator('[data-upload]') })
      .filter({ hasText: 'Missing' })
      .filter({ hasText: 'required' });

  // Bounded rather than `while (true)`: if filing one never clears it, the
  // suite should say so rather than upload for ever.
  for (let round = 0; round < 12; round += 1) {
    const before = await outstanding().count();
    if (before === 0) break;

    const item = outstanding().first();
    const label = ((await item.textContent()) ?? '')
      .replace(/\s+/g, ' ')
      .replace(/Missing.*$/, '')
      .trim();

    await item.locator('[data-file]').setInputFiles(filePath);

    // Waited on as a COUNT, not on the row itself. The filtered locator
    // re-resolves after the page updates, so "this row is no longer Missing"
    // would silently re-point at the next outstanding row and never come
    // true. One fewer outstanding is the thing actually being claimed.
    //
    // The row changes state when the file is confirmed present in SharePoint,
    // which is what S-408 makes the definition of filed: the bytes go browser
    // to Microsoft, and only Microsoft's own answer counts.
    await expect(
      outstanding(),
      `Filing a document against "${label}" did not clear it. The upload ` +
        'either failed or was not confirmed by SharePoint.'
    ).toHaveCount(before - 1, { timeout: 30_000 });

    uploaded.push(label);
  }

  return uploaded;
}
