// The outbox, against a real database (S-901, S-902, S-904).
//
// Everything worth proving here is the database's own behaviour or the
// interaction between notify() and the retry job, and neither survives being
// mocked:
//
//   A send that failed leaves a row that comes back — with the text it was
//   going to send, not a re-render of a template that may have been edited
//   since.
//
//   A send that never got through is eventually given up on, and stays
//   visible when it is. "Abandoned" is a state staff can see, not a delete.
//
//   A notification never breaks the thing that caused it, however badly the
//   provider behaves.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../../scripts/migrate';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `notifications_test_${Date.now()}`;
const ownerUrl = `postgresql://postgres@127.0.0.1:5433/${dbName}`;
const appUrl = `postgresql://albarakah_app:devpassword@127.0.0.1:5433/${dbName}`;

async function run(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

process.env.DATABASE_URL = appUrl;
process.env.DATABASE_ALLOW_INSECURE = 'true';
process.env.PUBLIC_APP_ENV = 'test';
// No provider: every test here registers the channel it wants to observe.
delete process.env.NOTIFY_EMAIL_DELIVERY;
delete process.env.NOTIFY_WHATSAPP_DELIVERY;

const { notify, registerChannel, resetChannels } = await import('./notify');
const { retryDueNotifications, MAX_ATTEMPTS } = await import('./retry');
const { listNotifications, notificationCounts } = await import('./log');
const { listNotificationTemplates, placeholdersIn } =
  await import('./templates');
const { placeholdersForEvent } = await import('./event-codes');
const { clearReferenceCache } = await import('../config/cache');
const pool = await import('../db/pool');

interface Row {
  id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date | null;
  body: string;
}

async function rows(): Promise<Row[]> {
  const result = await run(
    appUrl,
    `select id, status, attempts, last_error, next_attempt_at, body
       from notification order by created_at`
  );
  return result.rows as Row[];
}

// Make every outstanding notification due now, which is what standing a few
// hours in the future would otherwise be needed for.
async function makeEverythingDue(): Promise<void> {
  await run(
    appUrl,
    `update notification set next_attempt_at = now() - interval '1 minute'
      where status in ('pending', 'failed')`
  );
}

// A channel that records what it was handed, and fails on demand.
function spyChannel(name: 'email' | 'whatsapp', failWith?: string) {
  const sent: { recipient: string; subject: string | null; body: string }[] =
    [];
  registerChannel({
    name,
    async send(message) {
      if (failWith) throw new Error(failWith);
      sent.push({
        recipient: message.recipient,
        subject: message.subject,
        body: message.body,
      });
    },
  });
  return sent;
}

// The wording exactly as the migrations seeded it, so a test that edits a
// template cannot change what every later test is working against. One test
// here does precisely that — deliberately, to prove a retry ignores an edit —
// and without this it also silently emptied the placeholders out of every
// assertion that ran after it.
let seededTemplates: { id: string; subject: string | null; body: string }[] =
  [];

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const seeded = await run(
    appUrl,
    'select id, subject, body from notification_template'
  );
  seededTemplates = seeded.rows as typeof seededTemplates;
});

async function restoreSeededWording(): Promise<void> {
  // One client for the whole transaction: `run` opens and closes its own, so
  // the actor set in one call would not be in scope for the next. Statements
  // are issued separately because a parameterised query may carry only one.
  const client = new pg.Client({ connectionString: appUrl, ssl: false });
  await client.connect();
  try {
    await client.query('begin');
    // notification_template is configuration, so migration 0010's trigger
    // requires an actor for the write — the same as the real page.
    await client.query(
      `select set_config('albarakah.actor_description', 'test fixture', true)`
    );
    for (const template of seededTemplates) {
      await client.query(
        `update notification_template
            set subject = $2, body = $3
          where id = $1
            and (body is distinct from $3 or subject is distinct from $2)`,
        [template.id, template.subject, template.body]
      );
    }
    await client.query('commit');
  } finally {
    await client.end();
  }
}

