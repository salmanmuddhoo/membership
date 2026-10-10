// Transactions a member starts from the app (S-2102, FRD 10).
//
// A deposit, a withdrawal or a transfer from the phone is the same
// transaction an officer records at the branch — the same service function,
// the same rules, the same matrix — with two differences, both here.
//
// Who captures it: the member-app system user (applications.ts), acting in
// the Member role (migration 0085) with transaction.capture and nothing
// more. The matrix reads that role, so the Society can route a member's
// own transaction to a chain of its choosing; and because the app never
// holds transaction.post, a route that would post at once is refused —
// a member's transaction goes to a chain or it goes nowhere, and the
// officers on that chain are who decide. Never more lenient than a clerk.
//
// Which may be started at all: member_api.enabled_operations, empty until
// the Society says otherwise. The endpoints exist from day one; they refuse
// until switched on.
//
// On whose account: the caller's own, or a minor's they are the guardian of
// (dependents.ts, accountInReach). A request for a minor is the minor's
// transaction, and its note says which guardian asked.
import type { Principal } from '../access/principal';
import { ApiError } from '../api/envelope';
import {
  enabledMemberOperations,
  memberAppDepositAccount,
  offeredPaymentMethods,
  type MemberOperation,
  type PaymentMethod,
} from '../config/reference';
import { query } from '../db/pool';
import { DepositError, recordDeposit, type Deposit } from '../ledger/deposits';
import {
  assembleTransaction,
  needsDisbursement,
  positionOf,
  TRANSACTION_SELECT,
  type TransactionRow,
  type TransactionSummary,
} from '../ledger/review';
import {
  recordTransfer,
  TransferError,
  type Transfer,
} from '../ledger/transfers';
import {
  recordWithdrawal,
  WithdrawalError,
  type Withdrawal,
} from '../ledger/withdrawals';
import { systemUser } from './applications';
import { accountInReach, wardsOf, type Ward } from './dependents';
import type { MemberPrincipal } from './identity';
import { maskMobile } from './otp';

export const MEMBER_ROLE = 'member';
const SYSTEM_SUBJECT = 'system:member-app';
const PERMISSION_CAPTURE = 'transaction.capture';

const WORDS: Record<MemberOperation, string> = {
  deposit: 'A deposit',
  withdrawal: 'A withdrawal',
  transfer: 'A transfer',
};

/**
 * The principal a member's transaction is recorded by: the system user in
 * the Member role, able to capture and nothing else. Built here and
 * nowhere else.
 */
export async function actingPrincipal(
  member: MemberPrincipal
): Promise<Principal> {
  return {
    userId: await systemUser(),
    entraSubject: SYSTEM_SUBJECT,
    email: `member-app:${maskMobile(member.mobile)}`,
    displayName: 'Member app',
    roles: [MEMBER_ROLE],
    roleNames: ['Member'],
    permissions: new Set([PERMISSION_CAPTURE]),
  };
}

async function requireEnabled(operation: MemberOperation): Promise<void> {
  if (!(await enabledMemberOperations()).includes(operation)) {
    throw new ApiError(
      'forbidden',
      `${WORDS[operation]} cannot be started from the app.`
    );
  }
}

// The one refusal the ledger gives that means something different from the
// phone: "you may capture but not post" is, for the app, "the matrix would
// post this at once, and the app never posts". The member is told where to
// go; the wording about Account Officers is for the office.
function fromLedger(
  error: unknown,
  operation: MemberOperation
): ApiError | null {
  if (!(
    error instanceof DepositError ||
    error instanceof WithdrawalError ||
    error instanceof TransferError
  )) {
    return null;
  }
  if (error.reason === 'forbidden') {
    return new ApiError(
      'forbidden',
      `${WORDS[operation]} of this amount cannot be made from the app. ` +
        'Please visit the branch.'
    );
  }
  return new ApiError(
    error.reason === 'not_found'
      ? 'not_found'
      : error.reason === 'conflict'
        ? 'conflict'
        : 'validation_failed',
    error.message
  );
}

async function attempt<T>(
  operation: MemberOperation,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw fromLedger(error, operation) ?? error;
  }
}

// How a member may say they paid in from the app: by bank transfer or by
// Juice, nothing else (officer direction) — and only while the Society
// still offers that method for deposits.
export const APP_DEPOSIT_METHODS = ['bank_transfer', 'juice'] as const;

export async function appDepositMethods(): Promise<PaymentMethod[]> {
  const offered = await offeredPaymentMethods('deposit');
  return APP_DEPOSIT_METHODS.flatMap(code => {
    const method = offered.find(m => m.code === code && !m.isCash);
    return method ? [method] : [];
  });
}

