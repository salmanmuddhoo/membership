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
import { DepositError, recordDeposit, type Deposit } from '../ledger/deposits';
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
  method: string;
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
