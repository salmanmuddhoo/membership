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
import type { MemberPrincipal } from './identity';

// Transactions a member starts from the app (S-2102): switched on one by
// one, captured by the system user in the Member role, routed by the matrix
// and never posted by the app itself.
const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `member_transactions_test_${Date.now()}`;
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
    member: await import('./transactions'),
    config: await import('../config/reference'),
    readiness: await import('../config/readiness'),
    deposits: await import('../ledger/deposits'),
    review: await import('../ledger/review'),
  };
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

let officer: Principal;
let fatimah: MemberPrincipal;
let stranger: MemberPrincipal;
let fatimahMsa: string;
let strangerMsa: string;
let bankAccountId: string;
let memberRoleId: string;
let systemUserId: string;
let accountOfficer: Principal;
let secretary: Principal;
let president: Principal;
let treasurer: Principal;
let secondAccountOfficer: Principal;

async function staff(
  subject: string,
  role: string,
  permissions: string[]
): Promise<Principal> {
  const user = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ($1, $2, $1) returning id`,
    [subject, `${subject}@albarakah.mu`]
  );
  return {
    userId: user.rows[0].id,
    entraSubject: subject,
    email: `${subject}@albarakah.mu`,
    displayName: subject,
    roles: [role],
    roleNames: [],
    permissions: new Set(permissions),
  };
}
const actor = { userId: '', email: 'officer@albarakah.mu' };

function memberPrincipal(memberId: string, mobile: string): MemberPrincipal {
  return {
    sessionId: `session-${mobile}`,
    mobile,
    memberId,
    customerId: null,
    kind: 'member',
  };
}

async function memberWithMsa(memberNo: string, name: string) {
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
     values ($1, 'applicant', 1, $2::jsonb)`,
    [application.rows[0].id, JSON.stringify({ name, surname: 'Test' })]
  );
  const member = await run(
    appUrl,
    `insert into member (member_no, application_id, membership_type_id)
     values ($1, $2, $3) returning id`,
    [memberNo, application.rows[0].id, type.rows[0].id]
  );
  const account = await run(
    appUrl,
    `insert into account (member_id, account_type_id, is_membership_default, status)
     select $1, id, true, 'active' from account_type where code = 'msa'
     returning id`,
    [member.rows[0].id]
  );
  return { memberId: member.rows[0].id, msa: account.rows[0].id };
}

