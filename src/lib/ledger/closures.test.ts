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

// Closing an account (S-1702) and what a member's status permits (S-1701),
// against real migrations: the request's life before its chain, the chain
// itself, the disbursement that closes the account, and everything refused
// on the way.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `closures_test_${Date.now()}`;
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

async function configure(sql: string) {
  await run(
    appUrl,
    `begin; set local albarakah.actor_description = 'closures.test'; ${sql}; commit;`
  );
}

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
  openPool = await import('../db/pool');
  return {
    closures: await import('./closures'),
    deposits: await import('./deposits'),
    withdrawals: await import('./withdrawals'),
    review: await import('./review'),
    ledger: await import('./ledger'),
    timeline: await import('../workflow/timeline'),
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
let requestTypeId: string;
let bankAccountId: string;

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

// The signed request on file, as documents.ts would leave it once
// SharePoint confirmed the bytes — inserted directly, since Graph is not
// under test here (documents.test.ts covers the filing).
async function fileRequest(transactionId: string, by: Principal) {
  const doc = await run(
    appUrl,
    `insert into document (document_type_id, subject, transaction_id, state)
     values ($1, 'applicant', $2, 'under_review') returning id`,
    [requestTypeId, transactionId]
  );
  await run(
    appUrl,
    `insert into document_version
       (document_id, version_no, state, file_name, content_type, size_bytes,
        sharepoint_path, uploaded_by, committed_at)
     values ($1, 1, 'committed', 'Account closure request.pdf',
             'application/pdf', 1234, '/test/closure.pdf', $2, now())`,
    [doc.rows[0].id, by.userId]
  );
  return doc.rows[0].id as string;
}

let accountNo = 0;
async function openAccount(code: string, isDefault = false) {
  const type = await run(
    appUrl,
    `select id from account_type where code = $1`,
    [code]
  );
  const account = await run(
    appUrl,
    `insert into account
       (member_id, account_type_id, is_membership_default, status, account_no)
     values ($1, $2, $3, 'active', $4) returning id`,
    [
      member.id,
      type.rows[0].id,
      isDefault,
      isDefault
        ? null
        : `${code.toUpperCase()}${String(++accountNo).padStart(4, '0')}`,
    ]
  );
  return account.rows[0].id as string;
}

async function accountStatus(id: string) {
  return (
    await run(appUrl, `select status, closed_at from account where id = $1`, [
      id,
    ])
  ).rows[0];
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
    [
      'transaction.capture',
      'transaction.post',
      'transaction.disburse',
      'transaction.view',
    ]
  );
  treasurer = principalFor(
    byEmail.get('treasurer@albarakah.mu'),
    'treasurer@albarakah.mu',
    ['treasurer'],
    ['transaction.post', 'transaction.disburse', 'transaction.view']
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

  // The account types a member can close: neither is seeded (0010 seeds
  // the MSA, 0018 the Shares), and one does not allow withdrawals — a
  // closure is how money leaves it.
  await run(
    appUrl,
    `begin; set local albarakah.actor_description = 'closures.test';
     insert into account_type
       (code, name, category, number_prefix, sort_order, allows_withdrawal)
     values ('hsa', 'Hajj Savings', 'savings', 'HSA', 5, false),
            ('investment', 'Investment', 'investment', 'INV', 6, true),
            ('education', 'Education Savings', 'savings', 'EDU', 7, true);
     commit;`
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
     values ($1, 'applicant', 1, '{"name": "Amina", "surname": "Test"}')`,
    [application.rows[0].id]
  );
  const m = await run(
    appUrl,
    `insert into member (application_id, membership_type_id)
     values ($1, $2) returning id`,
    [application.rows[0].id, membershipTypeId]
  );
  member = { id: m.rows[0].id, shares: '', msa: '', hsa: '' };
  member.shares = await openAccount('shares', true);
  member.msa = await openAccount('msa');
  member.hsa = await openAccount('hsa');
  requestTypeId = (
    await run(
      appUrl,
      `select id from document_type where code = 'closure_request'`
    )
  ).rows[0].id;

  await configure(
    `insert into bank_account (code, name, bank_name, account_number)
     values ('mcb', 'MCB current', 'MCB', '000123456789')`
  );
  bankAccountId = (
    await run(appUrl, `select id from bank_account where code = 'mcb'`)
  ).rows[0].id;
}, 60_000);

afterAll(async () => {
  await closeOpenPool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('member status (S-1701)', () => {
  it('refuses a status outside the vocabulary, and stamps a change', async () => {
    await expect(
      run(appUrl, `update member set status = 'gone' where id = $1`, [
        member.id,
      ])
    ).rejects.toThrowError(/member_status_check/);
    await run(
      appUrl,
      `update member set status = 'dormant', status_changed_at = now() where id = $1`,
      [member.id]
    );
    const { deposits, closures } = await load();
    await expect(
      deposits.recordDeposit(
        { accountId: member.hsa, amount: '100', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/This member is dormant/);
    await expect(
      closures.startClosure(
        { accountId: member.hsa, reason: 'Moving abroad', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/This member is dormant/);
    await run(
      appUrl,
      `update member set status = 'active', status_changed_at = now() where id = $1`,
      [member.id]
    );
  });

  it('names what an account may be', async () => {
    await expect(
      run(appUrl, `update account set status = 'gone' where id = $1`, [
        member.hsa,
      ])
    ).rejects.toThrowError(/account_status_check/);
    await expect(
      run(appUrl, `update account set status = 'closed' where id = $1`, [
        member.hsa,
      ])
    ).rejects.toThrowError(/account_closed_is_dated/);
  });
});

describe('a closure request (S-1702)', () => {
  it('refuses a membership account by naming resignation, and needs a reason', async () => {
    const { closures } = await load();
    await expect(
      closures.startClosure(
        { accountId: member.shares, reason: 'Done', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/membership account. Closing it is a resignation/);
    await expect(
      closures.startClosure(
        { accountId: member.hsa, reason: '  ', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/Say why/);
    await expect(
      closures.startClosure(
        { accountId: member.hsa, reason: 'Done', method: 'cash' },
        secretary
      )
    ).rejects.toThrowError(/permission/);
  });

  it('is a draft the officer builds, submits with the signed request, and the chain decides; posting pays out the balance and closes the account', async () => {
    const { closures, deposits, review, ledger, timeline } = await load();
    await deposits.recordDeposit(
      { accountId: member.hsa, amount: '2500', method: 'cash' },
      officer
    );

    // Nothing asked about the payout: it goes for approval, and the
    // Treasurer says how it was paid at the disbursement. The first offered
    // method stands in until then.
    const draft = await closures.startClosure(
      { accountId: member.hsa, reason: 'Moving abroad' },
      clerk
    );
    expect(draft).toMatchObject({
      kind: 'closure',
      status: 'draft',
      amount: '2500.00',
      reason: 'Moving abroad',
      method: 'cash',
      methodReference: '',
    });
    expect((await accountStatus(member.hsa)).status).toBe('active');
    // A second request on the same account, or the officer's own on
    // another's draft, is refused.
    await expect(
      closures.startClosure(
        { accountId: member.hsa, reason: 'Again', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/is already closing this account/);
    await expect(
      closures.updateClosure(draft.id, { reason: 'x', method: 'cash' }, officer)
    ).rejects.toThrowError(/Clerk's to complete/);
    const edited = await closures.updateClosure(
      draft.id,
      { reason: 'Moving to Rodrigues', method: 'cash' },
      clerk
    );
    expect(edited.reason).toBe('Moving to Rodrigues');
    expect(edited.method).toBe('cash');

    // Nothing submits without the signed request.
    await expect(closures.submitClosure(draft.id, clerk)).rejects.toThrowError(
      /File the signed closure request/
    );
    expect(
      (await timeline.chainTimeline('transaction', draft.id))!.map(s => [
        s.key,
        s.state,
      ])
    ).toEqual([
      ['details', 'done'],
      ['signature', 'current'],
      ['documents', 'todo'],
      ['capture', 'todo'],
      ['secretary_review', 'todo'],
      ['president_decision', 'todo'],
      ['posted', 'todo'],
    ]);
    await fileRequest(draft.id, clerk);
    const checklist = await closures.closureChecklist(draft.id);
    expect(checklist).toHaveLength(1);
    expect(checklist[0].filed?.fileName).toBe('Account closure request.pdf');

    // Money still on its way on the account blocks the closure.
    const pending = await deposits.recordDeposit(
      {
        accountId: member.hsa,
        amount: '150000',
        method: 'bank_transfer',
        methodReference: 'MCB 9001',
        bankAccountId,
      },
      officer
    );
    expect(pending.status).toBe('submitted');
    await expect(closures.submitClosure(draft.id, clerk)).rejects.toThrowError(
      new RegExp(`${pending.reference} is still on its way`)
    );
    await review.reviewTransaction(
      pending.id,
      { outcome: 'reject', comment: 'Not now' },
      secretary
    );

    const submitted = await closures.submitClosure(draft.id, clerk);
    expect(submitted.status).toBe('submitted');
    expect(submitted.currentStepCode).toBe('secretary_review');
    expect(submitted.workflowCode).toBe('transaction_closure');
    expect(submitted.amount).toBe('2500.00');
    expect((await accountStatus(member.hsa)).status).toBe('closing');
    // Nothing else moves on a closing account, and the balance reads as
    // spoken for.
    await expect(
      deposits.recordDeposit(
        { accountId: member.hsa, amount: '10', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/This account is closing/);
    expect(await ledger.availableBalance(member.hsa)).toMatchObject({
      balance: '2500.00',
      pendingDebits: '2500.00',
      available: '0.00',
    });
    await expect(
      closures.updateClosure(draft.id, { reason: 'x', method: 'cash' }, clerk)
    ).rejects.toThrowError(/is submitted, so it cannot be changed/);

    // Returned, corrected, resubmitted where it left (S-1404).
    await review.reviewTransaction(
      draft.id,
      { outcome: 'return', comment: 'Reason too vague' },
      secretary
    );
    expect((await accountStatus(member.hsa)).status).toBe('closing');
    await closures.updateClosure(
      draft.id,
      { reason: 'Moving to Rodrigues in October', method: 'cash' },
      clerk
    );
    const resubmitted = await closures.submitClosure(draft.id, clerk);
    expect(resubmitted.status).toBe('submitted');
    expect(resubmitted.currentStepCode).toBe('secretary_review');

    await review.reviewTransaction(
      draft.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    await review.reviewTransaction(
      draft.id,
      { outcome: 'forward', comment: 'Agreed' },
      president
    );
    expect(
      (await closures.closuresInFlightFor({ memberId: member.id })).get(
        member.hsa
      )
    ).toMatchObject({ id: draft.id, status: 'approved' });

    // Paying out: the balance, by the method recorded now, and the account
    // is closed in the same act.
    await expect(
      review.postApprovedTransaction(draft.id, treasurer)
    ).rejects.toThrowError(/Say how it was paid out/);
    const posted = await review.postApprovedTransaction(draft.id, treasurer, {
      method: 'cash',
    });
    expect(posted.status).toBe('posted');
    expect(posted.amount).toBe('2500.00');
    expect(posted.balanceAfter).toBe('0.00');
    expect(posted.receiptNo).toMatch(/^RCT-/);
    expect(await accountStatus(member.hsa)).toMatchObject({
      status: 'closed',
      closed_at: expect.any(Date),
    });
    expect((await ledger.accountBalance(member.hsa))?.balance).toBe('0.00');
    const entry = await run(
      appUrl,
      `select direction, amount from account_entry where transaction_id = $1`,
      [draft.id]
    );
    expect(entry.rows).toEqual([{ direction: 'debit', amount: '2500.00' }]);
    const event = await run(
      appUrl,
      `select payload from financial_event where transaction_id = $1`,
      [draft.id]
    );
    expect(event.rows[0].payload).toMatchObject({
      kind: 'closure',
      account_closed: true,
      balance_after: 0,
    });
    expect(
      (await timeline.chainTimeline('transaction', draft.id))!.map(s => [
        s.key,
        s.state,
      ])
    ).toEqual([
      ['details', 'done'],
      ['signature', 'done'],
      ['documents', 'done'],
      ['capture', 'done'],
      ['secretary_review', 'done'],
      ['president_decision', 'done'],
      ['posted', 'done'],
    ]);

    // Closed means closed.
    await expect(
      deposits.recordDeposit(
        { accountId: member.hsa, amount: '10', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/This account is closed/);
    await expect(
      closures.startClosure(
        { accountId: member.hsa, reason: 'Again', method: 'cash' },
        officer
      )
    ).rejects.toThrowError(/is already closed/);
    expect(
      (await closures.closuresInFlightFor({ memberId: member.id })).size
    ).toBe(0);
  });

  it('reopens the account when the chain rejects it, and when the officer withdraws it', async () => {
    const { closures, review } = await load();
    const investment = await openAccount('investment');
    const first = await closures.startClosure(
      { accountId: investment, reason: 'Matured', method: 'cash' },
      clerk
    );
    await fileRequest(first.id, clerk);
    await closures.submitClosure(first.id, clerk);
    expect((await accountStatus(investment)).status).toBe('closing');
    await review.reviewTransaction(
      first.id,
      { outcome: 'reject', comment: 'Not matured yet' },
      secretary
    );
    expect((await accountStatus(investment)).status).toBe('active');

    const second = await closures.startClosure(
      { accountId: investment, reason: 'Matured now', method: 'cash' },
      clerk
    );
    await fileRequest(second.id, clerk);
    await closures.submitClosure(second.id, clerk);
    await review.reviewTransaction(
      second.id,
      { outcome: 'return', comment: 'Sign it again' },
      secretary
    );
    const cancelled = await closures.cancelClosure(second.id, clerk);
    expect(cancelled.status).toBe('cancelled');
    expect((await accountStatus(investment)).status).toBe('active');
  });

  it('closes an empty account with no entry, and refuses to post a figure that is not the balance', async () => {
    const { closures, review, ledger } = await load();
    const empty = await openAccount('education');
    const request = await closures.startClosure(
      { accountId: empty, reason: 'Never used', method: 'cash' },
      officer
    );
    expect(request.amount).toBe('0.00');
    await fileRequest(request.id, officer);
    await closures.submitClosure(request.id, officer);
    await review.reviewTransaction(
      request.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    await review.reviewTransaction(
      request.id,
      { outcome: 'forward', comment: '' },
      president
    );

    // The engine's own guard, below the refresh postApprovedTransaction
    // does: a closure whose amount is not the balance does not post.
    await run(ownerUrl, `update transaction set amount = 5 where id = $1`, [
      request.id,
    ]);
    await expect(
      run(ownerUrl, `select post_transaction($1, $2, 'test')`, [
        request.id,
        treasurer.userId,
      ])
    ).rejects.toThrowError(/closes account .* for 5.00 but its balance is 0/);

    const posted = await review.postApprovedTransaction(request.id, treasurer, {
      method: 'cash',
    });
    expect(posted.status).toBe('posted');
    expect(posted.amount).toBe('0.00');
    expect(posted.receiptNo).toMatch(/^RCT-/);
    expect((await accountStatus(empty)).status).toBe('closed');
    expect(await ledger.accountBalance(empty)).toBeNull();
    const entries = await run(
      appUrl,
      `select count(*)::int as n from account_entry where transaction_id = $1`,
      [request.id]
    );
    expect(entries.rows[0].n).toBe(0);
  });
});