afterAll(async () => {
  await pool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

beforeEach(async () => {
  await run(appUrl, 'delete from notification');
  await restoreSeededWording();
  resetChannels();
  clearReferenceCache();
});

const REQUEST = {
  eventCode: 'application.approved',
  recipients: { email: 'fatimah@example.mu', mobile: '+23057891234' },
  values: { applicant_name: 'Fatimah Joomun', member_no: 'AB1001' },
  entityType: 'membership_application',
  entityId: '11111111-1111-1111-1111-111111111111',
};

describe('sending', () => {
  it('sends on every channel the event has a template for', async () => {
    const emails = spyChannel('email');
    const whatsapps = spyChannel('whatsapp');

    await notify(REQUEST);

    // 0053 seeds application.approved on both channels.
    expect(emails).toHaveLength(1);
    expect(whatsapps).toHaveLength(1);
    expect((await rows()).map(r => r.status)).toEqual(['sent', 'sent']);
  });

  it('fills the template from the event’s own values', async () => {
    const emails = spyChannel('email');

    await notify(REQUEST);

    expect(emails[0].body).toContain('Fatimah Joomun');
    expect(emails[0].body).toContain('AB1001');
    expect(emails[0].body).not.toContain('{{');
  });

  // A member with no mobile still gets the email. Skipping the channel is not
  // a failure and must not be recorded as one.
  it('skips a channel the recipient has no address for', async () => {
    spyChannel('email');
    const whatsapps = spyChannel('whatsapp');

    await notify({ ...REQUEST, recipients: { email: 'f@example.mu' } });

    expect(whatsapps).toHaveLength(0);
    expect(await rows()).toHaveLength(1);
  });

  // The bargain the whole module is built on: an approval that succeeded is
  // never reported as failed because a relay was down.
  it('never throws, however badly the provider behaves', async () => {
    spyChannel('email', 'the relay is on fire');
    spyChannel('whatsapp', 'the gateway is on fire');

    await expect(notify(REQUEST)).resolves.toBeDefined();
  });

  it('records the failure against the row, with the reason', async () => {
    spyChannel('email', 'relay refused');
    spyChannel('whatsapp', 'relay refused');

    await notify(REQUEST);

    const all = await rows();
    expect(all.every(r => r.status === 'failed')).toBe(true);
    expect(all[0].last_error).toBe('relay refused');
    // Scheduled, so the retry waits the backoff rather than the orphan grace.
    expect(all[0].next_attempt_at).not.toBeNull();
  });

  // An event nobody has written wording for is a decision not to notify that
  // way, not an error to raise at the member.
  it('sends nothing for an event with no template', async () => {
    spyChannel('email');

    await notify({ ...REQUEST, eventCode: 'nothing.configured' });

    expect(await rows()).toHaveLength(0);
  });
});

describe('retrying', () => {
  it('comes back to a failed send and can succeed the second time', async () => {
    spyChannel('email', 'relay down');
    spyChannel('whatsapp', 'relay down');
    await notify(REQUEST);

    // The relay comes back.
    resetChannels();
    const emails = spyChannel('email');
    spyChannel('whatsapp');
    await makeEverythingDue();

    const outcome = await retryDueNotifications();

    expect(outcome.sent).toBe(2);
    expect(emails).toHaveLength(1);
    expect((await rows()).every(r => r.status === 'sent')).toBe(true);
  });

  // Editing a template must not rewrite what was already being sent: a retry
  // is another attempt at the same message, not a new one.
  it('re-sends the text as it was rendered, not the template as it is now', async () => {
    spyChannel('email', 'relay down');
    spyChannel('whatsapp', 'relay down');
    await notify(REQUEST);
    const originalBody = (await rows())[0].body;

    // notification_template is configuration, so the audit trigger from
    // migration 0010 refuses a write that cannot name who made it — exactly
    // as it would for an administrator editing the wording on the real page.
    await run(
      appUrl,
      `begin;
       select set_config('albarakah.actor_description', 'test fixture', true);
       update notification_template
          set body = 'Completely different wording now.'
        where event_code = 'application.approved';
       commit;`
    );
    clearReferenceCache();

    resetChannels();
    const emails = spyChannel('email');
    spyChannel('whatsapp');
    await makeEverythingDue();
    await retryDueNotifications();

    expect(emails[0].body).toBe(originalBody);
    expect(emails[0].body).toContain('Fatimah Joomun');
  });

  // Nothing is due until its backoff has elapsed; a job running a minute
  // later must not burn an attempt.
  it('leaves a notification alone until it is due', async () => {
    spyChannel('email', 'relay down');
    spyChannel('whatsapp', 'relay down');
    await notify(REQUEST);

    const outcome = await retryDueNotifications();

    expect(outcome.attempted).toBe(0);
    expect((await rows()).every(r => r.attempts === 1)).toBe(true);
  });

  it('gives up after the ceiling, and says so rather than deleting it', async () => {
    spyChannel('email', 'no such mailbox');
    spyChannel('whatsapp', 'no such number');
    await notify(REQUEST);

    // One attempt is already spent by notify() itself.
    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      await makeEverythingDue();
      await retryDueNotifications();
    }

    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all.every(r => r.status === 'abandoned')).toBe(true);
    expect(all.every(r => r.attempts === MAX_ATTEMPTS)).toBe(true);
    // Still visible, and still carrying why.
    expect(all[0].last_error).toBeTruthy();
  });

  it('stops attempting one it has given up on', async () => {
    spyChannel('email', 'no such mailbox');
    spyChannel('whatsapp', 'no such number');
    await notify(REQUEST);
    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      await makeEverythingDue();
      await retryDueNotifications();
    }

    await makeEverythingDue();
    const outcome = await retryDueNotifications();

    expect(outcome.attempted).toBe(0);
  });

  // A row written by notify() whose process then died is never marked failed,
  // so it has no due time at all. It must still come back.
  it('picks up a send that nothing lived long enough to record', async () => {
    await run(
      appUrl,
      `insert into notification
         (event_code, channel, recipient, subject, body, created_at)
       values ('application.approved', 'email', 'orphan@example.mu',
               'Subject', 'Body', now() - interval '1 hour')`
    );
    const emails = spyChannel('email');

    const outcome = await retryDueNotifications();

    expect(outcome.sent).toBe(1);
    expect(emails[0].recipient).toBe('orphan@example.mu');
  });

  // Ten minutes' grace tells an in-flight send from an orphaned one.
  it('leaves a send that may still be in flight alone', async () => {
    await run(
      appUrl,
      `insert into notification
         (event_code, channel, recipient, subject, body)
       values ('application.approved', 'email', 'inflight@example.mu',
               'Subject', 'Body')`
    );
    spyChannel('email');

    expect((await retryDueNotifications()).attempted).toBe(0);
  });

  // One bad address must not hold up every other member's message.
  it('carries on past a failure to the rest of the queue', async () => {
    await run(
      appUrl,
      `insert into notification
         (event_code, channel, recipient, subject, body, status,
          next_attempt_at)
       values ('application.approved', 'email', 'bad@example.mu', 'S', 'B',
               'failed', now() - interval '1 minute'),
              ('application.approved', 'whatsapp', '+23057891234', null, 'B',
               'failed', now() - interval '1 minute')`
    );
    registerChannel({
      name: 'email',
      async send() {
        throw new Error('no such mailbox');
      },
    });
    const whatsapps = spyChannel('whatsapp');

    const outcome = await retryDueNotifications();

    expect(outcome.attempted).toBe(2);
    expect(outcome.sent).toBe(1);
    expect(whatsapps).toHaveLength(1);
  });
});