export interface DepositOptions {
  methods: {
    code: string;
    name: string;
    requiresReference: boolean;
    touchesBank: boolean;
  }[];
  // The one account a member pays into — the one marked at Configuration
  // -> Bank accounts (migration 0121) — with the number to pay to: shown
  // whole, and only to a signed-in member, never on the public reference.
  // A list of at most one, empty until an account is marked.
  bankAccounts: {
    id: string;
    name: string;
    bankName: string;
    accountNumber: string;
  }[];
}

/**
 * What the deposit form offers a member or account holder. An applicant —
 * anyone who has proved a phone number — holds no account to pay into and
 * is not given the Society's account numbers.
 */
export async function depositOptions(
  member: MemberPrincipal
): Promise<DepositOptions> {
  if (!member.memberId && !member.customerId) {
    throw new ApiError('forbidden', 'Only a member can pay in from the app.');
  }
  const [methods, account] = await Promise.all([
    appDepositMethods(),
    memberAppDepositAccount(),
  ]);
  const accounts = account ? [account] : [];
  return {
    methods: methods.map(m => ({
      code: m.code,
      name: m.name,
      requiresReference: m.requiresReference,
      touchesBank: m.touchesBank,
    })),
    bankAccounts: accounts.map(a => ({
      id: a.id,
      name: a.name,
      bankName: a.bankName,
      accountNumber: a.accountNumber,
    })),
  };
}

// The note a request for a minor carries, so the officer deciding it knows
// the guardian asked, and which one.
async function noteFor(
  member: MemberPrincipal,
  ward: Ward | null,
  note: string | undefined
): Promise<string | undefined> {
  const own = (note ?? '').trim();
  if (!ward) return own || undefined;
  const guardian = await query<{ member_no: string | null }>(
    `select member_no from member where id = $1`,
    [member.memberId]
  );
  const who = guardian.rows[0]?.member_no ?? 'their guardian';
  const asked = `Requested in the app by the guardian, ${who}.`;
  return own ? `${asked} ${own}` : asked;
}

export interface MemberDepositInput {
  accountId: string;
  amount: string;
  method: string;
  methodReference?: string;
  bankAccountId?: string;
  reason?: string;
  idempotencyKey?: string;
}

/**
 * Pay into one of the caller's accounts, or a minor's in their care. By
 * bank transfer or Juice only: never cash, nobody took any.
 */
export async function recordMemberDeposit(
  member: MemberPrincipal,
  input: MemberDepositInput
): Promise<Deposit> {
  await requireEnabled('deposit');
  const { accountId, ward } = await accountInReach(member, input.accountId);
  const methods = await appDepositMethods();
  if (!methods.some(m => m.code === input.method)) {
    const names = methods.map(m => m.name).join(' or ') || 'a branch';
    throw new ApiError(
      'validation_failed',
      'That way of paying cannot be used from the app.',
      { method: [`Choose ${names}.`] }
    );
  }
  // Paid into the one account members are shown, whatever else is named:
  // there is no other for them to have paid into.
  const payInto = await memberAppDepositAccount();
  if (!payInto) {
    throw new ApiError(
      'forbidden',
      'Deposits from the app are not available yet. Please visit the branch.'
    );
  }
  if (input.bankAccountId && input.bankAccountId !== payInto.id) {
    throw new ApiError(
      'validation_failed',
      'Pay into the account shown in the app.',
      { bankAccountId: [`Pay into ${payInto.accountNumber}.`] }
    );
  }
  const reason = await noteFor(member, ward, input.reason);
  const principal = await actingPrincipal(member);
  return attempt('deposit', () =>
    recordDeposit(
      { ...input, accountId, reason, bankAccountId: payInto.id },
      principal
    )
  );
}

// How a member may ask to receive a withdrawal: by bank transfer to their
// own account, or by cheque (officer direction), while the Society offers
// that method for withdrawals.
export const APP_PAYOUT_METHODS = ['bank_transfer', 'cheque'] as const;

export async function appPayoutMethods(): Promise<PaymentMethod[]> {
  const offered = await offeredPaymentMethods('withdrawal');
  return APP_PAYOUT_METHODS.flatMap(code => {
    const method = offered.find(m => m.code === code);
    return method ? [method] : [];
  });
}