async function transactionRow(id: string) {
  return (
    await run(
      appUrl,
      `select t.status, t.captured_by, t.current_step_code, t.cash_session_id,
              (select actor_role from transaction_transition
                where transaction_id = t.id order by id limit 1) as actor_role
         from transaction t where t.id = $1`,
      [id]
    )
  ).rows[0];
}

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('test-officer', 'officer@albarakah.mu', 'Officer') returning id`
  );
  officer = {
    userId: user.rows[0].id,
    entraSubject: 'test-officer',
    email: 'officer@albarakah.mu',
    displayName: 'Officer',
    roles: ['account_officer'],
    roleNames: ['Account Officer'],
    permissions: new Set([
      'transaction.capture',
      'transaction.post',
      'transaction.disburse',
      'transaction.view',
    ]),
  };
  actor.userId = officer.userId;
  memberRoleId = (
    await run(appUrl, `select id from role where code = 'member'`)
  ).rows[0].id;
  systemUserId = (
    await run(
      appUrl,
      `select id from app_user where entra_subject = 'system:member-app'`
    )
  ).rows[0].id;
  bankAccountId = (
    await run(
      appUrl,
      `begin; set local albarakah.actor_description = 'member.test';
       insert into bank_account (code, name, bank_name, account_number)
       values ('mcb', 'MCB current', 'MCB', '000123456789'); commit;
       select id from bank_account where code = 'mcb'`
    ).then(r => (Array.isArray(r) ? r[r.length - 1] : r))
  ).rows[0].id;

  accountOfficer = await staff('accounts', 'account_officer', [
    'transaction.view',
    'transaction.post',
    'transaction.approve',
  ]);
  // The segregation rules bar whoever verified a deposit from recording
  // it too: two people in the accounts department, four eyes.
  secondAccountOfficer = await staff('accounts-2', 'account_officer', [
    'transaction.view',
    'transaction.post',
    'transaction.approve',
  ]);
  secretary = await staff('secretary', 'secretary', [
    'transaction.view',
    'transaction.review',
  ]);
  president = await staff('president', 'president', [
    'transaction.view',
    'transaction.approve',
  ]);
  treasurer = await staff('treasurer', 'treasurer', [
    'transaction.view',
    'transaction.disburse',
  ]);

  const first = await memberWithMsa('AB0001', 'Fatimah');
  const second = await memberWithMsa('AB0002', 'Yusuf');
  fatimahMsa = first.msa;
  strangerMsa = second.msa;
  fatimah = memberPrincipal(first.memberId, '+23057891234');
  stranger = memberPrincipal(second.memberId, '+23057895678');

  // Something to draw on.
  const { deposits } = await load();
  await deposits.recordDeposit(
    { accountId: fatimahMsa, amount: '5000', method: 'cash' },
    officer
  );
}, 60_000);

afterAll(async () => {
  if (openPool) await openPool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

describe('transactions from the member app (S-2102)', () => {
  it('refuses every operation until the Society switches it on', async () => {
    const { member, config, readiness } = await load();
    expect(await config.enabledMemberOperations()).toEqual([]);
    const deposit = {
      accountId: fatimahMsa,
      amount: '100',
      method: 'bank_transfer',
      methodReference: 'MB-1',
      bankAccountId,
    };
    await expect(
      member.recordMemberDeposit(fatimah, deposit)
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: 'A deposit cannot be started from the app.',
    });
    await expect(
      member.recordMemberWithdrawal(fatimah, {
        accountId: fatimahMsa,
        amount: '100',
        method: 'cash',
      })
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: 'A withdrawal cannot be started from the app.',
    });
    await expect(
      member.recordMemberTransfer(fatimah, {
        sourceAccountId: fatimahMsa,
        destinationAccountId: strangerMsa,
        amount: '100',
      })
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: 'A transfer cannot be started from the app.',
    });
    const row = (await readiness.readiness()).find(
      i => i.group === 'Member app'
    )!;
    expect(row).toMatchObject({
      label: 'Transactions from the member app',
      value: 'None',
      state: 'default',
      href: '/admin/configuration/member-app',
    });

    // The switch: only the three, each once, in the fixed order.
    await expect(
      config.setEnabledMemberOperations(['deposit', 'refund'], actor)
    ).rejects.toThrowError(/refund is not a transaction/);
    await config.setEnabledMemberOperations(
      ['transfer', 'deposit', 'deposit'],
      actor
    );
    expect(await config.enabledMemberOperations()).toEqual([
      'deposit',
      'transfer',
    ]);
    const changed = (await readiness.readiness()).find(
      i => i.group === 'Member app'
    )!;
    expect(changed).toMatchObject({
      value: 'Deposit, Transfer',
      state: 'changed',
      changedBy: 'Officer',
    });
    await config.setEnabledMemberOperations(
      ['deposit', 'withdrawal', 'transfer'],
      actor
    );
  });

  it('routes a deposit from the app to the accounts department, never straight onto the ledger', async () => {
    const { member, config } = await load();
    const deposit = {
      accountId: fatimahMsa,
      amount: '1000',
      method: 'bank_transfer',
      methodReference: 'MB-2',
      bankAccountId,
    };
    // Nobody took cash from a phone.
    await expect(
      member.recordMemberDeposit(fatimah, { ...deposit, method: 'cash' })
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Cash cannot be paid in from the app.',
    });
    // The branch's rules apply underneath: the bank account is demanded.
    await expect(
      member.recordMemberDeposit(fatimah, {
        ...deposit,
        bankAccountId: undefined,
      })
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: expect.stringMatching(/bank account/),
    });
    // Migration 0120's rule "by Member": any amount goes to Accounts
    // verification, even one the matrix posts at once for an officer.
    const recorded = await member.recordMemberDeposit(fatimah, {
      ...deposit,
      idempotencyKey: 'app-deposit-1',
    });
    expect(recorded).toMatchObject({
      status: 'submitted',
      amount: '1000.00',
      method: 'bank_transfer',
      bankAccountId,
    });
    expect(await transactionRow(recorded.id)).toEqual({
      status: 'submitted',
      captured_by: systemUserId,
      current_step_code: 'accounts_verification',
      cash_session_id: null,
      actor_role: 'Member',
    });
    // The same key from the same phone is the same deposit.
    const again = await member.recordMemberDeposit(fatimah, {
      ...deposit,
      idempotencyKey: 'app-deposit-1',
    });
    expect(again.id).toBe(recorded.id);
    // Somebody else's account: no such account.
    await expect(
      member.recordMemberDeposit(fatimah, {
        ...deposit,
        accountId: strangerMsa,
      })
    ).rejects.toMatchObject({ code: 'not_found' });

    // Without the Member rule the officers' bands apply, and Rs 1,000
    // posts at once — which the app never does.
    const rule = (await config.listApprovalRules()).find(
      r => r.kind === 'deposit' && r.initiatingRoleCode === 'member'
    )!;
    const input = {
      kind: rule.kind,
      accountTypeId: rule.accountTypeId,
      initiatingRoleId: rule.initiatingRoleId,
      amountFrom: rule.amountFrom,
      amountTo: rule.amountTo,
      workflowDefinitionId: rule.workflowDefinitionId,
      note: rule.note,
    };
    await config.updateApprovalRule(
      rule.id,
      { ...input, isActive: false },
      actor
    );
    try {
      await expect(
        member.recordMemberDeposit(fatimah, deposit)
      ).rejects.toMatchObject({
        code: 'forbidden',
        message:
          'A deposit of this amount cannot be made from the app. Please visit the branch.',
      });
    } finally {
      await config.updateApprovalRule(
        rule.id,
        { ...input, isActive: true },
        actor
      );
    }
  });

  it("routes a withdrawal and a transfer to the Secretary, from the caller's own account only", async () => {
    const { member } = await load();
    const withdrawal = await member.recordMemberWithdrawal(fatimah, {
      accountId: fatimahMsa,
      amount: '300',
    });
    expect(withdrawal).toMatchObject({
      status: 'submitted',
      workflowCode: 'transaction_withdrawal',
      currentStepCode: 'secretary_review',
    });
    expect((await transactionRow(withdrawal.id)).actor_role).toBe('Member');
    // More than the account holds: the ledger's own refusal, as the API
    // says it.
    await expect(
      member.recordMemberWithdrawal(fatimah, {
        accountId: fatimahMsa,
        amount: '1000000',
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      member.recordMemberWithdrawal(stranger, {
        accountId: fatimahMsa,
        amount: '1',
      })
    ).rejects.toMatchObject({ code: 'not_found' });

    const transfer = await member.recordMemberTransfer(fatimah, {
      sourceAccountId: fatimahMsa,
      destinationAccountId: strangerMsa,
      amount: '200',
      reason: 'For Yusuf',
    });
    expect(transfer.status).toBe('submitted');
    expect(transfer.debitLeg.accountId).toBe(fatimahMsa);
    expect(transfer.debitLeg.currentStepCode).toBe('secretary_review');
    expect(transfer.creditLeg?.accountId).toBe(strangerMsa);
    expect((await transactionRow(transfer.debitLeg.id)).captured_by).toBe(
      systemUserId
    );
    // The source must be the caller's; the destination must exist.
    await expect(
      member.recordMemberTransfer(stranger, {
        sourceAccountId: fatimahMsa,
        destinationAccountId: strangerMsa,
        amount: '1',
      })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      member.recordMemberTransfer(fatimah, {
        sourceAccountId: fatimahMsa,
        destinationAccountId: '00000000-0000-0000-0000-000000000000',
        amount: '1',
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('officers validate what a member asks for, and the member sees where it stands', () => {
  it('a deposit is pending until the accounts department verifies and records it', async () => {
    const { member, review } = await load();
    const deposit = await member.recordMemberDeposit(fatimah, {
      accountId: fatimahMsa,
      amount: '750',
      method: 'bank_transfer',
      methodReference: 'MB-750',
      bankAccountId,
      reason: 'October savings',
    });
    const mine = async () =>
      (await member.memberRequests(fatimah)).find(r => r.id === deposit.id)!;

    expect(await mine()).toMatchObject({
      kind: 'deposit',
      state: 'pending',
      statusLabel: 'Pending approval',
      stage: 'Being verified by the accounts department',
      amount: '750.00',
      methodName: expect.any(String),
      note: 'October savings',
      reason: null,
      completedAt: null,
    });
    // Nobody else's to see.
    expect(
      (await member.memberRequests(stranger)).some(r => r.id === deposit.id)
    ).toBe(false);

    // Only the Account Officer acts at Accounts verification.
    await expect(
      review.reviewTransaction(
        deposit.id,
        { outcome: 'forward', comment: '' },
        president
      )
    ).rejects.toMatchObject({ reason: 'forbidden' });
    expect(
      await review.reviewTransaction(
        deposit.id,
        { outcome: 'forward', comment: 'Seen on the MCB statement.' },
        accountOfficer
      )
    ).toEqual({ status: 'approved' });
    expect(await mine()).toMatchObject({
      state: 'approved',
      statusLabel: 'Approved',
      stage: 'Being recorded by the accounts department',
    });

    await expect(
      review.postApprovedTransaction(deposit.id, accountOfficer)
    ).rejects.toThrowError(/approved/);
    const posted = await review.postApprovedTransaction(
      deposit.id,
      secondAccountOfficer
    );
    expect(posted.status).toBe('posted');
    expect(await mine()).toMatchObject({
      state: 'completed',
      statusLabel: 'Completed',
      stage: null,
      completedAt: expect.any(String),
    });
  });

  it('a withdrawal goes Secretary, President, then the Treasurer pays it out', async () => {
    const { member, review } = await load();
    const withdrawal = await member.recordMemberWithdrawal(fatimah, {
      accountId: fatimahMsa,
      amount: '100',
    });
    const mine = async () =>
      (await member.memberRequests(fatimah)).find(r => r.id === withdrawal.id)!;

    expect(await mine()).toMatchObject({
      kind: 'withdrawal',
      statusLabel: 'Pending approval',
      stage: 'With the Secretary',
      methodName: null,
    });
    await review.reviewTransaction(
      withdrawal.id,
      { outcome: 'forward', comment: '' },
      secretary
    );
    expect((await mine()).stage).toBe('With the President / Chairperson');
    await review.reviewTransaction(
      withdrawal.id,
      { outcome: 'forward', comment: '' },
      president
    );
    expect(await mine()).toMatchObject({
      state: 'approved',
      stage: 'Awaiting disbursement by the Treasurer',
    });
    await review.postApprovedTransaction(withdrawal.id, treasurer, {
      method: 'bank_transfer',
      methodReference: 'PAY-100',
      bankAccountId,
    });
    expect(await mine()).toMatchObject({
      state: 'completed',
      statusLabel: 'Paid out',
    });
  });

  it('a request from the app is rejected with a reason, never returned to nobody', async () => {
    const { member, review } = await load();
    const withdrawal = await member.recordMemberWithdrawal(fatimah, {
      accountId: fatimahMsa,
      amount: '50',
    });
    await expect(
      review.reviewTransaction(
        withdrawal.id,
        { outcome: 'return', comment: 'Which account?' },
        secretary
      )
    ).rejects.toThrowError(/cannot be returned/);
    await review.reviewTransaction(
      withdrawal.id,
      { outcome: 'reject', comment: 'Please call the office first.' },
      secretary
    );
    const mine = (await member.memberRequests(fatimah)).find(
      r => r.id === withdrawal.id
    )!;
    expect(mine).toMatchObject({
      state: 'declined',
      statusLabel: 'Not approved',
      stage: null,
      reason: 'Please call the office first.',
    });

    // A transfer appears once, from the caller's side, naming the other.
    const transfer = await member.recordMemberTransfer(fatimah, {
      sourceAccountId: fatimahMsa,
      destinationAccountId: strangerMsa,
      amount: '25',
    });
    const transfers = (await member.memberRequests(fatimah)).filter(
      r => r.kind === 'transfer'
    );
    expect(transfers.filter(r => r.id === transfer.debitLeg.id)).toEqual([
      expect.objectContaining({
        reference: expect.stringMatching(/^TR-/),
        counterpartAccountNo: expect.any(String),
        state: 'pending',
      }),
    ]);
    expect(
      (await member.memberRequests(stranger)).some(r => r.kind === 'transfer')
    ).toBe(false);
  });
});
