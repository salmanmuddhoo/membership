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

// What a member or a claimant hears at every stage of an exit (S-1705),
// and the exits report (S-1706), against real migrations. The channels
// are faked; the wording is the seeded one.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `exits_test_${Date.now()}`;
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

const configure = (sql: string) =>
  run(
    appUrl,
    `begin; set local albarakah.actor_description = 'exits.test'; ${sql}; commit;`
  );

let openPool: typeof import('../db/pool') | null = null;

async function closeOpenPool() {
  if (openPool) {
    await openPool.closePool();
    openPool = null;
  }
}

async function load() {
  await closeOpenPool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  delete process.env.NOTIFY_EMAIL_DELIVERY;
  delete process.env.NOTIFY_WHATSAPP_DELIVERY;
  openPool = await import('../db/pool');
  const notify = await import('../notifications/notify');
  const sent: {
    event: string;
    channel: string;
    recipient: string;
    body: string;
  }[] = [];
  for (const name of ['email', 'whatsapp'] as const) {
    notify.registerChannel({
      name,
      async send(message) {
        sent.push({
          event: '',
          channel: name,
          recipient: message.recipient,
          body: message.body,
        });
      },
    });
  }
  return {
    sent,
    notify,
    demises: await import('./demises'),
    closures: await import('./closures'),
    reports: await import('../reports/definitions'),
    deposits: await import('./deposits'),
    review: await import('./review'),
    ledger: await import('./ledger'),
    timeline: await import('../workflow/timeline'),
    config: await import('../config/reference'),
    cache: await import('../config/cache'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let clerk: Principal;
let officer: Principal;
let treasurer: Principal;
let secretary: Principal;
let president: Principal;
let member: { id: string; shares: string; msa: string; hsa: string };
let certificateTypeId: string;
let affidavitTypeId: string;

function principalFor(
  userId: string,
  email: string,
  roles: string[],
  permissions: string[]
) {
  return {
    userId,
    entraSubject: `sub-${email}`,
    email,
    displayName: email,
    roles,
    roleNames: roles.map(r => r.replace('_', ' ')),
    permissions: new Set(permissions),
  } satisfies Principal;
}

async function filePaper(
  transactionId: string,
  documentTypeId: string,
  by: Principal
) {
  const doc = await run(
    appUrl,
    `insert into document (document_type_id, subject, transaction_id, state)
     values ($1, 'applicant', $2, 'under_review') returning id`,
    [documentTypeId, transactionId]
  );
  await run(
    appUrl,
    `insert into document_version
       (document_id, version_no, state, file_name, content_type, size_bytes,
        sharepoint_path, uploaded_by, committed_at)
     values ($1, 1, 'committed', 'paper.pdf', 'application/pdf', 1234,
             $3, $2, now())`,
    [doc.rows[0].id, by.userId, `/test/${doc.rows[0].id}.pdf`]
  );
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (email, display_name)
     values ('clerk@albarakah.mu', 'Clerk'),
            ('officer@albarakah.mu', 'Officer'),
            ('treasurer@albarakah.mu', 'Treasurer'),
            ('secretary@albarakah.mu', 'Secretary'),
            ('president@albarakah.mu', 'President')
     returning id, email`
  );
  const byEmail = new Map(users.rows.map(r => [r.email, r.id]));
  clerk = principalFor(
    byEmail.get('clerk@albarakah.mu'),
    'clerk@albarakah.mu',
    ['clerk'],
    ['transaction.capture', 'transaction.view']
  );
  officer = principalFor(
    byEmail.get('officer@albarakah.mu'),
    'officer@albarakah.mu',
    ['account_officer'],
    ['transaction.capture', 'transaction.post', 'transaction.view']
  );
  treasurer = principalFor(
    byEmail.get('treasurer@albarakah.mu'),
    'treasurer@albarakah.mu',
    ['treasurer'],
    ['transaction.post', 'transaction.view']
  );
  secretary = principalFor(
    byEmail.get('secretary@albarakah.mu'),
    'secretary@albarakah.mu',
    ['secretary'],
    ['transaction.review', 'transaction.view']
  );
  president = principalFor(
    byEmail.get('president@albarakah.mu'),
    'president@albarakah.mu',
    ['president'],
    ['transaction.approve', 'transaction.view']
  );

  await configure(
    `insert into account_type
       (code, name, category, number_prefix, sort_order, allows_withdrawal)
     values ('hsa', 'Hajj Savings', 'savings', 'HSA', 5, false)`
  );

  const membershipTypeId = (
    await run(
      appUrl,
      `select id from membership_type where code = 'individual'`
    )
  ).rows[0].id;
  const application = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [membershipTypeId, officer.userId]
  );
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, '{"name": "Amina", "surname": "Test", "email": "amina@example.mu", "mobile": "+230 5111 1111"}'),
            ($1, 'nominee', 1, '{"name": "Yusuf", "surname": "Test", "nic": "Y1234567890123", "address": "12 Rue des Palmiers, Curepipe", "email": "yusuf@example.mu"}')`,
    [application.rows[0].id]
  );
  const m = await run(
    appUrl,
    `insert into member (application_id, membership_type_id)
     values ($1, $2) returning id`,
    [application.rows[0].id, membershipTypeId]
  );
  const types = Object.fromEntries(
    (await run(appUrl, `select code, id from account_type`)).rows.map(r => [
      r.code,
      r.id,
    ])
  );
  const open = async (code: string, accountNo: string | null) =>
    (
      await run(
        appUrl,
        `insert into account
           (member_id, account_type_id, is_membership_default, status, account_no)
         values ($1, $2, $3, 'active', $4) returning id`,
        [m.rows[0].id, types[code], accountNo === null, accountNo]
      )
    ).rows[0].id;
  member = {
    id: m.rows[0].id,
    shares: await open('shares', null),
    msa: await open('msa', null),
    hsa: await open('hsa', 'HSA0001'),
  };
  certificateTypeId = (
    await run(
      appUrl,
      `select id from document_type where code = 'death_certificate'`
    )
  ).rows[0].id;
  affidavitTypeId = (
    await run(appUrl, `select id from document_type where code = 'affidavit'`)
  ).rows[0].id;

  // Money on every account: Shares 8,000, MSA 12,000, HSA 1,000.
  const { deposits } = await load();
  for (const [accountId, amount] of [
    [member.shares, '8000'],
    [member.msa, '12000'],
    [member.hsa, '1000'],
  ] as const) {
    await deposits.recordDeposit(
      { accountId, amount, method: 'cash' },
      officer
    );
  }
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

// Which event a notification row carries, from the log.
async function eventsFor(transactionId: string) {
  const rows = await run(
    appUrl,
    `select event_code, channel, recipient, status from notification
      where entity_type = 'transaction' and entity_id = $1
      order by created_at, channel`,
    [transactionId]
  );
  return rows.rows.map(
    r => `${r.event_code} ${r.channel} ${r.recipient} ${r.status}`
  );
}

describe('an exit is told at every stage (S-1705)', () => {
  it('writes to the member for a closure: received, under review, and paid out with the receipt', async () => {
    const { closures, review, sent } = await load();
    const closure = await closures.startClosure(
      { accountId: member.hsa, reason: 'Done saving', method: 'cash' },
      clerk
    );
    const requestType = (
      await run(
        appUrl,
        `select id from document_type where code = 'closure_request'`
      )
    ).rows[0].id;
    await filePaper(closure.id, requestType, clerk);
    await closures.submitClosure(closure.id, clerk);
    expect(await eventsFor(closure.id)).toEqual([
      'closure.submitted email amina@example.mu sent',
      'closure.submitted whatsapp +230 5111 1111 sent',
    ]);
    expect(sent[0].body).toContain(`(${closure.reference})`);
    expect(sent[0].body).toContain('Assalamoualaikoum Amina Test');

    await review.reviewTransaction(
      closure.id,
      { outcome: 'forward', comment: 'Looks fine' },
      secretary
    );
    expect((await eventsFor(closure.id)).slice(2)).toEqual([
      'closure.under_review email amina@example.mu sent',
      'closure.under_review whatsapp +230 5111 1111 sent',
    ]);
    expect(sent[2].body).toContain('Looks fine');

    // Approval on its own says nothing; the payout does.
    await review.reviewTransaction(
      closure.id,
      { outcome: 'forward', comment: '' },
      president
    );
    expect(await eventsFor(closure.id)).toHaveLength(4);
    const posted = await review.postApprovedTransaction(closure.id, treasurer, {
      method: 'cash',
    });
    const after = await eventsFor(closure.id);
    // The receipt's own message (S-1602) and the approval, both at posting.
    expect(after.filter(e => e.startsWith('closure.approved'))).toEqual([
      'closure.approved email amina@example.mu sent',
      'closure.approved whatsapp +230 5111 1111 sent',
    ]);
    expect(after.filter(e => e.startsWith('receipt.issued'))).toHaveLength(2);
    const approved = sent.find(
      s => s.body.includes('paid out') && s.body.includes(posted.receiptNo!)
    );
    expect(approved?.body).toContain('Rs 1,000.00');
    expect(approved?.body).toContain('by Cash');
  });

  it('writes to the claimant, never the member, for a claim — and says why when it is refused', async () => {
    const { demises, review, sent } = await load();
    const claim = await demises.startDemise(
      {
        memberId: member.id,
        claimant: { kind: 'nominee' },
        method: 'cash',
      },
      clerk
    );
    expect(claim.claimant).toMatchObject({
      email: 'yusuf@example.mu',
      mobile: null,
    });
    await filePaper(claim.id, certificateTypeId, clerk);
    await filePaper(claim.id, affidavitTypeId, clerk);
    await demises.submitDemise(claim.id, clerk);
    expect(await eventsFor(claim.id)).toEqual([
      'demised.submitted email yusuf@example.mu sent',
    ]);
    expect(sent[0].body).toContain('Assalamoualaikoum Yusuf Test');
    expect(sent[0].body).toContain('for Amina Test');
    expect(sent.some(s => s.recipient === 'amina@example.mu')).toBe(false);

    await review.reviewTransaction(
      claim.id,
      { outcome: 'reject', comment: 'The certificate is not legible.' },
      secretary
    );
    expect((await eventsFor(claim.id)).slice(1)).toEqual([
      'demised.rejected email yusuf@example.mu sent',
    ]);
    expect(sent[1].body).toContain(
      'was not approved. The certificate is not legible.'
    );

    // A claimant with no address on file: nothing sent, nothing failed.
    const silent = await demises.startDemise(
      {
        memberId: member.id,
        claimant: {
          kind: 'other',
          name: 'Nobody Reachable',
          nic: 'N1',
          address: 'Somewhere',
          relation: 'Cousin',
        },
        method: 'cash',
      },
      clerk
    );
    await filePaper(silent.id, certificateTypeId, clerk);
    await filePaper(silent.id, affidavitTypeId, clerk);
    await demises.submitDemise(silent.id, clerk);
    expect(await eventsFor(silent.id)).toEqual([]);
    await review.reviewTransaction(
      silent.id,
      { outcome: 'reject', comment: 'Not the nominee' },
      secretary
    );
  });

  it('names every placeholder the events fill in', async () => {
    const { placeholdersForEvent } =
      await import('../notifications/event-codes');
    expect(placeholdersForEvent('closure.submitted')).toEqual([
      'recipient_name',
      'member_name',
      'reference',
      'account',
      'amount',
    ]);
    expect(placeholdersForEvent('demised.rejected')).toContain('comment');
    expect(placeholdersForEvent('resignation.approved')).toEqual(
      expect.arrayContaining(['method', 'receipt_no'])
    );
    expect(placeholdersForEvent('closure.returned')).toBeNull();
  });
});

describe('the exits report (S-1706)', () => {
  it('lists closures, resignations and claims by period with amounts and turnaround', async () => {
    const { reports } = await load();
    const report = reports.reportByCode('exits')!;
    expect(report.permission).toBe('transaction.view');
    const today = new Date().toISOString().slice(0, 10);
    const result = await report.run({ from: today, to: today });
    expect(result.rows.length).toBeGreaterThanOrEqual(3);
    const closure = result.rows.find(r => r.Kind === 'Account closure')!;
    expect(closure).toMatchObject({
      Member: 'Amina Test',
      Status: 'posted',
      Amount: '1000.00',
      Days: 0,
    });
    expect(String(closure.Accounts)).toContain('Hajj Savings');
    expect(String(closure.Receipt)).toMatch(/^RCT-/);
    const rejected = result.rows.filter(r => r.Kind === 'Demised claim');
    expect(rejected.every(r => r.Status === 'rejected')).toBe(true);
    expect(rejected[0]['Paid to']).toBe('Nobody Reachable');
    expect(result.summary).toMatch(
      /1 account closure\(s\), Rs 1000\.00 paid out/
    );
    const only = await report.run({ from: today, to: today, kind: 'closure' });
    expect(only.rows.every(r => r.Kind === 'Account closure')).toBe(true);
    const none = await report.run({ from: '2000-01-01', to: '2000-01-02' });
    expect(none.rows).toEqual([]);
  });
});
