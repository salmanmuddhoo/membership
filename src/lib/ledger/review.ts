// Acting on a transaction that waits on its chain (S-1403, S-1404, S-1406).
// Schema: migrations/0070, 0071; docs/ledger.md.
//
// One queue and one set of actions for every kind: what waits on a person
// is derived from the live chain — the step a transaction sits at, read
// against the steps that are enabled now — so a step an administrator
// disables under a queued item moves that item on to the next one, with
// no code change (S-1402). Review steps forward or return; the last step
// approves or rejects; posting an approved transaction is a separate act
// by whoever moves the money (S-1503).
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { checkSegregation } from '../admin/segregation';
import {
  activeChain,
  listWorkflows,
  type WorkflowStep,
} from '../config/reference';
import { query, withTransaction } from '../db/pool';
import {
  abandonReceiptNumber,
  allocateReceiptNumber,
  markReceiptIssued,
} from '../payments/receipts';
import { requireBankAccount, resolveBankAccount } from './bank-accounts';
import { LedgerError, postTransaction } from './ledger';
import { notifyReceiptIssued } from './receipt-notifications';
import { notifyExit } from './exit-notifications';
import { notifyPosted, notifyReviewed } from './transaction-notifications';
import type {
  PaymentMethod,
  TransactionKind,
  TransactionRowKind,
} from '../config/reference';
import { offeredMethod, PaymentError } from '../payments/payments';

export const PERMISSION_REVIEW = 'transaction.review';
export const PERMISSION_APPROVE = 'transaction.approve';
export const PERMISSION_POST = 'transaction.post';
// Disbursement is the Treasurer's (officer direction, migration 0095):
// paying out what the chain approved — a withdrawal, a transfer to a
// payee, a closure, a resignation, a claim — is transaction.disburse; an
// approved deposit (money in) posts under transaction.post as before.
export const PERMISSION_DISBURSE = 'transaction.disburse';

/** The permission the act after approval needs, for this transaction. */
export function permissionToPost(
  transaction: Pick<TransactionSummary, 'kind' | 'payeeName'>
): string {
  return needsDisbursement(transaction) ? PERMISSION_DISBURSE : PERMISSION_POST;
}
export const PERMISSION_VIEW = 'transaction.view';

// Audit actions. The segregation rules (0069, 0071) key on 'reviewed',
// 'approved' and 'posted' against the 'transaction.captured' row.
export const ACTION_REVIEWED = 'transaction.reviewed';
export const ACTION_APPROVED = 'transaction.approved';
export const ACTION_RETURNED = 'transaction.returned';
export const ACTION_REJECTED = 'transaction.rejected';
export const ACTION_POSTED = 'transaction.posted';

// Statuses at which a transaction sits at a step of its chain.
export const IN_FLIGHT = ['submitted', 'under_review'] as const;

