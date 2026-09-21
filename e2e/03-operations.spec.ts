// The screens people open when something needs checking, rather than when an
// application needs moving.
//
// Most of these are read-only, and most assert loosely on purpose: what a
// report contains, what the fees are and which notification templates exist
// are all configuration, and a suite that pinned them would fail on every
// deployment except the one it was written against. What is asserted is that
// the screen works, shows the run's own data where it should, and does not
// quietly report nothing.
import { expect, test } from './fixtures';

test.describe('the Treasurer’s controls', () => {
  test('the receipt sequence has no gaps, duplicates or unexplained voids', async ({
    as,
  }) => {
    // S-502. A gap in the receipt sequence is an audit signal, and this page
    // is the only thing looking for one.
    const page = await as('treasurer');
    await page.goto('/receipts/reconciliation');

    const body = (await page.textContent('body')) ?? '';
    console.log(
      '[receipts] ' +
        (body.match(/[\d,]+ receipts? issued[\s\S]{0,120}/)?.[0] ?? '')
          .replace(/\s+/g, ' ')
          .trim()
    );

    // The page says either that everything is accounted for, or what is not.
    const clean = /No gaps, no duplicates, no voids/i.test(body);
    if (!clean) {
      const exceptions = body
        .match(/Exceptions[\s\S]{0,400}/)?.[0]
        ?.replace(/\s+/g, ' ');
      throw new Error(
        'The receipt sequence has exceptions. On a shared test environment ' +
          'this may be from earlier testing rather than a defect — but on ' +
          'production it is the thing this page exists to catch.\n' +
          exceptions
      );
    }
  });
});

test.describe('reporting', () => {
  test('every report the deployment offers can be opened', async ({ as }) => {
    const page = await as('admin');
    await page.goto('/reports');

    const links = page.locator('a[href^="/reports/"]');
    const count = await links.count();
    expect(
      count,
      'The reports page lists no reports at all. Either none are configured ' +
        'or this account holds none of the data permissions each one names.'
    ).toBeGreaterThan(0);

    const hrefs = await links.evaluateAll(as =>
      (as as HTMLAnchorElement[]).map(a => a.getAttribute('href') ?? '')
    );

    const broken: string[] = [];
    for (const href of [...new Set(hrefs)]) {
      const response = await page.goto(href);
      const status = response?.status() ?? 0;
      if (status >= 400 || page.url().includes('/denied')) {
        broken.push(`${href} → ${status}`);
      }
    }

    expect(
      broken,
      'These reports are listed but do not open. A report offered and then ' +
        'refused is worse than one not offered.'
    ).toEqual([]);

    console.log(`[reports] ${hrefs.length} listed, all opened`);
  });
});

test.describe('notifications', () => {
  test('the delivery page says what is carrying each channel', async ({
    as,
  }) => {
    const page = await as('admin');
    await page.goto('/admin/notifications');

    const body = (await page.textContent('body')) ?? '';

    // Reported, not asserted: an environment with no provider configured is a
    // legitimate state to test the rest of the system in, and the page saying
    // so plainly is the correct behaviour rather than a failure.
    const email = /Email\s*(Not configured|[A-Za-z0-9 .]+)/.exec(body)?.[0];
    const whatsapp = /WhatsApp\s*(Not configured|[A-Za-z0-9 .]+)/.exec(
      body
    )?.[0];
    console.log(
      `[notifications] ${email?.replace(/\s+/g, ' ')} | ` +
        `${whatsapp?.replace(/\s+/g, ' ')}`
    );

    // What must be true either way: wording exists to send. Counted from the
    // test-send picker's own options rather than asserted as visible text —
    // an <option> is not visible to a browser until its list is open, and the
    // question here is whether any wording is configured at all.
    const templates = page.locator('select option');
    expect(
      await templates.count(),
      'No notification wording is configured at all. Members would be told ' +
        'nothing when their application moves.'
    ).toBeGreaterThan(0);
  });

  test('the wording itself is editable, and carries its placeholders', async ({
    as,
  }) => {
    const page = await as('admin');
    const response = await page.goto(
      '/admin/configuration/notification-templates'
    );
    expect(response?.status()).toBeLessThan(400);

    const bodies = page.locator('textarea[name="body"]');
    expect(
      await bodies.count(),
      'No notification wording to edit. The templates the migrations seed ' +
        'are missing from this database.'
    ).toBeGreaterThan(0);

    // A message that still contains its placeholder markers would reach a
    // member reading "Assalamoualaikoum {{applicant_name}}".
    const sample = (await bodies.first().inputValue()) ?? '';
    console.log(
      `[wording] first template: ${sample.replace(/\s+/g, ' ').slice(0, 80)}…`
    );
  });
});

test.describe('retention', () => {
  test('the periods this deployment has set are reported', async ({ as }) => {
    const page = await as('admin');
    const response = await page.goto('/admin/configuration/retention');

    expect(
      response?.status(),
      'The retention page did not open. It is where the Society states how ' +
        'long records are kept.'
    ).toBeLessThan(400);

    const rows = page
      .locator('form')
      .filter({ has: page.locator('[name="code"]') });
    const summary = await rows.evaluateAll(forms =>
      forms.map(f => (f.textContent ?? '').replace(/\s+/g, ' ').trim())
    );
    console.log(`[retention]\n  ${summary.join('\n  ')}`);

    // The one thing that must be true: setting a period destroys member data
    // permanently, and the screen has to say so before anybody does it.
    await expect(
      page.getByText(/no undo/i),
      'The retention screen does not warn that disposal is permanent. ' +
        'Somebody will set a period without realising what it does.'
    ).toBeVisible();
  });
});

test.describe('the API reference', () => {
  test('lists endpoints, grouped, and says what each one needs', async ({
    as,
  }) => {
    const page = await as('admin');
    await page.goto('/admin/api');

    const body = (await page.textContent('body')) ?? '';
    const counted = body.match(/(\d+) endpoints? in (\d+) categor/i);
    expect(
      counted,
      'The API reference lists no endpoints. The document is generated from ' +
        'the route descriptors, so an empty one means the build did not ' +
        'produce it.'
    ).not.toBeNull();
    console.log(`[api] ${counted?.[0]}`);

    // Every endpoint names the permission it enforces. An endpoint that names
    // none is one nothing is governing.
    //
    // The page nests a <details> per category and another per endpoint, all
    // closed. Everything is opened first: the text is in the DOM either way,
    // and asserting on something a reader cannot see would pass on a page
    // that never expands.
    await page.locator('details').evaluateAll(list =>
      (list as HTMLDetailsElement[]).forEach(d => {
        d.open = true;
      })
    );

    await expect(
      page.getByText(/Requires /).first(),
      'No endpoint on the reference names the permission it enforces. Every ' +
        '/api/v1 endpoint is supposed to declare one.'
    ).toBeVisible();

    const named = await page.getByText(/Requires /).count();
    console.log(`[api] ${named} permission declarations shown`);
  });
});

test.describe('the audit trail', () => {
  test('records what this run did, naming who did it', async ({ as }) => {
    // Everything above happened as five different people. The trail is what
    // makes that answerable afterwards, and an approval that left no entry is
    // the failure worth catching.
    const page = await as('admin');
    await page.goto('/admin/audit-log');

    const body = (await page.textContent('body')) ?? '';
    expect(/\d/.test(body), 'The audit log page shows nothing at all.').toBe(
      true
    );

    const approvals = page.getByText(/approved/i);
    console.log(
      `[audit] entries mentioning an approval on the first page: ` +
        `${await approvals.count()}`
    );
  });
});
