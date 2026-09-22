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

// A large cash deposit as a request (S-1306): started as a draft, the
// Source of Fund form filed against it and verified by somebody else, and
// only then the deposit an officer would otherwise have recorded at once.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `deposit_requests_test_${Date.now()}`;
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
    requests: await import('./deposit-requests'),
    deposits: await import('./deposits'),
    documents: await import('../documents/documents'),
    config: await import('../config/reference'),
    ledger: await import('./ledger'),
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
let secretary: Principal;
let msa: string;
let formTypeId: string;
let thresholdCents: number;

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
     values ($1, 1, 'committed', 'Source of Fund Form.pdf',
             'application/pdf', 1234, '/test/sof.pdf', $2, now())`,
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
     values ('u-officer', 'officer@albarakah.mu', 'Officer'),
            ('u-secretary', 'secretary@albarakah.mu', 'Secretary')
     returning id, email`
  );
  const byEmail = new Map(users.rows.map(r => [r.email, r.id]));
  officer = principalFor(
    byEmail.get('officer@albarakah.mu'),
    'officer@albarakah.mu',
    ['account_officer'],
    ['transaction.capture', 'transaction.post', 'document.verify']
  );
  secretary = principalFor(
    byEmail.get('secretary@albarakah.mu'),
    'secretary@albarakah.mu',
    ['secretary'],
    ['document.verify', 'transaction.view']
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
      `select id from document_type where code = 'source_of_fund_form'`
    )
  ).rows[0].id;
  // The MSA's own transaction cap would refuse a large deposit before the
  // cash rules could; the cash rules are what is under test.
  await run(
    appUrl,
    `begin; set local albarakah.actor_description = 'deposit-requests.test';
     update account_type set maximum_transaction_amount = null where code = 'msa';
     commit;`
  );
  const { config } = await load();
  thresholdCents = Math.round(
    Number(await config.cashSourceOfFundThreshold()) * 100
  );
}, 60_000);