export interface MemberWithdrawalInput {
  accountId: string;
  amount: string;
  // How the member asks to receive it: bank_transfer or cheque. The
  // Treasurer sees it and pays that way at Disburse, recording the
  // reference then. Absent (an app from before the choice): the Treasurer
  // decides, as for any withdrawal that goes for approval.
  method?: string;
  // For a bank transfer: the member's own bank and account number, which
  // the Treasurer pays into. Written on the request's note.
  payToBank?: string;
  payToAccountNumber?: string;
  reason?: string;
  idempotencyKey?: string;
}

// The member's payout choice, checked, and the line the Treasurer reads.
async function payoutChoice(
  input: MemberWithdrawalInput
): Promise<{ method: string | undefined; line: string | null }> {
  const code = (input.method ?? '').trim();
  if (!code) return { method: undefined, line: null };
  const methods = await appPayoutMethods();
  const method = methods.find(m => m.code === code);
  if (!method) {
    const names = methods.map(m => m.name).join(' or ') || 'a branch';
    throw new ApiError(
      'validation_failed',
      'That way of being paid cannot be chosen from the app.',
      { method: [`Choose ${names}.`] }
    );
  }
  if (code !== 'bank_transfer') {
    return {
      method: code,
      line: `To be paid by ${method.name.toLowerCase()}.`,
    };
  }
  const bank = (input.payToBank ?? '').trim();
  const number = (input.payToAccountNumber ?? '').trim();
  const details: Record<string, string[]> = {};
  if (!bank) details.payToBank = ['Enter the name of your bank.'];
  if (!/^[A-Za-z0-9 -]{4,40}$/.test(number)) {
    details.payToAccountNumber = [
      'Enter your account number: letters, digits, spaces and dashes.',
    ];
  }
  if (Object.keys(details).length > 0) {
    throw new ApiError(
      'validation_failed',
      'Say where the money should be sent.',
      details
    );
  }
  return {
    method: code,
    line: `To be paid by bank transfer to ${bank}, account ${number}.`,
  };
}

/**
 * Ask for money out of one of the caller's accounts, or a minor's, paid by
 * the bank transfer or cheque they choose.
 */
export async function recordMemberWithdrawal(
  member: MemberPrincipal,
  input: MemberWithdrawalInput
): Promise<Withdrawal> {
  await requireEnabled('withdrawal');
  const { accountId, ward } = await accountInReach(member, input.accountId);
  const payout = await payoutChoice(input);
  const note = [payout.line, (input.reason ?? '').trim()]
    .filter(Boolean)
    .join(' ');
  const reason = await noteFor(member, ward, note);
  const principal = await actingPrincipal(member);
  return attempt('withdrawal', () =>
    recordWithdrawal(
      {
        accountId,
        amount: input.amount,
        method: payout.method,
        reason,
        idempotencyKey: input.idempotencyKey,
      },
      principal
    )
  );
}

export interface MemberTransferInput {
  sourceAccountId: string;
  destinationAccountId: string;
  amount: string;
  reason?: string;
  idempotencyKey?: string;
}

/**
 * Move money from one of the caller's accounts, or a minor's in their care,
 * to an account here — another of theirs, or somebody else's. Never to a
 * payee outside: that is a withdrawal in another name, and the branch's to
 * record.
 */
export async function recordMemberTransfer(
  member: MemberPrincipal,
  input: MemberTransferInput
): Promise<Transfer> {
  await requireEnabled('transfer');
  const { accountId: sourceAccountId, ward } = await accountInReach(
    member,
    input.sourceAccountId
  );
  const reason = await noteFor(member, ward, input.reason);
  const principal = await actingPrincipal(member);
  return attempt('transfer', () =>
    recordTransfer(
      {
        sourceAccountId,
        amount: input.amount,
        destination: { kind: 'account', accountId: input.destinationAccountId },
        reason,
        idempotencyKey: input.idempotencyKey,
      },
      principal
    )
  );
}

// --- What the member asked for, and where it stands -------------------------

export type MemberRequestKind = 'deposit' | 'withdrawal' | 'transfer';

// The member's words for a transaction's status. Every request from the app
// is validated by officers first (migration 0120), so until a decision it
// is simply "Pending approval"; the stage says who has it.
export type MemberRequestState =
  'pending' | 'approved' | 'completed' | 'declined' | 'returned' | 'cancelled';

