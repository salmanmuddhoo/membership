import { randomBytes } from 'node:crypto';
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

// A member's statement sent to them as a PDF, one at a time or to everyone
// at once through the statement-send job (officer request). Against real
// migrations, like every ledger suite.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `stmt_test_${Date.now()}`;
const ownerUrl = `postgresql://postgres@127.0.0.1:5433/${dbName}`;
const appUrl = `postgresql://albarakah_app:devpassword@127.0.0.1:5433/${dbName}`;
const SECRET = randomBytes(32).toString('hex');

async function run(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

let openPool: typeof import('../db/pool') | null = null;

async function closeOpenPool() {
  if (openPool) {
    await openPool.closePool();
    openPool = null;
  }
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
        // Only the statement's own message is under test here.
        if (!/statement/i.test(message.body)) return;
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
    retry: await import('../notifications/retry'),
    deposits: await import('./deposits'),
    withdrawals: await import('./withdrawals'),
    statements: await import('./member-statement'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let officer: Principal;
let reachable: { id: string; msa: string };
let unreachable: { id: string; msa: string };

function principalFor(userId: string, email: string) {
  return {
    userId,
    entraSubject: `sub-${email}`,
    email,
    displayName: email,
    roles: ['account_officer'],
    roleNames: ['account officer'],
    permissions: new Set([
      'transaction.capture',
      'transaction.post',
      'transaction.disburse',
      'transaction.view',
      'statement.send',
      'statement.send_all',
    ]),
  } satisfies Principal;
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
  officer = principalFor(user.rows[0].id, 'officer@albarakah.mu');

  const membershipTypeId = (
    await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    )
  ).rows[0].id;
  const msaTypeId = (
    await run(appUrl, `select id from account_type where code = 'msa'`)
  ).rows[0].id;

  const member = async (values: Record<string, string>) => {
    const application = await run(
      appUrl,
      `insert into membership_application (membership_type_id, captured_by, status)
       values ($1, $2, 'approved') returning id`,
      [membershipTypeId, officer.userId]
    );
    await run(
      appUrl,
      `insert into application_party (application_id, subject, ordinal, values)
       values ($1, 'applicant', 1, $2)`,
      [application.rows[0].id, JSON.stringify(values)]
    );
    const m = await run(
      appUrl,
      `insert into member (application_id, membership_type_id)
       values ($1, $2) returning id`,
      [application.rows[0].id, membershipTypeId]
    );
    const account = await run(
      appUrl,
      `insert into account (member_id, account_type_id, is_membership_default, status)
       values ($1, $2, false, 'active') returning id`,
      [m.rows[0].id, msaTypeId]
    );
    return { id: m.rows[0].id, msa: account.rows[0].id };
  };
  reachable = await member({
    name: 'Amina',
    surname: 'Test',
    email: 'amina@example.mu',
    mobile: '+230 5789 1234',
  });
  unreachable = await member({ name: 'Bilal', surname: 'Test' });
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

const PERIOD = { from: '2000-01-01', to: '2999-12-31' };

function jobContext() {
  const logged: string[] = [];
  let processed = 0;
  return {
    logged,
    get processed() {
      return processed;
    },
    context: {
      checkpoint: undefined,
      processedCount: 0,
      async save(_checkpoint: unknown, delta: number) {
        processed += delta;
      },
      shouldStop: () => false,
      log: (message: string) => {
        logged.push(message);
      },
    },
  };
}

describe('a statement sent to one member (officer request)', () => {
  it('covers every account for the period, as a PDF on a signed link, attached to the email', async () => {
    const { deposits, statements, sent } = await load();
    await deposits.recordDeposit(
      { accountId: reachable.msa, amount: '2500', method: 'cash' },
      officer
    );
    const statement = await statements.memberStatement(
      { kind: 'member', id: reachable.id },
      PERIOD
    );
    expect(statement?.holderName).toBe('Amina Test');
    expect(statement?.accounts).toHaveLength(1);
    expect(statement?.accounts[0].closingBalance).toBe('2500.00');
    const pdf = new Uint8Array(statements.renderMemberStatementPdf(statement!));
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');

    sent.length = 0;
    const outcome = await statements.sendStatementTo(
      { kind: 'member', id: reachable.id },
      PERIOD,
      officer
    );
    expect(outcome).toBe('sent');
    expect(sent.map(s => s.channel).sort()).toEqual(['email', 'whatsapp']);
    const email = sent.find(s => s.channel === 'email')!;
    expect(email.recipient).toBe('amina@example.mu');
    expect(email.attachment).toMatchObject({ contentType: 'application/pdf' });
    // WhatsApp carries the link until its template takes a document.
    expect(sent.find(s => s.channel === 'whatsapp')!.attachment).toBeNull();

    const token = email.attachment!.url.match(
      /^https:\/\/members\.example\.mu\/statements\/shared\/(\S+)\.pdf$/
    )![1];
    expect(await statements.verifyStatementToken(token)).toEqual({
      holder: { kind: 'member', id: reachable.id },
      period: PERIOD,
    });
    expect(email.body).toContain(email.attachment!.url);
    // A receipt's token is not a statement's.
    const links = await import('./receipt-links');
    expect(await links.verifyReceiptToken(token)).toBeNull();

    const audit = await run(
      appUrl,
      `select action, new_value->>'outcome' as outcome from audit_event
        where entity_id = $1 and action = 'statement.sent'`,
      [reachable.id]
    );
    expect(audit.rows).toEqual([{ action: 'statement.sent', outcome: 'sent' }]);
  });

  it('says so when the member has no email or mobile on file', async () => {
    const { statements, sent } = await load();
    sent.length = 0;
    expect(
      await statements.sendStatementTo(
        { kind: 'member', id: unreachable.id },
        PERIOD,
        officer
      )
    ).toBe('no_contact');
    expect(sent).toEqual([]);
  });

  it('is refused without the permission', async () => {
    const { statements } = await load();
    await expect(
      statements.sendStatementTo({ kind: 'member', id: reachable.id }, PERIOD, {
        ...officer,
        permissions: new Set(['transaction.view']),
      })
    ).rejects.toThrowError(/permission/);
    await expect(
      statements.queueStatementRun(PERIOD, {
        ...officer,
        permissions: new Set(['statement.send']),
      })
    ).rejects.toThrowError(/permission/);
  });
});

describe('statements to everyone at once (officer request)', () => {
  it('sends each holder once, one run at a time, and a resumed run sends nobody twice', async () => {
    const { statements, sent } = await load();
    expect(await statements.countHolders()).toBe(2);

    const runId = await statements.queueStatementRun(PERIOD, officer);
    await expect(
      statements.queueStatementRun(PERIOD, officer)
    ).rejects.toThrowError(/already being sent/);

    // A run interrupted after one holder was dealt with.
    await run(
      appUrl,
      `insert into statement_run_item (run_id, holder_kind, holder_id, outcome)
       values ($1, 'member', $2, 'sent')`,
      [runId, reachable.id]
    );
    sent.length = 0;
    const job = jobContext();
    await statements.processStatementRuns(job.context, 1);
    // Only the holder not yet dealt with; they have no contact on file.
    expect(sent).toEqual([]);
    expect(job.processed).toBe(1);

    const [done] = await statements.listStatementRuns();
    expect(done).toMatchObject({
      id: runId,
      status: 'done',
      sent: 1,
      noContact: 1,
      failed: 0,
    });
    expect(done.finishedAt).not.toBeNull();

    // Nothing waiting: the job reads and stops, and a new run may be asked.
    const idle = jobContext();
    await statements.processStatementRuns(idle.context);
    expect(idle.logged).toContain('no statements waiting to be sent');
    const second = await statements.queueStatementRun(PERIOD, officer);
    sent.length = 0;
    await statements.processStatementRuns(jobContext().context);
    expect(sent.filter(s => s.channel === 'email')).toHaveLength(1);
    expect((await statements.listStatementRuns())[0]).toMatchObject({
      id: second,
      status: 'done',
      sent: 1,
      noContact: 1,
    });
  });
});