afterAll(async () => {
  if (openPool) await openPool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

const rupees = (cents: number) => (cents / 100).toFixed(2);

describe('a large cash deposit as a request (S-1306)', () => {
  let requestId: string;

  it('starts only for cash above the threshold, and posts nothing yet', async () => {
    const { requests, deposits } = await load();
    const above = rupees(thresholdCents + 100_00);
    await expect(
      requests.startDepositRequest(
        { accountId: msa, amount: above, method: 'bank_transfer' },
        officer
      )
    ).rejects.toThrowError(/does not need a Source of Fund form/);
    await expect(
      requests.startDepositRequest(
        { accountId: msa, amount: rupees(thresholdCents), method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/does not need a Source of Fund form/);
    await expect(
      requests.startDepositRequest(
        { accountId: msa, amount: '600000', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/not authorised/);

    const request = await requests.startDepositRequest(
      { accountId: msa, amount: above, method: 'cash', reason: 'Savings' },
      officer
    );
    requestId = request.id;
    expect(request).toMatchObject({
      kind: 'deposit',
      status: 'draft',
      amount: above,
      method: 'cash',
      receiptNo: null,
      postedAt: null,
    });
    expect(await deposits.loadDeposit(request.id)).toMatchObject({
      status: 'draft',
    });
    const item = await requests.sourceOfFundItem(request.id);
    expect(item).toMatchObject({
      documentCode: 'source_of_fund_form',
      filed: null,
    });
    // Nothing on the ledger.
    expect(
      (await run(appUrl, `select count(*)::int as n from account_entry`))
        .rows[0].n
    ).toBe(0);
  });

  it('will not submit without the form, nor with it unverified, nor once rejected', async () => {
    const { requests, documents, review } = await load();
    await expect(
      requests.submitDepositRequest(requestId, officer)
    ).rejects.toThrowError(/File the signed Source of Fund form/);

    const documentId = await fileForm(requestId, officer);
    expect((await requests.sourceOfFundItem(requestId))!.filed).toMatchObject({
      documentId,
      state: 'under_review',
    });
    await expect(
      requests.submitDepositRequest(requestId, officer)
    ).rejects.toThrowError(/must be verified/);

    // Waiting on a second officer: in their queue, never in the captor's.
    expect((await review.formsToVerify(secretary)).map(t => t.id)).toContain(
      requestId
    );
    expect((await review.formsToVerify(officer)).map(t => t.id)).not.toContain(
      requestId
    );
    expect(await review.depositRequestsToFinish(officer)).toEqual([]);

    // The officer who recorded it cannot be the one who checks its papers.
    await expect(
      documents.reviewDocument(documentId, { outcome: 'verify' }, officer)
    ).rejects.toThrowError(/You recorded this transaction/);

    await documents.reviewDocument(
      documentId,
      { outcome: 'reject', reason: 'Unsigned' },
      secretary
    );
    await expect(
      requests.submitDepositRequest(requestId, officer)
    ).rejects.toThrowError(/was rejected/);

    // Checked: out of the verifier's queue, back in the captor's.
    expect(
      (await review.formsToVerify(secretary)).map(t => t.id)
    ).not.toContain(requestId);
    expect(await review.depositRequestsToFinish(officer)).toEqual([
      expect.objectContaining({ id: requestId, formState: 'rejected' }),
    ]);
  });

  it('posts once the form is verified, with its receipt, and the form is on the record', async () => {
    const { requests, documents, ledger } = await load();
    // Signed again: a fresh version, checked by the Secretary this time.
    await run(appUrl, `delete from document where transaction_id = $1`, [
      requestId,
    ]);
    const documentId = await fileForm(requestId, officer);
    expect(
      await documents.reviewDocument(
        documentId,
        { outcome: 'verify' },
        secretary
      )
    ).toEqual({ state: 'verified' });

    // The amount may still change while it is a draft, within the rules.
    const edited = await requests.updateDepositRequest(
      requestId,
      { amount: rupees(thresholdCents + 500_00), reason: 'Savings, revised' },
      officer
    );
    expect(edited.amount).toBe(rupees(thresholdCents + 500_00));
    await expect(
      requests.updateDepositRequest(requestId, { amount: '100' }, officer)
    ).rejects.toThrowError(
      /Cancel this request and record the deposit directly/
    );
    await expect(
      requests.updateDepositRequest(requestId, { amount: '200000' }, secretary)
    ).rejects.toThrowError(/to complete/);

    const posted = await requests.submitDepositRequest(requestId, officer);
    expect(posted).toMatchObject({
      status: 'posted',
      amount: rupees(thresholdCents + 500_00),
    });
    expect(posted.receiptNo).toMatch(/^RCT-/);
    expect(posted.postedAt).toBeInstanceOf(Date);
    expect((await ledger.accountBalance(msa))?.balance).toBe(
      rupees(thresholdCents + 500_00)
    );
    const row = await run(
      appUrl,
      `select source_of_fund_form_confirmed from transaction where id = $1`,
      [requestId]
    );
    expect(row.rows[0].source_of_fund_form_confirmed).toBe(true);

    // Once submitted it is no longer a draft to change, submit or cancel.
    await expect(
      requests.submitDepositRequest(requestId, officer)
    ).rejects.toThrowError(/is posted/);
    await expect(
      requests.cancelDepositRequest(requestId, officer)
    ).rejects.toThrowError(/is posted/);

    const trail = await run(
      appUrl,
      `select action from audit_event
        where entity_type = 'transaction' and entity_id = $1
        order by occurred_at`,
      [posted.reference]
    );
    expect(trail.rows.map(r => r.action)).toEqual([
      'transaction.captured',
      'transaction.edited',
      'transaction.posted',
    ]);
  });

  it('can be cancelled while it is a draft, by its captor only', async () => {
    const { requests } = await load();
    const request = await requests.startDepositRequest(
      { accountId: msa, amount: rupees(thresholdCents + 1_00), method: 'cash' },
      officer
    );
    expect(
      await requests.depositRequestsInFlightFor({
        memberId: (
          await run(appUrl, `select member_id from account where id = $1`, [
            msa,
          ])
        ).rows[0].member_id,
        customerId: null,
      })
    ).toEqual([
      { id: request.id, reference: request.reference, accountId: msa },
    ]);
    await expect(
      requests.cancelDepositRequest(request.id, secretary)
    ).rejects.toThrowError(/to complete/);
    const cancelled = await requests.cancelDepositRequest(request.id, officer);
    expect(cancelled.status).toBe('cancelled');
    await expect(
      requests.submitDepositRequest(request.id, officer)
    ).rejects.toThrowError(/is cancelled/);
  });
});