export interface MemberRequest {
  id: string;
  // What the office quotes: a transfer's TR reference, otherwise the TX.
  reference: string;
  kind: MemberRequestKind;
  state: MemberRequestState;
  statusLabel: string;
  // Who has it, or what happens next; null once it is finished.
  stage: string | null;
  amount: string;
  currency: string;
  accountId: string;
  accountNo: string;
  accountTypeName: string;
  // A transfer's other side.
  counterpartAccountNo: string | null;
  counterpartAccountTypeName: string | null;
  // How a deposit was paid; null on the others.
  methodName: string | null;
  // The minor it was asked for, by name, when it is on a minor's account
  // in the caller's care; null on the caller's own.
  forMinor: string | null;
  // The member's own note.
  note: string;
  // Why it was not approved, as the officer wrote it.
  reason: string | null;
  createdAt: string;
  completedAt: string | null;
}

const KIND_OF: Record<string, MemberRequestKind> = {
  deposit: 'deposit',
  withdrawal: 'withdrawal',
  transfer_leg: 'transfer',
};

async function stageWhilePending(t: TransactionSummary): Promise<string> {
  const position = await positionOf(t);
  if (!position) return 'Waiting for approval';
  if (position.step.code === 'accounts_verification') {
    return 'Being verified by the accounts department';
  }
  return `With the ${position.step.roleName}`;
}

/**
 * Where each request made from the app stands, newest first: only what the
 * app captured, only on the caller's own accounts and those of the minors
 * in their care, and a transfer once (its debit leg). Fifty is more than a
 * phone shows.
 */
export async function memberRequests(
  member: MemberPrincipal
): Promise<MemberRequest[]> {
  const holderId = member.memberId ?? member.customerId;
  if (!holderId) return [];
  const wards = await wardsOf(member);
  const result = await query<TransactionRow>(
    `${TRANSACTION_SELECT}
      where t.captured_by = $1
        and coalesce(t.member_id, t.customer_id) = any($2::uuid[])
        and t.kind in ('deposit', 'withdrawal', 'transfer_leg')
        and (t.leg_direction is null or t.leg_direction = 'debit')
      order by t.created_at desc
      limit 50`,
    [await systemUser(), [holderId, ...wards.map(w => w.id)]]
  );
  const transactions = result.rows.map(assembleTransaction);
  const ids = transactions.map(t => t.id);
  const reasons = new Map<string, string>();
  if (ids.length > 0) {
    const comments = await query<{ transaction_id: string; comment: string }>(
      `select distinct on (transaction_id) transaction_id, comment
         from transaction_transition
        where transaction_id = any($1::uuid[])
          and to_status in ('rejected', 'returned')
          and comment is not null
        order by transaction_id, id desc`,
      [ids]
    );
    for (const row of comments.rows) {
      reasons.set(row.transaction_id, row.comment);
    }
  }

  const requests: MemberRequest[] = [];
  for (const t of transactions) {
    const kind = KIND_OF[t.kind];
    if (!kind) continue;
    let state: MemberRequestState;
    let statusLabel: string;
    let stage: string | null = null;
    switch (t.status) {
      case 'submitted':
      case 'under_review':
        state = 'pending';
        statusLabel = 'Pending approval';
        stage = await stageWhilePending(t);
        break;
      case 'approved':
        state = 'approved';
        statusLabel = 'Approved';
        stage = needsDisbursement(t)
          ? 'Awaiting disbursement by the Treasurer'
          : 'Being recorded by the accounts department';
        break;
      case 'posted':
        state = 'completed';
        statusLabel = kind === 'withdrawal' ? 'Paid out' : 'Completed';
        break;
      case 'rejected':
        state = 'declined';
        statusLabel = 'Not approved';
        break;
      case 'returned':
        state = 'returned';
        statusLabel = 'Returned';
        stage = 'Please contact the office';
        break;
      case 'cancelled':
        state = 'cancelled';
        statusLabel = 'Cancelled';
        break;
      default:
        continue;
    }
    requests.push({
      id: t.id,
      reference: t.displayReference,
      kind,
      state,
      statusLabel,
      stage,
      amount: t.amount,
      currency: t.currency,
      accountId: t.accountId,
      accountNo: t.accountNo,
      accountTypeName: t.accountTypeName,
      counterpartAccountNo: kind === 'transfer' ? t.counterpartAccountNo : null,
      counterpartAccountTypeName:
        kind === 'transfer' ? t.counterpartAccountTypeName : null,
      methodName: kind === 'deposit' ? t.methodName : null,
      forMinor: wards.find(w => w.id === t.holderId)?.name ?? null,
      note: t.reason,
      reason:
        state === 'declined' || state === 'returned'
          ? (reasons.get(t.id) ?? null)
          : null,
      createdAt: t.createdAt.toISOString(),
      completedAt: t.postedAt?.toISOString() ?? null,
    });
  }
  return requests;
}
