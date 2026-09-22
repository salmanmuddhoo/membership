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

// Acting on what waits on a chain (S-1403, S-1404, S-1402's in-flight
// rule): the queue each role sees, review and decision with their
// comments, posting as a separate act, and a returned deposit corrected
// and re-entering where it left — or re-routed when its amount crosses a
// band. Against real migrations, like every ledger suite.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `review_test_${Date.now()}`;
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
    `begin; set local albarakah.actor_description = 'review.test'; ${sql}; commit;`
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
    deposits: await import('./deposits'),
    review: await import('./review'),
    config: await import('../config/reference'),
    timeline: await import('../workflow/timeline'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let clerk: Principal;
let officer: Principal;
let secretary: Principal;
let president: Principal;
let admin: { userId: string; email: string };
let memberId: string;
let shares: string;
let msa: string;
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
    roleNames: roles,
    permissions: new Set(permissions),
  } satisfies Principal;
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
            ('secretary@albarakah.mu', 'Secretary'),
            ('president@albarakah.mu', 'President'),
            ('admin@albarakah.mu', 'Admin')
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
  admin = {
    userId: byEmail.get('admin@albarakah.mu'),
    email: 'admin@albarakah.mu',
  };

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
     values ($1, 'applicant', 1, '{"name": "Amina", "surname": "Beeharry"}')`,
    [application.rows[0].id]
  );
  memberId = (
    await run(
      appUrl,
      `insert into member (application_id, membership_type_id)
       values ($1, $2) returning id`,
      [application.rows[0].id, membershipTypeId]
    )
  ).rows[0].id;
  const types = Object.fromEntries(
    (await run(appUrl, `select code, id from account_type`)).rows.map(r => [
      r.code,
      r.id,
    ])
  );
  const open = async (code: string) =>
    (
      await run(
        appUrl,
        `insert into account (member_id, account_type_id, is_membership_default, status)
         values ($1, $2, $3, 'active') returning id`,
        [memberId, types[code], code === 'shares']
      )
    ).rows[0].id;
  shares = await open('shares');
  msa = await open('msa');

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

async function balance(accountId: string): Promise<string> {
  const result = await run(
    appUrl,
    `select balance from account_balance where account_id = $1`,
    [accountId]
  );
  return result.rows[0]?.balance ?? '0.00';
}

async function trailOf(id: string) {
  return (
    await run(
      appUrl,
      `select from_status, to_status, step_code, actor_role, comment
         from transaction_transition where transaction_id = $1 order by id`,
      [id]
    )
  ).rows;
}

describe('the queue', () => {
  it('lists a large deposit for the Secretary, then the President, then whoever posts', async () => {
    const { deposits, review } = await load();
    const deposit = await deposits.recordDeposit(
      {
        accountId: shares,
        amount: '250000',
        method: 'bank_transfer',
        methodReference: 'BT-1',
        bankAccountId,
      },
      clerk
    );
    expect(deposit.status).toBe('submitted');

    let mine = await review.pendingTransactions(secretary);
    expect(mine.map(t => t.id)).toContain(deposit.id);
    const entry = mine.find(t => t.id === deposit.id)!;
    expect(entry.stepCode).toBe('secretary_review');
    expect(entry.stepRole).toBe('Secretary');
    expect(entry.holderName).toBe('Amina Beeharry');
    expect(entry.isLastStep).toBe(false);
    expect(
      (await review.pendingTransactions(president)).map(t => t.id)
    ).not.toContain(deposit.id);
    expect(await review.pendingTransactionCount(secretary)).toBe(1);
    expect(await review.pendingTransactionCount(president)).toBe(0);
    expect(await review.pendingTransactionCount(officer)).toBe(0);

    // Forward needs no comment.
    const reviewed = await review.reviewTransaction(
      deposit.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    expect(reviewed.status).toBe('under_review');
    expect(
      (await review.pendingTransactions(secretary)).map(t => t.id)
    ).not.toContain(deposit.id);
    mine = await review.pendingTransactions(president);
    expect(mine.find(t => t.id === deposit.id)?.isLastStep).toBe(true);

    const decided = await review.reviewTransaction(
      deposit.id,
      { outcome: 'forward', comment: 'Fine' },
      president
    );
    expect(decided.status).toBe('approved');
    expect(await review.pendingTransactionCount(president)).toBe(0);
    // Approval decides; nothing has moved yet.
    expect(await balance(shares)).toBe('0.00');
    expect(
      (await review.approvedTransactions(officer)).map(t => t.id)
    ).toContain(deposit.id);
    expect(await review.pendingTransactionCount(officer)).toBe(1);
    // Someone without transaction.post sees no "to post" queue.
    expect(await review.approvedTransactions(clerk)).toEqual([]);

    await expect(
      review.postApprovedTransaction(deposit.id, clerk)
    ).rejects.toThrowError(/permission/);
    const posted = await review.postApprovedTransaction(deposit.id, officer);
    expect(posted.status).toBe('posted');
    expect(posted.receiptNo).toMatch(/^RCT-\d{6}$/);
    expect(await balance(shares)).toBe('250000.00');
    expect(await review.pendingTransactionCount(officer)).toBe(0);

    expect(await trailOf(deposit.id)).toEqual([
      {
        from_status: null,
        to_status: 'submitted',
        step_code: null,
        actor_role: 'clerk',
        comment: null,
      },
      {
        from_status: 'submitted',
        to_status: 'under_review',
        step_code: 'secretary_review',
        actor_role: 'Secretary',
        comment: null,
      },
      {
        from_status: 'under_review',
        to_status: 'approved',
        step_code: 'president_decision',
        actor_role: 'President / Chairperson',
        comment: 'Fine',
      },
      {
        from_status: 'approved',
        to_status: 'posted',
        step_code: null,
        actor_role: 'account_officer',
        comment: null,
      },
    ]);
    // And the deposit's own view agrees.
    const reloaded = await deposits.loadDeposit(deposit.id);
    expect(reloaded?.status).toBe('posted');
    expect(reloaded?.currentStepCode).toBeNull();
  });

  it('refuses the wrong role, the wrong permission, and the officer who captured it', async () => {
    const { deposits, review } = await load();
    const deposit = await deposits.recordDeposit(
      {
        accountId: msa,
        amount: '150000',
        method: 'bank_transfer',
        methodReference: 'BT-2',
        bankAccountId,
      },
      officer
    );
    await expect(
      review.reviewTransaction(
        deposit.id,
        { outcome: 'forward', comment: '' },
        president
      )
    ).rejects.toThrowError(/permission/);
    // The right permission on the wrong role is still the wrong role.
    const presidentWhoReviews = {
      ...president,
      permissions: new Set(['transaction.review']),
    };
    await expect(
      review.reviewTransaction(
        deposit.id,
        { outcome: 'forward', comment: '' },
        presidentWhoReviews
      )
    ).rejects.toThrowError(/Secretary's step/);
    const wrongPermission = {
      ...secretary,
      permissions: new Set(['transaction.view']),
    };
    await expect(
      review.reviewTransaction(
        deposit.id,
        { outcome: 'forward', comment: '' },
        wrongPermission
      )
    ).rejects.toThrowError(/permission/);
    // The captor holding the Secretary's role is still the captor.
    const captorAsSecretary = {
      ...officer,
      roles: ['secretary'],
      permissions: new Set(['transaction.review']),
    };
    await expect(
      review.reviewTransaction(
        deposit.id,
        { outcome: 'forward', comment: '' },
        captorAsSecretary
      )
    ).rejects.toThrowError(/may not review/);

    await review.reviewTransaction(
      deposit.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    await review.reviewTransaction(
      deposit.id,
      { outcome: 'forward', comment: '' },
      president
    );
    // Approved — and the officer who captured it may not be the one who posts.
    await expect(
      review.postApprovedTransaction(deposit.id, officer)
    ).rejects.toThrowError(/may not post/);
    expect(await balance(msa)).toBe('0.00');
    // Nothing waits at a step any more.
    await expect(
      review.reviewTransaction(
        deposit.id,
        { outcome: 'forward', comment: '' },
        president
      )
    ).rejects.toThrowError(/approved; nothing is waiting/);
  });

  it('requires a comment to return or reject, and a rejection ends it', async () => {
    const { deposits, review } = await load();
    const deposit = await deposits.recordDeposit(
      {
        accountId: shares,
        amount: '120000',
        method: 'bank_transfer',
        methodReference: 'BT-3',
        bankAccountId,
      },
      clerk
    );
    await expect(
      review.reviewTransaction(
        deposit.id,
        { outcome: 'return', comment: '  ' },
        secretary
      )
    ).rejects.toThrowError(/what needs correcting/);
    await expect(
      review.reviewTransaction(
        deposit.id,
        { outcome: 'reject', comment: '' },
        secretary
      )
    ).rejects.toThrowError(/why/);
    const rejected = await review.reviewTransaction(
      deposit.id,
      { outcome: 'reject', comment: 'Not this member' },
      secretary
    );
    expect(rejected.status).toBe('rejected');
    expect(
      (await review.pendingTransactions(secretary)).map(t => t.id)
    ).not.toContain(deposit.id);
    expect(
      (await review.pendingTransactions(president)).map(t => t.id)
    ).not.toContain(deposit.id);
    await expect(
      review.postApprovedTransaction(deposit.id, officer)
    ).rejects.toThrowError(/rejected; only an approved/);
    // Its captor cannot revive it either.
    await expect(
      deposits.resubmitDeposit(
        deposit.id,
        {
          accountId: shares,
          amount: '120000',
          method: 'bank_transfer',
          methodReference: 'BT-3',
          bankAccountId,
        },
        clerk
      )
    ).rejects.toThrowError(/rejected, so it cannot be changed/);
  });
});

describe('return, edit, resubmit (S-1404)', () => {
  const edit = (amount: string, reference = 'BT-4') => ({
    accountId: shares,
    amount,
    method: 'bank_transfer',
    methodReference: reference,
    bankAccountId,
    reason: 'Corrected',
  });

  it('re-enters at the step that returned it, by its captor only, with both versions on the trail', async () => {
    const { deposits, review } = await load();
    const deposit = await deposits.recordDeposit(
      {
        accountId: shares,
        amount: '200000',
        method: 'bank_transfer',
        methodReference: 'BT-4',
        bankAccountId,
      },
      clerk
    );
    await review.reviewTransaction(
      deposit.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    const returned = await review.reviewTransaction(
      deposit.id,
      { outcome: 'return', comment: 'The slip says 210,000' },
      president
    );
    expect(returned.status).toBe('returned');
    // In the captor's "returned" queue, nobody else's.
    expect((await review.returnedTransactions(clerk)).map(t => t.id)).toContain(
      deposit.id
    );
    expect(await review.returnedTransactions(officer)).toEqual([]);
    expect(await review.pendingTransactionCount(clerk)).toBe(1);

    // Nobody but the captor edits it, and nobody edits it at a step.
    await expect(
      deposits.resubmitDeposit(deposit.id, edit('210000'), officer)
    ).rejects.toThrowError(/Only the officer who recorded/);

    const resubmitted = await deposits.resubmitDeposit(
      deposit.id,
      edit('210000'),
      clerk
    );
    // Back at the President, not the Secretary: the approval already given
    // is not asked for twice.
    expect(resubmitted.status).toBe('under_review');
    expect(resubmitted.currentStepCode).toBe('president_decision');
    expect(resubmitted.amount).toBe('210000.00');
    expect(resubmitted.reason).toBe('Corrected');
    expect(
      (await review.pendingTransactions(president)).map(t => t.id)
    ).toContain(deposit.id);
    expect(
      (await review.pendingTransactions(secretary)).map(t => t.id)
    ).not.toContain(deposit.id);
    expect(await review.returnedTransactions(clerk)).toEqual([]);

    await expect(
      deposits.resubmitDeposit(deposit.id, edit('220000'), clerk)
    ).rejects.toThrowError(/under_review, so it cannot be changed/);

    expect(await trailOf(deposit.id)).toEqual([
      {
        from_status: null,
        to_status: 'submitted',
        step_code: null,
        actor_role: 'clerk',
        comment: null,
      },
      {
        from_status: 'submitted',
        to_status: 'under_review',
        step_code: 'secretary_review',
        actor_role: 'Secretary',
        comment: null,
      },
      {
        from_status: 'under_review',
        to_status: 'returned',
        step_code: 'president_decision',
        actor_role: 'President / Chairperson',
        comment: 'The slip says 210,000',
      },
      {
        from_status: 'returned',
        to_status: 'under_review',
        step_code: null,
        actor_role: 'clerk',
        comment: null,
      },
    ]);
    const versions = await run(
      appUrl,
      `select previous_value->>'amount' as before, new_value->>'amount' as after
         from audit_event
        where entity_type = 'transaction' and entity_id = $1
          and action = 'transaction.resubmitted'`,
      [deposit.reference]
    );
    expect(versions.rows).toEqual([
      { before: '200000.00', after: '210000.00' },
    ]);

    const approved = await review.reviewTransaction(
      deposit.id,
      { outcome: 'forward', comment: '' },
      president
    );
    expect(approved.status).toBe('approved');
  });

  it('re-routes a correction that crosses a band: below the threshold it posts at once', async () => {
    const { deposits, review } = await load();
    const deposit = await deposits.recordDeposit(
      {
        accountId: msa,
        amount: '130000',
        method: 'bank_transfer',
        methodReference: 'BT-5',
        bankAccountId,
      },
      officer
    );
    await review.reviewTransaction(
      deposit.id,
      { outcome: 'return', comment: 'Should be 13,000' },
      secretary
    );
    const before = await balance(msa);
    const resubmitted = await deposits.resubmitDeposit(
      deposit.id,
      {
        accountId: msa,
        amount: '13000',
        method: 'bank_transfer',
        methodReference: 'BT-5',
        bankAccountId,
      },
      officer
    );
    expect(resubmitted.status).toBe('posted');
    expect(resubmitted.receiptNo).toMatch(/^RCT-\d{6}$/);
    expect(resubmitted.workflowName).toBeNull();
    expect(Number(await balance(msa)) - Number(before)).toBe(13000);
    const trail = await trailOf(deposit.id);
    expect(trail.map(t => t.to_status)).toEqual([
      'submitted',
      'returned',
      'submitted',
      'posted',
    ]);
    expect(trail[2].from_status).toBe('returned');
  });

  it('refuses a clerk a correction that would post at once', async () => {
    const { deposits, review } = await load();
    const deposit = await deposits.recordDeposit(
      {
        accountId: shares,
        amount: '101000',
        method: 'bank_transfer',
        methodReference: 'BT-6',
        bankAccountId,
      },
      clerk
    );
    await review.reviewTransaction(
      deposit.id,
      { outcome: 'return', comment: 'Amount?' },
      secretary
    );
    await expect(
      deposits.resubmitDeposit(deposit.id, edit('1000', 'BT-6'), clerk)
    ).rejects.toThrowError(/would post at once/);
    // Still returned, still theirs to correct.
    expect((await review.returnedTransactions(clerk)).map(t => t.id)).toContain(
      deposit.id
    );
  });

  it('keeps the account to the same person', async () => {
    const { deposits, review } = await load();
    const application = await run(
      appUrl,
      `insert into membership_application (membership_type_id, captured_by, status)
       select membership_type_id, captured_by, 'approved'
         from membership_application limit 1
       returning id`
    );
    const other = await run(
      appUrl,
      `insert into member (application_id, membership_type_id)
       select $1, membership_type_id from member where id = $2
       returning id`,
      [application.rows[0].id, memberId]
    );
    const theirs = (
      await run(
        appUrl,
        `insert into account (member_id, account_type_id, is_membership_default, status)
         select $1, account_type_id, true, 'active' from account where id = $2
         returning id`,
        [other.rows[0].id, shares]
      )
    ).rows[0].id;
    const deposit = await deposits.recordDeposit(
      {
        accountId: shares,
        amount: '300000',
        method: 'bank_transfer',
        methodReference: 'BT-7',
        bankAccountId,
      },
      clerk
    );
    await review.reviewTransaction(
      deposit.id,
      { outcome: 'return', comment: 'Wrong account' },
      secretary
    );
    await expect(
      deposits.resubmitDeposit(
        deposit.id,
        {
          accountId: theirs,
          amount: '300000',
          method: 'bank_transfer',
          methodReference: 'BT-7',
          bankAccountId,
        },
        clerk
      )
    ).rejects.toThrowError(/one of this person/);
  });
});

describe('the chain is read live (S-1402)', () => {
  it('moves a transaction waiting at a step that is disabled on to the next one', async () => {
    const { deposits, review, config } = await load();
    const deposit = await deposits.recordDeposit(
      {
        accountId: shares,
        amount: '400000',
        method: 'bank_transfer',
        methodReference: 'BT-8',
        bankAccountId,
      },
      clerk
    );
    const chain = (await config.listWorkflows()).find(
      w => w.code === 'transaction_deposit'
    )!;
    const step = chain.steps.find(s => s.code === 'secretary_review')!;
    await config.setStepEnabled(step.id, false, admin);
    try {
      expect(
        (await review.pendingTransactions(secretary)).map(t => t.id)
      ).not.toContain(deposit.id);
      const mine = await review.pendingTransactions(president);
      const entry = mine.find(t => t.id === deposit.id)!;
      expect(entry.stepCode).toBe('president_decision');
      expect(entry.isLastStep).toBe(true);
      const decided = await review.reviewTransaction(
        deposit.id,
        { outcome: 'forward', comment: '' },
        president
      );
      expect(decided.status).toBe('approved');
      expect(await trailOf(deposit.id)).toContainEqual({
        from_status: 'submitted',
        to_status: 'approved',
        step_code: 'president_decision',
        actor_role: 'President / Chairperson',
        comment: null,
      });
    } finally {
      await config.setStepEnabled(step.id, true, admin);
    }
  });

  it('re-enters a returned transaction at the first enabled step when its own is disabled', async () => {
    const { deposits, review, config } = await load();
    const deposit = await deposits.recordDeposit(
      {
        accountId: shares,
        amount: '500000',
        method: 'bank_transfer',
        methodReference: 'BT-9',
        bankAccountId,
      },
      clerk
    );
    await review.reviewTransaction(
      deposit.id,
      { outcome: 'return', comment: 'Slip?' },
      secretary
    );
    const chain = (await config.listWorkflows()).find(
      w => w.code === 'transaction_deposit'
    )!;
    const step = chain.steps.find(s => s.code === 'secretary_review')!;
    await config.setStepEnabled(step.id, false, admin);
    try {
      const resubmitted = await deposits.resubmitDeposit(
        deposit.id,
        {
          accountId: shares,
          amount: '500000',
          method: 'bank_transfer',
          methodReference: 'BT-9',
          bankAccountId,
        },
        clerk
      );
      expect(resubmitted.status).toBe('submitted');
      expect(resubmitted.currentStepCode).toBe('president_decision');
    } finally {
      await config.setStepEnabled(step.id, true, admin);
    }
  });
});

describe('the chevron reads the live chain (S-1405)', () => {
  it('has no approval stage for a deposit routed nowhere, and the chain for one routed to it', async () => {
    const { deposits, review, config, timeline } = await load();
    const small = await deposits.recordDeposit(
      { accountId: msa, amount: '50', method: 'cash' },
      officer
    );
    const steps = (await timeline.chainTimeline('transaction', small.id))!;
    expect(steps.map(s => [s.key, s.state])).toEqual([
      ['capture', 'done'],
      ['posted', 'done'],
    ]);
    expect(steps[1].detail).toBe(small.receiptNo);

    const large = await deposits.recordDeposit(
      {
        accountId: shares,
        amount: '600000',
        method: 'bank_transfer',
        methodReference: 'BT-10',
        bankAccountId,
      },
      clerk
    );
    const waiting = (await timeline.chainTimeline('transaction', large.id))!;
    expect(waiting.map(s => [s.key, s.state])).toEqual([
      ['capture', 'done'],
      ['secretary_review', 'current'],
      ['president_decision', 'todo'],
      ['posted', 'todo'],
    ]);

    // Disable the Secretary: the chevron omits the step and the President
    // is next, with no front-end change.
    const chain = (await config.listWorkflows()).find(
      w => w.code === 'transaction_deposit'
    )!;
    const step = chain.steps.find(s => s.code === 'secretary_review')!;
    await config.setStepEnabled(step.id, false, admin);
    try {
      const now = (await timeline.chainTimeline('transaction', large.id))!;
      expect(now.map(s => [s.key, s.state])).toEqual([
        ['capture', 'done'],
        ['president_decision', 'current'],
        ['posted', 'todo'],
      ]);
    } finally {
      await config.setStepEnabled(step.id, true, admin);
    }

    await review.reviewTransaction(
      large.id,
      { outcome: 'return', comment: 'Slip missing' },
      secretary
    );
    const returned = (await timeline.chainTimeline('transaction', large.id))!;
    expect(returned[0]).toMatchObject({
      key: 'capture',
      state: 'current',
      problem: true,
      detail: 'Returned by Secretary',
    });
    // And by reference, the way the audit log names it.
    expect((await review.loadTransactionByReference(large.reference))?.id).toBe(
      large.id
    );
  });
});
