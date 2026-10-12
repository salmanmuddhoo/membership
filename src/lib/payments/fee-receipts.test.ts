import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { migrate } from '../../../scripts/migrate';
import type { Principal } from '../access/principal';
import { openEveryDrawer } from '../cash/drawers.testing';

// A membership fee receipt sent to the person who paid (officer request):
// recording an application's fees sends its receipt, as a PDF and never a
// link, to the applicant's email and mobile.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `fee_receipts_test_${Date.now()}`;
const ownerUrl = `postgresql://postgres@127.0.0.1:5433/${dbName}`;
const appUrl = `postgresql://albarakah_app:devpassword@127.0.0.1:5433/${dbName}`;
const SECRET = 'fee-receipt-test-secret-with-thirty-two-plus-characters';

async function run(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

let openPool: { closePool: () => Promise<void> } | undefined;

async function closeOpenPool() {
  const previous = openPool;
  openPool = undefined;
  await previous?.closePool();
}

interface Sent {
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  attachment: { url: string; filename: string; contentType: string } | null;
}

async function load() {
  await closeOpenPool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  process.env.MEMBER_SESSION_SECRET ??= SECRET;
  process.env.PUBLIC_APP_URL = 'https://members.example.mu';
  delete process.env.NOTIFY_EMAIL_DELIVERY;
  delete process.env.NOTIFY_WHATSAPP_DELIVERY;
  openPool = await import('../db/pool');
  const notify = await import('../notifications/notify');
  const sent: Sent[] = [];
  for (const name of ['email', 'whatsapp'] as const) {
    notify.registerChannel({
      name,
      async send(message) {
        sent.push({
          channel: name,
          recipient: message.recipient,
          subject: message.subject,
          body: message.body,
          attachment: message.attachment ?? null,
        });
      },
    });
  }
  return {
    sent,
    notify,
    payments: await import('./payments'),
    feeReceipts: await import('./fee-receipts'),
    links: await import('../ledger/receipt-links'),
    capture: await import('../applications/capture'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let officer: Principal;

const FULL = {
  entrance: '1500.00',
  takaful: '2000.00',
  shares: '5000.00',
} as const;

// An individual application with the applicant's contact details on it, as
// the capture form would have saved them.
async function applicationWith(contact: { email?: string; mobile?: string }) {
  const { capture } = await load();
  const application = await capture.startApplication('individual', officer);
  const values = JSON.stringify({ name: 'Amina', surname: 'Test', ...contact });
  const updated = await run(
    appUrl,
    `update application_party set values = values || $2::jsonb
      where application_id = $1 and subject = 'applicant' and ordinal = 1`,
    [application.id, values]
  );
  if (updated.rowCount === 0) {
    await run(
      appUrl,
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'applicant', 1, $2::jsonb)`,
      [application.id, values]
    );
  }
  return application;
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('officer@albarakah.mu', 'Officer') returning id`
  );
  officer = {
    userId: user.rows[0].id,
    entraSubject: 'sub-officer',
    email: 'officer@albarakah.mu',
    displayName: 'Officer',
    roles: [],
    roleNames: [],
    permissions: new Set([
      'application.capture',
      'payment.view',
      'payment.record',
    ]),
  };
  await openEveryDrawer(appUrl);
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('a membership fee receipt sent to the applicant', () => {
  it('goes by email and WhatsApp as its PDF, never a link, once the fees are recorded', async () => {
    const application = await applicationWith({
      email: 'amina@example.mu',
      mobile: '+230 5789 1234',
    });
    const { sent, payments, links, notify } = await load();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      officer
    );

    expect(sent.map(s => s.channel).sort()).toEqual(['email', 'whatsapp']);
    const email = sent.find(s => s.channel === 'email')!;
    expect(email.recipient).toBe('amina@example.mu');
    expect(email.subject).toBe(
      `Your receipt ${payment.receiptNo} from Al Barakah`
    );
    expect(email.body).toContain('Assalamoualaikoum Amina Test');
    expect(email.body).toContain('Rs 8,500.00');
    expect(email.body).toContain('Your receipt is attached.');
    expect(sent.find(s => s.channel === 'whatsapp')!.recipient).toBe(
      '+230 5789 1234'
    );

    for (const message of sent) {
      expect(message.body).not.toContain('http');
      expect(message.attachment).toMatchObject({
        filename: `Receipt ${payment.receiptNo}.pdf`,
        contentType: 'application/pdf',
      });
      const token = message.attachment!.url.match(
        /^https:\/\/members\.example\.mu\/receipts\/shared\/(\S+)\.pdf$/
      );
      expect(token).not.toBeNull();
      expect(await links.verifyFeeReceiptToken(token![1])).toBe(payment.id);
      // Signed for a fee receipt: never readable as a transaction's.
      expect(await links.verifyReceiptToken(token![1])).toBeNull();
    }

    // On the record against the payment, for the receipt page to show.
    const log = (await notify.notificationsFor('payment', payment.id)).filter(
      n => n.eventCode === 'fee_receipt.issued'
    );
    expect(log).toHaveLength(2);
  });

  it('draws the receipt as a one-page PDF with what the printed sheet says', async () => {
    const application = await applicationWith({ email: 'pdf@example.mu' });
    const { payments, feeReceipts } = await load();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      officer
    );
    const parties = await feeReceipts.feeReceiptParties(payment);
    expect(parties.owner).toContain('Amina Test');
    const bytes = feeReceipts.renderFeeReceiptPdf(payment, parties);
    expect(new TextDecoder().decode(new Uint8Array(bytes).slice(0, 5))).toBe(
      '%PDF-'
    );
  });

  it('sends nothing to an applicant with no address, and nothing without a PDF to attach', async () => {
    const nowhere = await applicationWith({});
    const first = await load();
    await first.payments.recordPayment(
      { applicationId: nowhere.id, method: 'cash', amounts: FULL },
      officer
    );
    expect(first.sent).toHaveLength(0);

    process.env.MEMBER_SESSION_SECRET = 'short';
    const reachable = await applicationWith({ email: 'nolink@example.mu' });
    const second = await load();
    const payment = await second.payments.recordPayment(
      { applicationId: reachable.id, method: 'cash', amounts: FULL },
      officer
    );
    expect(payment.receiptNo).toMatch(/^RCT-/);
    expect(second.sent).toHaveLength(0);
    const again = await second.feeReceipts.notifyFeeReceiptIssued(payment);
    expect(again).toMatchObject({ notificationIds: [], attachable: false });
  });

  it('can be sent again from the receipt', async () => {
    const application = await applicationWith({ email: 'again@example.mu' });
    const { sent, payments, feeReceipts } = await load();
    const payment = await payments.recordPayment(
      { applicationId: application.id, method: 'cash', amounts: FULL },
      officer
    );
    expect(sent).toHaveLength(1);
    const resend = await feeReceipts.notifyFeeReceiptIssued(payment);
    expect(resend.notificationIds).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });
});