describe('a provider that sends approved templates (WhatsApp)', () => {
  // The values, in the order the placeholders appear in the body — not the
  // rendered sentence, which WhatsApp would reject for a business-initiated
  // message. 0053's whatsapp body reads "...{{applicant_name}}, your Al
  // Barakah membership has been approved. Your member number is
  // {{member_no}}."
  it('records the positional values the provider template needs', async () => {
    let seen: { parameters?: string[] | null; name?: string | null } = {};
    registerChannel({
      name: 'whatsapp',
      async send(message) {
        seen = {
          parameters: message.parameters,
          name: message.providerTemplateName,
        };
      },
    });
    spyChannel('email');

    await notify(REQUEST);

    expect(seen.name).toBe('membership_approved');
    expect(seen.parameters).toEqual(['Fatimah Joomun', 'AB1001']);

    const stored = await run(
      appUrl,
      `select provider_parameters from notification where channel = 'whatsapp'`
    );
    expect(stored.rows[0].provider_parameters).toEqual([
      'Fatimah Joomun',
      'AB1001',
    ]);
  });

  // Email sends a finished sentence, so positional values would be noise.
  it('records none for a channel that sends finished text', async () => {
    spyChannel('email');
    spyChannel('whatsapp');

    await notify(REQUEST);

    const stored = await run(
      appUrl,
      `select provider_parameters from notification where channel = 'email'`
    );
    expect(stored.rows[0].provider_parameters).toBeNull();
  });

  // The retry must send what the first attempt would have sent — including
  // the parameters, which are on the row rather than recomputed.
  it('replays the same values on a retry', async () => {
    spyChannel('email', 'relay down');
    registerChannel({
      name: 'whatsapp',
      async send() {
        throw new Error('WhatsApp down');
      },
    });
    await notify(REQUEST);

    let replayed: string[] | null | undefined;
    resetChannels();
    spyChannel('email');
    registerChannel({
      name: 'whatsapp',
      async send(message) {
        replayed = message.parameters;
      },
    });
    await makeEverythingDue();
    await retryDueNotifications();

    expect(replayed).toEqual(['Fatimah Joomun', 'AB1001']);
  });

  // An empty value keeps its position: dropping it would shift the member
  // number into the slot where the name belongs.
  it('keeps a missing value as an empty slot rather than shifting the rest', async () => {
    let parameters: string[] | null | undefined;
    registerChannel({
      name: 'whatsapp',
      async send(message) {
        parameters = message.parameters;
      },
    });
    spyChannel('email');

    await notify({
      ...REQUEST,
      values: { member_no: 'AB1001' },
    });

    expect(parameters).toEqual(['', 'AB1001']);
  });
});

