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

// A rule "by Member" for a kind, moved above the seeded bands so it wins.
async function memberRule(
  config: typeof import('../config/reference'),
  kind: 'deposit' | 'withdrawal' | 'transfer'
) {
  const chain = (await config.listWorkflows()).find(
    w => w.code === `transaction_${kind}`
  )!;
  const id = await config.createApprovalRule(
    {
      kind,
      accountTypeId: null,
      initiatingRoleId: memberRoleId,
      amountFrom: '0',
      amountTo: null,
      workflowDefinitionId: chain.id,
      note: 'From the app',
      isActive: true,
    },
    actor
  );
  await config.moveApprovalRule(id, 'up', actor);
  await config.moveApprovalRule(id, 'up', actor);
  return id;
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

  it('records a deposit as the member app in the Member role, on a chain or not at all', async () => {
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
    // The seeded matrix posts Rs 1,000 at once; the app never posts.
    await expect(
      member.recordMemberDeposit(fatimah, deposit)
    ).rejects.toMatchObject({
      code: 'forbidden',
      message:
        'A deposit of this amount cannot be made from the app. Please visit the branch.',
    });
    // A rule "by Member" sends it to the chain, and it is the branch's rule
    // that applies underneath: the bank account and reference are demanded.
    await memberRule(config, 'deposit');
    await expect(
      member.recordMemberDeposit(fatimah, {
        ...deposit,
        bankAccountId: undefined,
      })
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: expect.stringMatching(/bank account/),
    });
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
      current_step_code: expect.any(String),
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
  });

  it("records a withdrawal and a transfer the same way, from the caller's own account only", async () => {
    const { member, config } = await load();
    await expect(
      member.recordMemberWithdrawal(fatimah, {
        accountId: fatimahMsa,
        amount: '300',
        method: 'cash',
      })
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringMatching(/visit the branch/),
    });
    await memberRule(config, 'withdrawal');
    await memberRule(config, 'transfer');

    const withdrawal = await member.recordMemberWithdrawal(fatimah, {
      accountId: fatimahMsa,
      amount: '300',
      method: 'cash',
    });
    expect(withdrawal.status).toBe('submitted');
    expect((await transactionRow(withdrawal.id)).actor_role).toBe('Member');
    // More than the account holds: the ledger's own refusal, as the API
    // says it.
    await expect(
      member.recordMemberWithdrawal(fatimah, {
        accountId: fatimahMsa,
        amount: '1000000',
        method: 'cash',
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      member.recordMemberWithdrawal(stranger, {
        accountId: fatimahMsa,
        amount: '1',
        method: 'cash',
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
