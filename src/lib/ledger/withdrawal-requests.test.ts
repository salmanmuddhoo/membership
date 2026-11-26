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
import { openEveryDrawer } from '../cash/drawers.testing';
import type { Principal } from '../access/principal';

// A withdrawal at the counter as a request (withdrawal-requests.ts): started
// as a draft, the client's signed Withdrawal Form filed against it, and
// only then the withdrawal an officer used to record at once.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `withdrawal_requests_test_${Date.now()}`;
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

let openPool: typeof import('../db/pool') | null = null;

async function load() {
  if (openPool) await openPool.closePool();
  vi.resetModules();
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_ALLOW_INSECURE = 'true';
  process.env.PUBLIC_APP_ENV = 'test';
  delete process.env.NOTIFY_EMAIL_DELIVERY;
  delete process.env.NOTIFY_WHATSAPP_DELIVERY;
  openPool = await import('../db/pool');
  return {
    requests: await import('./withdrawal-requests'),
    withdrawals: await import('./withdrawals'),
    deposits: await import('./deposits'),
    review: await import('./review'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

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

let officer: Principal;
let msa: string;
let formTypeId: string;

// The signed form on file, as documents.ts leaves it once SharePoint has
// the bytes — inserted directly; Graph is not under test here.
async function fileForm(transactionId: string, by: Principal) {
  const doc = await run(
    appUrl,
    `insert into document (document_type_id, subject, transaction_id, state)
     values ($1, 'applicant', $2, 'under_review') returning id`,
    [formTypeId, transactionId]
  );
  await run(
    appUrl,
    `insert into document_version
       (document_id, version_no, state, file_name, content_type, size_bytes,
        sharepoint_path, uploaded_by, committed_at)
     values ($1, 1, 'committed', 'Withdrawal Form.pdf',
             'application/pdf', 1234, '/test/withdrawal.pdf', $2, now())`,
    [doc.rows[0].id, by.userId]
  );
  return doc.rows[0].id as string;
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const users = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('u-officer', 'officer@albarakah.mu', 'Officer')
     returning id, email`
  );
  const byEmail = new Map(users.rows.map(r => [r.email, r.id]));
  officer = principalFor(
    byEmail.get('officer@albarakah.mu'),
    'officer@albarakah.mu',
    ['account_officer'],
    [
      'transaction.capture',
      'transaction.post',
      'transaction.disburse',
      'transaction.document_verify',
    ]
  );
  const type = await run(
    appUrl,
    `select id from membership_type where code = 'individual'`
  );
  const application = await run(
    appUrl,
    `insert into membership_application (membership_type_id, captured_by, status)
     values ($1, $2, 'approved') returning id`,
    [type.rows[0].id, officer.userId]
  );
  await run(
    appUrl,
    `insert into application_party (application_id, subject, ordinal, values)
     values ($1, 'applicant', 1, '{"name": "Amina", "surname": "Test"}')`,
    [application.rows[0].id]
  );
  const member = await run(
    appUrl,
    `insert into member (member_no, application_id, membership_type_id)
     values ('AB0001', $1, $2) returning id`,
    [application.rows[0].id, type.rows[0].id]
  );
  msa = (
    await run(
      appUrl,
      `insert into account (member_id, account_type_id, is_membership_default, status)
       select $1, id, true, 'active' from account_type where code = 'msa'
       returning id`,
      [member.rows[0].id]
    )
  ).rows[0].id;
  formTypeId = (
    await run(
      appUrl,
      `select id from document_type where code = 'withdrawal_form'`
    )
  ).rows[0].id;
  await openEveryDrawer(ownerUrl);
  // Money to withdraw.
  const { deposits } = await load();
  await deposits.recordDeposit(
    { accountId: msa, amount: '40000', method: 'cash' },
    officer
  );
}, 60_000);

afterAll(async () => {
  if (openPool) await openPool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('a withdrawal at the counter', () => {
  it('starts as a draft that moves nothing, and the same form posted twice is the same draft', async () => {
    const { requests } = await load();
    const key = crypto.randomUUID();
    const draft = await requests.startWithdrawalRequest(
      { accountId: msa, amount: '1000', method: 'cash', idempotencyKey: key },
      officer
    );
    expect(draft.status).toBe('draft');
    expect(draft.receiptNo).toBeNull();
    const again = await requests.startWithdrawalRequest(
      { accountId: msa, amount: '1000', method: 'cash', idempotencyKey: key },
      officer
    );
    expect(again.id).toBe(draft.id);
    const entries = await run(
      appUrl,
      `select count(*)::int as n from account_entry where transaction_id = $1`,
      [draft.id]
    );
    expect(entries.rows[0].n).toBe(0);
  });

  it('refuses what a withdrawal refuses, before any draft is written', async () => {
    const { requests } = await load();
    await expect(
      requests.startWithdrawalRequest(
        { accountId: msa, amount: '999999', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/available/);
  });

  it('cannot be submitted until the client has signed the Withdrawal Form', async () => {
    const { requests } = await load();
    const draft = await requests.startWithdrawalRequest(
      { accountId: msa, amount: '1500', method: 'cash' },
      officer
    );
    await expect(
      requests.submitWithdrawalRequest(draft.id, officer)
    ).rejects.toThrowError(/signed Withdrawal Form/);

    await fileForm(draft.id, officer);
    const item = await requests.withdrawalFormItem(draft.id);
    expect(item?.filed).not.toBeNull();

    const submitted = await requests.submitWithdrawalRequest(draft.id, officer);
    expect(submitted.status).not.toBe('draft');
    // Paid out at once, or waiting on its chain — whichever the matrix says.
    if (submitted.status === 'posted') {
      expect(submitted.receiptNo).toMatch(/^RCT-/);
    } else {
      expect(['submitted', 'under_review']).toContain(submitted.status);
    }
  });

  it("can be cancelled while a draft, and is then no one's to submit", async () => {
    const { requests } = await load();
    const draft = await requests.startWithdrawalRequest(
      { accountId: msa, amount: '700', method: 'cash' },
      officer
    );
    const cancelled = await requests.cancelWithdrawalRequest(draft.id, officer);
    expect(cancelled.status).toBe('cancelled');
    await expect(
      requests.submitWithdrawalRequest(draft.id, officer)
    ).rejects.toThrowError(/cancelled/);
  });

  it("is its captor's to complete", async () => {
    const { requests } = await load();
    const draft = await requests.startWithdrawalRequest(
      { accountId: msa, amount: '800', method: 'cash' },
      officer
    );
    const colleague = { ...officer, userId: crypto.randomUUID() };
    await expect(
      requests.cancelWithdrawalRequest(draft.id, colleague)
    ).rejects.toThrowError(/to complete/);
  });
});