describe('the wording the migrations ship', () => {
  // The seeded templates and placeholdersForEvent are two halves of one
  // contract: the migration writes {{member_no}}, the code passes member_no.
  // Nothing but this checks them against each other, and a mismatch shows up
  // as a blank in a real member's inbox — "Your member number is ." — with
  // nothing anywhere saying why.
  it('uses only placeholders its own event fills in', async () => {
    const templates = await listNotificationTemplates();
    expect(templates.length).toBeGreaterThan(0);

    for (const template of templates) {
      const available = placeholdersForEvent(template.eventCode);
      expect(
        available,
        `no placeholders known for ${template.eventCode}`
      ).not.toBeNull();

      const used = [
        ...placeholdersIn(template.body),
        ...placeholdersIn(template.subject ?? ''),
      ];
      for (const name of used) {
        expect(
          available,
          `${template.eventCode}/${template.channel} uses {{${name}}}`
        ).toContain(name);
      }
    }
  });

  // An email with no subject violates a check constraint; every seeded row
  // has to satisfy it, and the editor refuses one that would not.
  it('gives every email template a subject', async () => {
    const templates = await listNotificationTemplates();
    const emails = templates.filter(t => t.channel === 'email');

    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every(t => (t.subject ?? '').trim() !== '')).toBe(true);
  });
});

describe('the delivery log', () => {
  it('counts what somebody has to act on', async () => {
    spyChannel('email', 'relay down');
    spyChannel('whatsapp', 'relay down');
    await notify(REQUEST);

    expect(await notificationCounts()).toMatchObject({
      failed: 2,
      abandoned: 0,
    });
  });

  it('finds a message by the address it was sent to', async () => {
    spyChannel('email');
    spyChannel('whatsapp');
    await notify(REQUEST);

    const { rows: found, total } = await listNotifications({
      search: 'fatimah@example.mu',
    });

    expect(total).toBe(1);
    expect(found[0].channel).toBe('email');
  });

  it('filters to one status', async () => {
    spyChannel('email');
    spyChannel('whatsapp', 'relay down');
    await notify(REQUEST);

    const { rows: failed } = await listNotifications({ status: 'failed' });

    expect(failed).toHaveLength(1);
    expect(failed[0].channel).toBe('whatsapp');
  });

  // The count above the list and the list itself read the same predicate, so
  // "1 message" over three rows is not possible.
  it('counts the same rows it returns', async () => {
    spyChannel('email');
    spyChannel('whatsapp');
    await notify(REQUEST);

    const { rows: found, total } = await listNotifications({
      channel: 'email',
    });

    expect(total).toBe(found.length);
  });

  // entity_id is text, so a row that is not about an application must not
  // break the join to membership_application.
  it('reads a notification that is not about an application', async () => {
    await run(
      appUrl,
      `insert into notification
         (event_code, channel, recipient, subject, body, entity_type,
          entity_id)
       values ('application.approved', 'email', 'x@example.mu', 'S', 'B',
               'something_else', 'not-a-uuid')`
    );

    const { rows: found } = await listNotifications({});

    expect(found).toHaveLength(1);
    expect(found[0].reference).toBeNull();
  });

  // Officer request: the delivery log is paged 10, 25 or 50 rows at a time,
  // the officer's choice (src/lib/paging.ts) — `limit` is how the page says
  // which, and `total` still counts every row the filters match, not just
  // the page.
  it('pages with a custom limit and offset, newest first', async () => {
    await run(
      appUrl,
      `insert into notification
         (event_code, channel, recipient, subject, body, created_at)
       select 'application.approved', 'email',
              'page' || i || '@example.mu', 'S', 'B',
              now() - (i || ' minutes')::interval
         from generate_series(1, 5) as i`
    );

    const firstPage = await listNotifications({ limit: 2, offset: 0 });
    const secondPage = await listNotifications({ limit: 2, offset: 2 });

    expect(firstPage.total).toBe(5);
    expect(secondPage.total).toBe(5);
    expect(firstPage.rows.map(r => r.recipient)).toEqual([
      'page1@example.mu',
      'page2@example.mu',
    ]);
    expect(secondPage.rows.map(r => r.recipient)).toEqual([
      'page3@example.mu',
      'page4@example.mu',
    ]);
  });
});
