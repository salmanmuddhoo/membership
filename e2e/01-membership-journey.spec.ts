// The journey the Society actually does all day: an applicant walks in, and
// some weeks later they are a member with accounts.
//
// Written as one test rather than five, deliberately. The steps are not
// independent — there is no "Secretary reviews an application" without an
// application, and a suite that sets one up by writing rows directly would be
// testing its own fixtures rather than the officers' path through the system.
// So this walks it the way three real people do, signing in as each in turn.
//
// What it proves that a unit test cannot: that the four workflow steps are
// wired to four different people's screens, that the segregation control lets
// the right ones through, and that approval really does produce a member with
// accounts rather than a green message.
import path from 'node:path';
import {
  applicant,
  expect,
  fillEveryMandatoryField,
  referenceOnPage,
  RUN_ID,
  test,
  uploadOutstandingDocuments,
} from './fixtures';

// Any file the upload will accept. Its contents do not matter — what is being
// tested is the filing, not the document.
const SAMPLE = path.join(import.meta.dirname, 'fixtures', 'sample.pdf');

test.describe('an Individual application, capture to member', () => {
  // Shared across the steps below; they run in order in one file, one worker.
  let reference = '';
  let applicationUrl = '';
  let submitted = false;
  let approved = false;
  const person = applicant('Amina');

  test('the officer captures the applicant’s details', async ({ as }) => {
    const page = await as('officer');

    await page.goto('/applications');

    // The type picker and the button that opens the form for it. Individual is
    // the type every deployment has (migration 0010).
    await page.selectOption('select[name="type"]', 'individual');
    await page.getByRole('button', { name: 'Member Registration' }).click();
    await expect(page).toHaveURL(/\/applications\/new\?type=individual/);

    // Nothing exists yet — opening the form is not starting an application,
    // which is S-301's own decision and worth holding the suite to.
    const filled = await fillEveryMandatoryField(page, person);
    console.log(`[capture] filled ${filled.length} mandatory fields`);

    await page.getByRole('button', { name: 'Next' }).first().click();

    // The application comes into existence on that first save, and the officer
    // is now working on its own page without having been interrupted to get
    // there.
    await page.waitForURL(/\/applications\/[0-9a-f-]{36}/);
    applicationUrl = new URL(page.url()).pathname;
    reference = await referenceOnPage(page);

    // Nothing mandatory is outstanding, so the officer has been moved past
    // the details step rather than left on it.
    await expect(
      page.getByText(/required fields? empty/i),
      'Every mandatory field was filled, so none should still be outstanding.'
    ).toHaveCount(0);

    // And what was typed is what was saved. Read back from the details step
    // itself, which the officer has now moved beyond.
    await page.goto(`${applicationUrl}?step=1`);
    await expect(
      page.locator('[name="field.applicant.1.surname"]'),
      'The surname captured a moment ago should still be on the form.'
    ).toHaveValue(person.surname);
  });

  test('it appears in the list, as a draft', async ({ as }) => {
    const page = await as('officer');
    await page.goto('/applications');

    const row = page.locator('tbody tr').filter({ hasText: reference });
    await expect(
      row,
      `${reference} should be in the Applications list after capture.`
    ).toBeVisible();
    await expect(row).toContainText(/draft/i);
  });

  test('the Secretary cannot act on it while it is still a draft', async ({
    as,
  }) => {
    // Not a permission question — the Secretary may review applications. It is
    // a workflow one: nothing has been submitted to them yet, and a draft in
    // an officer's hands is not central processing's to touch.
    const page = await as('secretary');
    await page.goto(applicationUrl);

    await expect(
      page.getByRole('button', { name: 'Forward to the President' })
    ).toHaveCount(0);
  });

  test('the officer files the documents the checklist asks for', async ({
    as,
  }) => {
    const page = await as('officer');
    await page.goto(`${applicationUrl}?step=3`);

    const filed = await uploadOutstandingDocuments(page, SAMPLE);
    console.log(`[documents] filed ${filed.length}: ${filed.join(', ')}`);

    await expect(
      page
        .locator('li')
        .filter({ hasText: 'Missing' })
        .filter({ hasText: 'required' }),
      'Every required document was filed, so none should still read Missing.'
    ).toHaveCount(0);
  });

  test('the officer records the payment, and a receipt is issued', async ({
    as,
  }) => {
    const page = await as('officer');
    await page.goto(`${applicationUrl}?step=4`);

    // The amounts are prefilled from the fee schedule (S-207) — not typed, and
    // deliberately not asserted to a figure here, because what is due is
    // configuration and differs per deployment. What is asserted is that a
    // total was worked out at all.
    const total = await page.textContent('body');
    const due = total?.match(/MUR\s[\d,]+\.\d{2}/)?.[0];
    expect(
      due,
      'The payment step should show a total due, worked out from the fee ' +
        'schedule.'
    ).toBeTruthy();
    console.log(`[payment] total due ${due}`);

    await page.selectOption('select[name="method"]', 'cash');
    await page
      .getByRole('button', { name: 'Record payment and issue receipt' })
      .click();

    // S-502: a receipt number is allocated, and it is the thing the applicant
    // walks out holding. A payment recorded without one is the failure this
    // watches for.
    await page.waitForLoadState('domcontentloaded');
    const body = (await page.textContent('body')) ?? '';
    const receipt = body.match(/R[A-Z0-9-]*\d{3,}/);
    expect(
      receipt,
      'A payment was recorded but no receipt number is shown. The applicant ' +
        'has nothing to walk out with.'
    ).not.toBeNull();
    console.log(`[payment] receipt ${receipt?.[0]}`);
  });

  test('it has left the officer’s hands and reached central processing', async ({
    as,
  }) => {
    const page = await as('officer');
    await page.goto(`${applicationUrl}?step=5`);

    // Submission is always a deliberate click — recording a payment never
    // submits by itself. The button is absent only for someone without
    // application.submit, who leaves it for whoever holds it.
    const submit = page.getByRole('button', {
      name: /^Submit for Processing$/,
    });
    const blocked = page.getByRole('button', {
      name: /Submit \(\d+ items? still need attention\)/,
    });

    if ((await blocked.count()) > 0) {
      const label = (await blocked.textContent())?.trim();
      throw new Error(
        `Submission is blocked: ${label}. Everything the wizard asks for was ` +
          'filled and filed, so this is either a requirement the earlier ' +
          'steps did not surface, or a defect.'
      );
    }

    if ((await submit.count()) > 0) {
      await submit.click();
      await page.waitForLoadState('domcontentloaded');
    }

    // Either way, it is no longer a draft in the officer's hands.
    await page.goto(applicationUrl);
    await expect(
      page.getByText('draft', { exact: true }),
      'The application should have left draft once submitted.'
    ).toHaveCount(0);

    submitted = true;
  });

  test('the Secretary verifies the documents that were filed', async ({
    as,
  }) => {
    test.skip(!submitted, 'The application never reached the Secretary.');

    const page = await as('secretary');
    await page.goto(applicationUrl);

    // Filing a document is not accepting it (S-407). Only the Secretary holds
    // document.verify, so this step cannot be done by whoever uploaded —
    // which is the control, not an inconvenience.
    const verify = page.getByRole('button', { name: 'Verify' });

    for (let round = 0; round < 12; round += 1) {
      const remaining = await verify.count();
      if (remaining === 0) break;

      const form = page
        .locator('form')
        .filter({ has: page.getByRole('button', { name: 'Verify' }) })
        .first();

      // The signed application form carries a confirmation that all four
      // signatures are on the scan, and will not verify without it. Ticking
      // it here is the tester saying they looked — which is exactly what the
      // Secretary is being asked to say, and the reason the control exists.
      const confirmation = form.locator('input[type="checkbox"]');
      if ((await confirmation.count()) > 0) await confirmation.first().check();

      await form.getByRole('button', { name: 'Verify' }).click();
      await page.waitForLoadState('domcontentloaded');

      await expect(
        verify,
        'Verifying a document did not reduce the number still awaiting it. ' +
          'The verification was refused and the page should say why.'
      ).toHaveCount(remaining - 1, { timeout: 20_000 });
    }

    await expect(
      page.getByText(/not yet verified/i),
      'Every filed document was verified, so nothing should still read as ' +
        'not verified.'
    ).toHaveCount(0);
  });

  test('the Secretary forwards it to the President', async ({ as }) => {
    test.skip(!submitted, 'The application never reached the Secretary.');

    const page = await as('secretary');
    await page.goto(applicationUrl);

    const forward = page.getByRole('button', {
      name: 'Forward to the President',
    });
    await expect(
      forward,
      'A submitted application should offer the Secretary their step. If it ' +
        'does not, check that this account holds the secretary role and that ' +
        'the step is enabled in Configuration → Workflows.'
    ).toBeVisible();
    await forward.click();

    await expect(page.getByText(/approval/i).first()).toBeVisible();
  });

  test('the officer who captured it cannot approve it', async ({ as }) => {
    // Segregation of duties (S-203). The strongest version of this test would
    // be an officer who also held the President role; this is the weaker,
    // true-on-every-deployment version: the capturing officer is offered no
    // decision.
    const page = await as('officer');
    await page.goto(applicationUrl);

    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  });

  test('the President approves it, and a member exists', async ({ as }) => {
    test.skip(!submitted, 'The application never reached the President.');

    const page = await as('president');
    await page.goto(applicationUrl);

    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    await expect(approve).toBeVisible();
    await approve.click();

    await expect(
      page.getByText(/approved/i).first(),
      'The application should read as approved once the President decides.'
    ).toBeVisible();

    // Approval is supposed to produce a Member with a number, not a message.
    const memberNo = ((await page.textContent('body')) ?? '').match(/AB\d{4,}/);
    expect(
      memberNo,
      'Approval should have created a member with a membership number. ' +
        'Nothing on the page shows one.'
    ).not.toBeNull();
    console.log(`[approval] member ${memberNo?.[0]}`);
    approved = true;
  });

  test('the new member is findable, with the accounts their membership opened', async ({
    as,
  }) => {
    test.skip(!approved, 'No member was created.');

    const page = await as('officer');
    await page.goto('/members');

    const row = page.locator('tbody tr').filter({ hasText: person.surname });
    await expect(
      row,
      `The approved applicant ${person.surname} should now be on the Members ` +
        'page.'
    ).toBeVisible();

    // S-309: a membership opens the accounts its type configures. Which ones
    // is configuration and differs per deployment, so what is asserted is
    // that it opened at least one — a member with no account at all is the
    // failure worth catching.
    const accounts = row.locator('[data-account-no]');
    await expect(
      accounts,
      'The new member has no account. Approving a membership is supposed to ' +
        'open the accounts the membership type configures.'
    ).not.toHaveCount(0);

    const opened = await accounts.evaluateAll(chips =>
      chips.map(
        c =>
          `${c.getAttribute('data-account-name')} ` +
          `${c.getAttribute('data-account-no')}`
      )
    );
    console.log(`[member] accounts opened: ${opened.join(', ')}`);

    // The row navigates from its own data-href rather than a link inside it,
    // so the click goes on the name cell — clicking the row generally would
    // land on an account chip.
    await row.locator('td').first().click();
    await page.waitForURL(/\/members\/[0-9a-f-]{36}/);
    await expect(page.getByText(person.surname).first()).toBeVisible();
  });

  test.afterAll(() => {
    console.log(
      `\n[run ${RUN_ID}] application ${reference || '(not created)'} — ` +
        'everything this suite created carries the surname ' +
        `Testcase-${RUN_ID}.`
    );
  });
});
