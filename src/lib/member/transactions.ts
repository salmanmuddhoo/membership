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
import type { Principal } from '../access/principal';
import { ApiError } from '../api/envelope';
import {
  enabledMemberOperations,
  paymentMethodByCode,
  type MemberOperation,
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
import type { MemberPrincipal } from './identity';
import { maskMobile } from './otp';
import { ownedAccountId } from './profile';

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

export interface MemberDepositInput {
  accountId: string;
  amount: string;
  method: string;
  methodReference?: string;
  bankAccountId?: string;
  reason?: string;
  idempotencyKey?: string;
}

/** Pay into one of the caller's own accounts. Never cash: nobody took any. */
export async function recordMemberDeposit(
  member: MemberPrincipal,
  input: MemberDepositInput
): Promise<Deposit> {
  await requireEnabled('deposit');
  const accountId = await ownedAccountId(member, input.accountId);
  const method = await paymentMethodByCode(input.method);
  if (method?.isCash) {
    throw new ApiError(
      'validation_failed',
      'Cash cannot be paid in from the app.',
      { method: ['Choose a bank or mobile money method.'] }
    );
  }
  const principal = await actingPrincipal(member);
  return attempt('deposit', () =>
    recordDeposit({ ...input, accountId }, principal)
  );
}

export interface MemberWithdrawalInput {
  accountId: string;
  amount: string;
  // How it is paid out. Optional: it goes for approval, and the Treasurer
  // says how at Disburse (withdrawals.ts's payoutMethod).
  method?: string;
  methodReference?: string;
  bankAccountId?: string;
  reason?: string;
  idempotencyKey?: string;
}

/** Ask for money out of one of the caller's own accounts. */
export async function recordMemberWithdrawal(
  member: MemberPrincipal,
  input: MemberWithdrawalInput
): Promise<Withdrawal> {
  await requireEnabled('withdrawal');
  const accountId = await ownedAccountId(member, input.accountId);
  const principal = await actingPrincipal(member);
  return attempt('withdrawal', () =>
    recordWithdrawal({ ...input, accountId }, principal)
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
 * Move money from one of the caller's own accounts to an account here —
 * another of theirs, or somebody else's. Never to a payee outside: that is
 * a withdrawal in another name, and the branch's to record.
 */
export async function recordMemberTransfer(
  member: MemberPrincipal,
  input: MemberTransferInput
): Promise<Transfer> {
  await requireEnabled('transfer');
  const sourceAccountId = await ownedAccountId(member, input.sourceAccountId);
  const principal = await actingPrincipal(member);
  return attempt('transfer', () =>
    recordTransfer(
      {
        sourceAccountId,
        amount: input.amount,
        destination: { kind: 'account', accountId: input.destinationAccountId },
        reason: input.reason,
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
 * Where each request the caller made from the app stands, newest first:
 * only what the app captured, only from their own accounts, and a
 * transfer once (its debit leg). Fifty is more than a phone shows.
 */
export async function memberRequests(
  member: MemberPrincipal
): Promise<MemberRequest[]> {
  const holderId = member.memberId ?? member.customerId;
  if (!holderId) return [];
  const result = await query<TransactionRow>(
    `${TRANSACTION_SELECT}
      where t.captured_by = $1
        and coalesce(t.member_id, t.customer_id) = $2
        and t.kind in ('deposit', 'withdrawal', 'transfer_leg')
        and (t.leg_direction is null or t.leg_direction = 'debit')
      order by t.created_at desc
      limit 50`,
    [await systemUser(), holderId]
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