export class ReviewError extends Error {
  constructor(
    message: string,
    public readonly reason:
      'invalid' | 'forbidden' | 'not_found' | 'conflict' = 'invalid'
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

export interface TransactionSummary {
  id: string;
  reference: string;
  kind: TransactionRowKind;
  status: string;
  amount: string;
  currency: string;
  method: string;
  methodName: string;
  methodReference: string;
  reason: string;
  accountId: string;
  accountNo: string;
  accountTypeId: string;
  accountTypeName: string;
  holderId: string;
  holderKind: 'member' | 'customer';
  holderName: string;
  memberNo: string | null;
  capturedById: string;
  capturedByName: string;
  createdAt: Date;
  submittedAt: Date | null;
  postedAt: Date | null;
  receiptNo: string | null;
  // What the account stood at once this posted; null until then.
  balanceAfter: string | null;
  workflowDefinitionId: string | null;
  workflowCode: string | null;
  workflowName: string | null;
  currentStepCode: string | null;
  // The step it was left at, named — the chain as it is now may say
  // otherwise (positionOf).
  currentStepName: string | null;
  currentStepRole: string | null;
  approvalRuleId: string | null;
  sourceOfFundFormConfirmed: boolean;
  // A transfer's leg (S-1504): which transfer, which side, and the other
  // side — an account on the system, or a payee with none.
  transferId: string | null;
  transferReference: string | null;
  // What staff see and quote: a transfer's own TR reference on either leg,
  // otherwise the transaction's (QA-11). `reference` stays the leg's TX —
  // the audit trail and the segregation checks are keyed on it.
  displayReference: string;
  legDirection: 'credit' | 'debit' | null;
  payeeName: string | null;
  counterpartAccountId: string | null;
  counterpartAccountNo: string | null;
  counterpartAccountTypeName: string | null;
  counterpartHolderId: string | null;
  counterpartHolderName: string | null;
  // A demised claim (S-1704): who is paid, and the benefit beside the
  // balances. Null on every other kind.
  claimantKind: 'nominee' | 'other' | null;
  claimant: Claimant | null;
  takafulBenefit: string;
  // Which of the Society's bank accounts the money reached or left
  // (S-1901); null where none was named, or the method never touches one.
  bankAccountId: string | null;
  bankAccountName: string | null;
}

export interface Claimant {
  name: string;
  nic: string;
  address: string;
  relation: string;
  // Where the claimant is written to (S-1705): the nominee's as captured
  // on the application, or as the officer recorded them. Absent means no
  // address of that kind.
  email?: string | null;
  mobile?: string | null;
}

// Exported for the listings (history.ts) that read the same shape.
export const TRANSACTION_SELECT = `
  select t.id, t.reference, t.kind, t.status, t.amount, t.currency,
         t.method, pm.name as method_name,
         coalesce(t.method_reference, '') as method_reference,
         coalesce(t.reason, '') as reason,
         t.account_id, coalesce(a.account_no, m.member_no) as account_no,
         a.account_type_id, at.name as account_type_name,
         coalesce(t.member_id, t.customer_id) as holder_id,
         case when t.member_id is not null then 'member' else 'customer' end
           as holder_kind,
         trim(coalesce(p.values->>'name', '') || ' '
              || coalesce(p.values->>'surname', '')) as holder_name,
         m.member_no,
         t.captured_by, u.display_name as captured_by_name,
         t.created_at, t.submitted_at, t.posted_at, rn.receipt_no,
         fe.payload->>'balance_after' as balance_after,
         t.workflow_definition_id, wd.code as workflow_code,
         wd.name as workflow_name, t.current_step_code,
         ws.name as current_step_name, wr.name as current_step_role,
         t.approval_rule_id, t.source_of_fund_form_confirmed,
         t.transfer_id, tr.reference as transfer_reference, t.leg_direction,
         t.payee_name, t.claimant_kind, t.claimant, t.takaful_benefit,
         t.bank_account_id, ba.name as bank_account_name,
         l.account_id as counterpart_account_id,
         coalesce(la.account_no, lm.member_no) as counterpart_account_no,
         lt.name as counterpart_account_type_name,
         coalesce(l.member_id, l.customer_id) as counterpart_holder_id,
         trim(coalesce(lp.values->>'name', '') || ' '
              || coalesce(lp.values->>'surname', '')) as counterpart_holder_name
    from transaction t
    join account a on a.id = t.account_id
    join account_type at on at.id = a.account_type_id
    join payment_method pm on pm.code = t.method
    join app_user u on u.id = t.captured_by
    left join member m on m.id = t.member_id
    left join customer c on c.id = t.customer_id
    left join application_party p
      on p.application_id = coalesce(m.application_id, c.application_id)
     and p.subject = 'applicant' and p.ordinal = 1
    left join receipt_number rn on rn.id = t.receipt_number_id
    left join financial_event fe
      on fe.transaction_id = t.id and fe.event_type = 'transaction.posted'
    left join workflow_definition wd on wd.id = t.workflow_definition_id
    left join workflow_step ws
      on ws.definition_id = wd.id and ws.code = t.current_step_code
    left join role wr on wr.id = ws.role_id
    left join transfer tr on tr.id = t.transfer_id
    left join bank_account ba on ba.id = t.bank_account_id
    left join transaction l on l.transfer_id = t.transfer_id and l.id <> t.id
    left join account la on la.id = l.account_id
    left join account_type lt on lt.id = la.account_type_id
    left join member lm on lm.id = l.member_id
    left join customer lc on lc.id = l.customer_id
    left join application_party lp
      on lp.application_id = coalesce(lm.application_id, lc.application_id)
     and lp.subject = 'applicant' and lp.ordinal = 1
`;

export interface TransactionRow {
  id: string;
  reference: string;
  kind: TransactionRowKind;
  status: string;
  amount: string;
  currency: string;
  method: string;
  method_name: string;
  method_reference: string;
  reason: string;
  account_id: string;
  account_no: string;
  account_type_id: string;
  account_type_name: string;
  holder_id: string;
  holder_kind: 'member' | 'customer';
  holder_name: string;
  member_no: string | null;
  captured_by: string;
  captured_by_name: string;
  created_at: Date;
  submitted_at: Date | null;
  posted_at: Date | null;
  receipt_no: string | null;
  balance_after: string | null;
  workflow_definition_id: string | null;
  workflow_code: string | null;
  workflow_name: string | null;
  current_step_code: string | null;
  current_step_name: string | null;
  current_step_role: string | null;
  approval_rule_id: string | null;
  source_of_fund_form_confirmed: boolean;
  transfer_id: string | null;
  transfer_reference: string | null;
  leg_direction: 'credit' | 'debit' | null;
  payee_name: string | null;
  claimant_kind: 'nominee' | 'other' | null;
  claimant: Claimant | null;
  takaful_benefit: string;
  bank_account_id: string | null;
  bank_account_name: string | null;
  counterpart_account_id: string | null;
  counterpart_account_no: string | null;
  counterpart_account_type_name: string | null;
  counterpart_holder_id: string | null;
  counterpart_holder_name: string | null;
}

export function assembleTransaction(r: TransactionRow): TransactionSummary {
  return {
    id: r.id,
    reference: r.reference,
    kind: r.kind,
    status: r.status,
    amount: r.amount,
    currency: r.currency,
    method: r.method,
    methodName: r.method_name,
    methodReference: r.method_reference,
    reason: r.reason,
    accountId: r.account_id,
    accountNo: r.account_no,
    accountTypeId: r.account_type_id,
    accountTypeName: r.account_type_name,
    holderId: r.holder_id,
    holderKind: r.holder_kind,
    holderName: r.holder_name,
    memberNo: r.member_no,
    capturedById: r.captured_by,
    capturedByName: r.captured_by_name,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
    postedAt: r.posted_at,
    receiptNo: r.receipt_no,
    balanceAfter: r.balance_after,
    workflowDefinitionId: r.workflow_definition_id,
    workflowCode: r.workflow_code,
    workflowName: r.workflow_name,
    currentStepCode: r.current_step_code,
    currentStepName: r.current_step_name,
    currentStepRole: r.current_step_role,
    approvalRuleId: r.approval_rule_id,
    sourceOfFundFormConfirmed: r.source_of_fund_form_confirmed,
    transferId: r.transfer_id,
    transferReference: r.transfer_reference,
    displayReference: r.transfer_reference ?? r.reference,
    legDirection: r.leg_direction,
    payeeName: r.payee_name,
    counterpartAccountId: r.counterpart_account_id,
    counterpartAccountNo: r.counterpart_account_no,
    counterpartAccountTypeName: r.counterpart_account_type_name,
    counterpartHolderId: r.counterpart_holder_id,
    counterpartHolderName: r.counterpart_holder_name,
    claimantKind: r.claimant_kind,
    claimant: r.claimant,
    takafulBenefit: r.takaful_benefit,
    bankAccountId: r.bank_account_id,
    bankAccountName: r.bank_account_name,
  };
}

export async function loadTransaction(
  id: string
): Promise<TransactionSummary | null> {
  const result = await query<TransactionRow>(
    `${TRANSACTION_SELECT} where t.id = $1`,
    [id]
  );
  const row = result.rows[0];
  return row ? assembleTransaction(row) : null;
}

// By its reference (TX-000123), which is what the audit log and a receipt
// carry (S-1406) — or a transfer's (TR-000001), which is what staff see on
// it and quote (QA-11): that finds its debit leg, where a transfer is
// reviewed and posted from.
export async function loadTransactionByReference(
  reference: string
): Promise<TransactionSummary | null> {
  const result = await query<TransactionRow>(
    `${TRANSACTION_SELECT}
      where t.reference = $1
         or (tr.reference = $1 and t.leg_direction = 'debit')`,
    [reference.trim().toUpperCase()]
  );
  const row = result.rows[0];
  return row ? assembleTransaction(row) : null;
}

// Where on its chain a transaction stands, read against the chain as it is
// now. The step it was left at may since have been disabled: then it stands
// at the next enabled one (S-1402's in-flight rule), and null means no
// enabled step remains — nothing can act until an administrator enables
// one.
export interface Position {
  step: WorkflowStep;
  isLast: boolean;
  next: WorkflowStep | null;
  // What acting here needs: the last step decides, the others review.
  permission: string;
}

export async function positionOf(
  transaction: Pick<TransactionSummary, 'workflowCode' | 'currentStepCode'>
): Promise<Position | null> {
  if (!transaction.workflowCode || !transaction.currentStepCode) return null;
  const definition = (await listWorkflows()).find(
    w => w.code === transaction.workflowCode
  );
  if (!definition) return null;
  const left = definition.steps.find(
    s => s.code === transaction.currentStepCode
  );
  if (!left) return null;
  const chain = await activeChain(definition.code);
  const index = chain.findIndex(s => s.stepNo >= left.stepNo);
  if (index < 0) return null;
  const isLast = index === chain.length - 1;
  return {
    step: chain[index],
    isLast,
    next: chain[index + 1] ?? null,
    permission: isLast ? PERMISSION_APPROVE : PERMISSION_REVIEW,
  };
}

export function mayActAt(position: Position, principal: Principal): boolean {
  return (
    principal.permissions.has(position.permission) &&
    principal.roles.includes(position.step.roleCode)
  );
}

export interface PendingTransaction extends TransactionSummary {
  stepCode: string;
  stepName: string;
  stepRole: string;
  isLastStep: boolean;
  // When it arrived at this step.
  waitingSince: Date;
}

async function inFlight(
  kind?: TransactionKind
): Promise<(TransactionSummary & { waitingSince: Date })[]> {
  const params: unknown[] = [[...IN_FLIGHT]];
  let filter = '';
  if (kind) {
    params.push(kind);
    filter = ` and t.kind = $${params.length}`;
  }
  const result = await query<TransactionRow & { waiting_since: Date }>(
    `${TRANSACTION_SELECT}
      where t.workflow_definition_id is not null
        and t.current_step_code is not null
        and t.status = any($1::text[])
        and t.leg_direction is distinct from 'credit'${filter}
      order by t.submitted_at, t.serial_no`,
    params
  );
  return Promise.all(
    result.rows.map(async row => ({
      ...assembleTransaction(row),
      waitingSince: await arrivedAt(row.id, row.submitted_at ?? row.created_at),
    }))
  );
}

async function arrivedAt(transactionId: string, fallback: Date): Promise<Date> {
  const result = await query<{ occurred_at: Date }>(
    `select occurred_at from transaction_transition
      where transaction_id = $1
      order by id desc limit 1`,
    [transactionId]
  );
  return result.rows[0]?.occurred_at ?? fallback;
}

/**
 * S-1403 · Everything at a step this person's role owns, any kind, oldest
 * first. Derived from the live chain, so a step disabled under a queued
 * transaction moves it into the next role's queue and out of this one.
 */
export async function pendingTransactions(
  principal: Principal,
  filter: { kind?: TransactionKind } = {}
): Promise<PendingTransaction[]> {
  const rows = await inFlight(filter.kind);
  const pending: PendingTransaction[] = [];
  for (const row of rows) {
    const position = await positionOf(row);
    if (!position || !mayActAt(position, principal)) continue;
    pending.push({
      ...row,
      stepCode: position.step.code,
      stepName: position.step.name,
      stepRole: position.step.roleName,
      isLastStep: position.isLast,
    });
  }
  return pending;
}

/**
 * S-1404 · What came back to this officer to correct: their own captures a
 * reviewer returned. Nobody else's queue — a returned transaction is
 * editable by its captor alone.
 */
export async function returnedTransactions(
  principal: Principal
): Promise<(TransactionSummary & { waitingSince: Date })[]> {
  const result = await query<TransactionRow>(
    `${TRANSACTION_SELECT}
      where t.status = 'returned' and t.captured_by = $1
        and t.leg_direction is distinct from 'credit'
      order by t.submitted_at, t.serial_no`,
    [principal.userId]
  );
  return Promise.all(
    result.rows.map(async row => ({
      ...assembleTransaction(row),
      waitingSince: await arrivedAt(row.id, row.submitted_at ?? row.created_at),
    }))
  );
}

/**
 * S-1403 · Approved and waiting for the money to move: what someone with
 * transaction.post sees on the queue. Approval decides, posting moves
 * money, and the two are not the same click.
 */
export async function approvedTransactions(
  principal: Principal,
  filter: { kind?: TransactionKind } = {}
): Promise<(TransactionSummary & { waitingSince: Date })[]> {
  if (
    !principal.permissions.has(PERMISSION_POST) &&
    !principal.permissions.has(PERMISSION_DISBURSE)
  ) {
    return [];
  }
  const params: unknown[] = [];
  let kindFilter = '';
  if (filter.kind) {
    params.push(filter.kind);
    kindFilter = ` and t.kind = $${params.length}`;
  }
  const result = await query<TransactionRow>(
    `${TRANSACTION_SELECT}
      where t.status = 'approved'
        and t.leg_direction is distinct from 'credit'${kindFilter}
      order by t.submitted_at, t.serial_no`,
    params
  );
  // Only the ones this person may pay out or post: the Treasurer sees the
  // withdrawals and the exits, an Account Officer the deposits.
  const mine = result.rows.filter(row =>
    principal.permissions.has(permissionToPost(assembleTransaction(row)))
  );
  return Promise.all(
    mine.map(async row => ({
      ...assembleTransaction(row),
      waitingSince: await arrivedAt(row.id, row.submitted_at ?? row.created_at),
    }))
  );
}

// The "Transactions" badge: what waits on this person — at a step their
// role owns, approved for them to post, or returned to them to correct.
export async function pendingTransactionCount(
  principal: Principal
): Promise<number> {
  const [pending, approved, returned] = await Promise.all([
    principal.permissions.has(PERMISSION_REVIEW) ||
    principal.permissions.has(PERMISSION_APPROVE)
      ? pendingTransactions(principal)
      : [],
    approvedTransactions(principal),
    returnedTransactions(principal),
  ]);
  return pending.length + approved.length + returned.length;
}

export interface Decision {
  outcome: 'forward' | 'return' | 'reject';
  comment: string;
}

async function refuseUnlessSegregated(
  principal: Principal,
  reference: string,
  action: string
): Promise<void> {
  const verdict = await checkSegregation(
    principal.userId,
    'transaction',
    reference,
    action
  );
  if (!verdict.allowed) {
    throw new ReviewError(
      verdict.conflict?.description ??
        'You may not act on a transaction you captured.',
      'forbidden'
    );
  }
}

/**
 * S-1403 · Act at the step a transaction stands at. Forward moves it to the
 * next enabled step, or to `approved` from the last one; return sends it
 * back to its captor, keeping the step so a correction re-enters here
 * (S-1404); reject ends it. The comment is mandatory on the last two, and
 * the check is here rather than in the page so no other caller skips it.
 */
export async function reviewTransaction(
  id: string,
  decision: Decision,
  principal: Principal
): Promise<{ status: string }> {
  const transaction = await loadTransaction(id);
  if (!transaction) {
    throw new ReviewError('That transaction no longer exists.', 'not_found');
  }
  if (!(IN_FLIGHT as readonly string[]).includes(transaction.status)) {
    throw new ReviewError(
      `${transaction.reference} is ${transaction.status}; nothing is waiting on it.`,
      'conflict'
    );
  }
  const position = await positionOf(transaction);
  if (!position) {
    throw new ReviewError(
      'No enabled step remains on this chain. Ask an administrator to enable one.',
      'conflict'
    );
  }
  if (!principal.permissions.has(position.permission)) {
    throw new ReviewError(
      'You do not have permission to act on this step.',
      'forbidden'
    );
  }
  if (!principal.roles.includes(position.step.roleCode)) {
    throw new ReviewError(
      `${position.step.name} is the ${position.step.roleName}'s step.`,
      'forbidden'
    );
  }
  const comment = decision.comment.trim();
  if (decision.outcome !== 'forward' && comment === '') {
    throw new ReviewError(
      decision.outcome === 'return'
        ? 'Say what needs correcting before returning it.'
        : 'Say why before rejecting it.'
    );
  }
  await refuseUnlessSegregated(
    principal,
    transaction.reference,
    position.isLast ? ACTION_APPROVED : ACTION_REVIEWED
  );

  let status: string;
  let nextStep: string | null;
  let action: string;
  switch (decision.outcome) {
    case 'forward':
      status = position.isLast ? 'approved' : position.step.toStatus;
      nextStep = position.next?.code ?? null;
      action = position.isLast ? ACTION_APPROVED : ACTION_REVIEWED;
      break;
    case 'return':
      status = 'returned';
      nextStep = position.step.code;
      action = ACTION_RETURNED;
      break;
    case 'reject':
      status = 'rejected';
      nextStep = null;
      action = ACTION_REJECTED;
      break;
  }

  await withTransaction(async client => {
    await client.query(
      `update transaction set status = $2, current_step_code = $3 where id = $1`,
      [transaction.id, status, nextStep]
    );
    // A closure refused is an account kept (S-1702): it was closing for
    // this request and for nothing else.
    if (transaction.kind === 'closure' && status === 'rejected') {
      await client.query(
        `update account set status = 'active'
          where id = $1 and status = 'closing'`,
        [transaction.accountId]
      );
    }
    // A claim refused leaves the accounts as they were (S-1704).
    if (transaction.kind === 'demise' && status === 'rejected') {
      await client.query(
        `update account set status = 'active'
          where member_id = $1 and status = 'closing'`,
        [transaction.holderId]
      );
    }
    // A resignation refused is a membership kept (S-1703): every core
    // account was closing for this request and for nothing else.
    if (transaction.kind === 'resignation' && status === 'rejected') {
      await client.query(
        `update account a set status = 'active'
           from account_type at
          where at.id = a.account_type_id and at.is_membership_default
            and a.member_id = $1 and a.status = 'closing'`,
        [transaction.holderId]
      );
    }
    // A transfer's other leg goes with it (S-1504): a rejection ends both,
    // and the transfer row reads whatever the debit leg reads.
    if (transaction.transferId) {
      if (status === 'rejected') {
        await client.query(
          `update transaction set status = 'rejected'
            where transfer_id = $1 and id <> $2 and status <> 'posted'`,
          [transaction.transferId, transaction.id]
        );
      }
      await client.query(`update transfer set status = $2 where id = $1`, [
        transaction.transferId,
        status,
      ]);
    }
    await client.query(
      `insert into transaction_transition
         (transaction_id, from_status, to_status, step_code, actor_user_id,
          actor_role, comment, approval_rule_id, workflow_definition_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        transaction.id,
        transaction.status,
        status,
        position.step.code,
        principal.userId,
        position.step.roleName,
        comment || null,
        transaction.approvalRuleId,
        transaction.workflowDefinitionId,
      ]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action,
        entityType: 'transaction',
        entityId: transaction.reference,
        previousValue: { status: transaction.status },
        newValue: {
          status,
          outcome: decision.outcome,
          step: position.step.code,
          comment: comment || null,
        },
      },
      client
    );
  });
  // An exit's stages are told to its member or claimant (S-1705): forwarded
  // to a further step, or refused with the reason. Approval on its own is
  // not: the payout is what they hear about, at posting.
  if (status === 'rejected') {
    await notifyExit(transaction, 'rejected', { comment });
  } else if (status === 'under_review') {
    await notifyExit(transaction, 'under_review', { comment });
  }
  // The next step's role, the captor it came back to, or a withdrawal's
  // member (S-1803, S-1804).
  await notifyReviewed(transaction, {
    outcome: decision.outcome,
    comment,
    by: principal,
    next: decision.outcome === 'forward' ? position.next : null,
  });
  return { status };
}

// S-1503: how an approved withdrawal was paid out. The reference is
// mandatory where the method requires one and where it touches the
// Society's bank (S-1307); from M19 it names which bank account.
export interface Disbursement {
  method: string;
  methodReference?: string;
  // The Society's bank account it was paid from (S-1901).
  bankAccountId?: string;
}

// Money leaving the Society needs to say how it left; money arriving, or
// moving between two accounts here, already said.
export function needsDisbursement(
  transaction: Pick<TransactionSummary, 'kind' | 'payeeName'>
): boolean {
  return (
    transaction.kind === 'withdrawal' ||
    transaction.kind === 'closure' ||
    transaction.kind === 'resignation' ||
    transaction.kind === 'demise' ||
    (transaction.kind === 'transfer_leg' && transaction.payeeName !== null)
  );
}

export function requireDisbursementReference(
  method: PaymentMethod,
  reference: string | undefined
): void {
  if (
    (method.requiresReference || method.touchesBank) &&
    (reference ?? '').trim() === ''
  ) {
    throw new ReviewError(`Enter the ${method.name.toLowerCase()} reference.`);
  }
}

/**
 * S-1403, S-1503 · Post an approved transaction: the act that moves the
 * money, by whoever holds transaction.post and neither captured nor
 * approved it. A withdrawal is disbursed here — the method and reference
 * it was actually paid by are recorded first, and the entry is dated the
 * disbursement, not the decision. A receipt is issued when money posts,
 * either way.
 */
export async function postApprovedTransaction(
  id: string,
  principal: Principal,
  disbursement?: Disbursement
): Promise<TransactionSummary> {
  const transaction = await loadTransaction(id);
  if (!transaction) {
    throw new ReviewError('That transaction no longer exists.', 'not_found');
  }
  if (!principal.permissions.has(permissionToPost(transaction))) {
    throw new ReviewError(
      needsDisbursement(transaction)
        ? 'You do not have permission to disburse.'
        : 'You do not have permission to post transactions.',
      'forbidden'
    );
  }
  if (transaction.status !== 'approved') {
    throw new ReviewError(
      `${transaction.reference} is ${transaction.status}; only an approved transaction posts.`,
      'conflict'
    );
  }
  let paidBy: {
    code: string;
    reference: string | null;
    bankAccountId: string | null;
  } | null = null;
  if (transaction.legDirection === 'credit') {
    throw new ReviewError(
      'A transfer posts from its debit leg; open the transfer instead.',
      'conflict'
    );
  }
  if (needsDisbursement(transaction)) {
    if (!disbursement) {
      throw new ReviewError('Say how it was paid out.');
    }
    try {
      const method = await offeredMethod(disbursement.method);
      requireDisbursementReference(method, disbursement.methodReference);
      paidBy = {
        code: method.code,
        reference: (disbursement.methodReference ?? '').trim() || null,
        bankAccountId: await resolveBankAccount(
          disbursement.bankAccountId,
          message => new ReviewError(message)
        ),
      };
      requireBankAccount(
        method,
        paidBy.bankAccountId,
        message => new ReviewError(message)
      );
    } catch (err) {
      if (err instanceof PaymentError) throw new ReviewError(err.message);
      throw err;
    }
  }
  await refuseUnlessSegregated(principal, transaction.reference, ACTION_POSTED);

  const receipt = await allocateReceiptNumber(principal.userId);
  try {
    await withTransaction(async client => {
      await client.query(
        `update transaction
            set receipt_number_id = $2,
                method = coalesce($3, method),
                method_reference = case when $3 is null then method_reference
                                        else $4 end,
                bank_account_id = case when $3 is null then bank_account_id
                                       else $5::uuid end
          where id = $1`,
        [
          transaction.id,
          receipt.id,
          paidBy?.code ?? null,
          paidBy?.reference ?? null,
          paidBy?.bankAccountId ?? null,
        ]
      );
      // A closure pays out whatever the account holds at this moment
      // (S-1702): the figure is read again here, and post_transaction
      // refuses one that does not match, so nothing is left on a closed
      // account and nothing is paid that is not there.
      if (transaction.kind === 'closure') {
        await client.query(
          `update transaction t
              set amount = coalesce(
                (select balance from account_balance where account_id = t.account_id),
                0)
            where t.id = $1`,
          [transaction.id]
        );
      }
      // A claim pays out every account plus the benefit the claim carries
      // (S-1704).
      if (transaction.kind === 'demise') {
        await client.query(
          `update transaction t
              set amount = t.takaful_benefit + (
                select coalesce(sum(coalesce(b.balance, 0)), 0)
                  from account a
                  left join account_balance b on b.account_id = a.id
                 where a.member_id = t.member_id and a.status = 'closing')
            where t.id = $1`,
          [transaction.id]
        );
      }
      // A resignation pays out every core account (S-1703), read the same
      // way and refused the same way by post_transaction.
      if (transaction.kind === 'resignation') {
        await client.query(
          `update transaction t
              set amount = (
                select coalesce(sum(coalesce(b.balance, 0)), 0)
                  from account a
                  join account_type at on at.id = a.account_type_id
                  left join account_balance b on b.account_id = a.id
                 where a.member_id = t.member_id
                   and at.is_membership_default and a.status = 'closing')
            where t.id = $1`,
          [transaction.id]
        );
      }
      await postTransaction(
        transaction.id,
        { userId: principal.userId, description: principal.email },
        client
      );
      await markReceiptIssued(receipt.id, client);
      await client.query(
        `insert into transaction_transition
           (transaction_id, from_status, to_status, step_code, actor_user_id,
            actor_role, approval_rule_id, workflow_definition_id)
         values ($1, 'approved', 'posted', null, $2, $3, $4, $5)`,
        [
          transaction.id,
          principal.userId,
          principal.roleNames.join(', ') || null,
          transaction.approvalRuleId,
          transaction.workflowDefinitionId,
        ]
      );
    });
  } catch (err) {
    await abandonReceiptNumber(
      receipt.id,
      err instanceof LedgerError
        ? err.message
        : 'The transaction failed while posting.'
    );
    if (err instanceof LedgerError) {
      throw new ReviewError(err.message, 'conflict');
    }
    throw err;
  }
  await notifyReceiptIssued(id);
  const posted = (await loadTransaction(id))!;
  await notifyExit(posted, 'approved');
  await notifyPosted([posted, await transferCreditLeg(posted)]);
  return posted;
}

// The other side of a posted transfer, for its holder to be told (S-1803).
async function transferCreditLeg(
  t: TransactionSummary
): Promise<TransactionSummary | null> {
  if (!t.transferId) return null;
  const other = await query<{ id: string }>(
    `select id from transaction
      where transfer_id = $1 and leg_direction = 'credit'`,
    [t.transferId]
  );
  return other.rows[0] ? loadTransaction(other.rows[0].id) : null;
}

export interface TransactionTransition {
  fromStatus: string | null;
  toStatus: string;
  stepCode: string | null;
  actorName: string;
  actorRole: string | null;
  comment: string | null;
  ruleNote: string | null;
  workflowName: string | null;
  occurredAt: Date;
}

// S-1406 · The trail: every move, who made it, as which role, and the rule
// and chain that decided — read from the log, never recomputed from the
// chain as it is now.
export async function transitionsFor(
  transactionId: string
): Promise<TransactionTransition[]> {
  const result = await query<{
    from_status: string | null;
    to_status: string;
    step_code: string | null;
    actor_name: string;
    actor_role: string | null;
    comment: string | null;
    rule_note: string | null;
    workflow_name: string | null;
    occurred_at: Date;
  }>(
    `select tt.from_status, tt.to_status, tt.step_code,
            u.display_name as actor_name, tt.actor_role, tt.comment,
            r.note as rule_note, wd.name as workflow_name, tt.occurred_at
       from transaction_transition tt
       join app_user u on u.id = tt.actor_user_id
       left join approval_rule r on r.id = tt.approval_rule_id
       left join workflow_definition wd on wd.id = tt.workflow_definition_id
      where tt.transaction_id = $1
      order by tt.id`,
    [transactionId]
  );
  return result.rows.map(r => ({
    fromStatus: r.from_status,
    toStatus: r.to_status,
    stepCode: r.step_code,
    actorName: r.actor_name,
    actorRole: r.actor_role,
    comment: r.comment,
    ruleNote: r.rule_note,
    workflowName: r.workflow_name,
    occurredAt: r.occurred_at,
  }));
}
