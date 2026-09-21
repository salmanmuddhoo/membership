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
import { LedgerError, postTransaction } from './ledger';
import type { TransactionKind } from '../config/reference';

export const PERMISSION_REVIEW = 'transaction.review';
export const PERMISSION_APPROVE = 'transaction.approve';
export const PERMISSION_POST = 'transaction.post';
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
  kind: TransactionKind;
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
  workflowDefinitionId: string | null;
  workflowCode: string | null;
  workflowName: string | null;
  currentStepCode: string | null;
  approvalRuleId: string | null;
  sourceOfFundFormConfirmed: boolean;
}

const SELECT = `
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
         t.workflow_definition_id, wd.code as workflow_code,
         wd.name as workflow_name, t.current_step_code, t.approval_rule_id,
         t.source_of_fund_form_confirmed
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
    left join workflow_definition wd on wd.id = t.workflow_definition_id
`;

interface Row {
  id: string;
  reference: string;
  kind: TransactionKind;
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
  workflow_definition_id: string | null;
  workflow_code: string | null;
  workflow_name: string | null;
  current_step_code: string | null;
  approval_rule_id: string | null;
  source_of_fund_form_confirmed: boolean;
}

function assemble(r: Row): TransactionSummary {
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
    workflowDefinitionId: r.workflow_definition_id,
    workflowCode: r.workflow_code,
    workflowName: r.workflow_name,
    currentStepCode: r.current_step_code,
    approvalRuleId: r.approval_rule_id,
    sourceOfFundFormConfirmed: r.source_of_fund_form_confirmed,
  };
}

export async function loadTransaction(
  id: string
): Promise<TransactionSummary | null> {
  const result = await query<Row>(`${SELECT} where t.id = $1`, [id]);
  const row = result.rows[0];
  return row ? assemble(row) : null;
}

// By its reference (TX-000123), which is what the audit log and a receipt
// carry (S-1406).
export async function loadTransactionByReference(
  reference: string
): Promise<TransactionSummary | null> {
  const result = await query<Row>(`${SELECT} where t.reference = $1`, [
    reference.trim().toUpperCase(),
  ]);
  const row = result.rows[0];
  return row ? assemble(row) : null;
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
  const result = await query<Row & { waiting_since: Date }>(
    `${SELECT}
      where t.workflow_definition_id is not null
        and t.current_step_code is not null
        and t.status = any($1::text[])${filter}
      order by t.submitted_at, t.serial_no`,
    params
  );
  return Promise.all(
    result.rows.map(async row => ({
      ...assemble(row),
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
  const result = await query<Row>(
    `${SELECT}
      where t.status = 'returned' and t.captured_by = $1
      order by t.submitted_at, t.serial_no`,
    [principal.userId]
  );
  return Promise.all(
    result.rows.map(async row => ({
      ...assemble(row),
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
  if (!principal.permissions.has(PERMISSION_POST)) return [];
  const params: unknown[] = [];
  let kindFilter = '';
  if (filter.kind) {
    params.push(filter.kind);
    kindFilter = ` and t.kind = $${params.length}`;
  }
  const result = await query<Row>(
    `${SELECT}
      where t.status = 'approved'${kindFilter}
      order by t.submitted_at, t.serial_no`,
    params
  );
  return Promise.all(
    result.rows.map(async row => ({
      ...assemble(row),
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
  return { status };
}

/**
 * S-1403 · Post an approved transaction: the act that moves the money, by
 * whoever holds transaction.post and did not capture it. A deposit takes
 * its receipt here, since a receipt is issued when money posts.
 */
export async function postApprovedTransaction(
  id: string,
  principal: Principal
): Promise<TransactionSummary> {
  if (!principal.permissions.has(PERMISSION_POST)) {
    throw new ReviewError(
      'You do not have permission to post transactions.',
      'forbidden'
    );
  }
  const transaction = await loadTransaction(id);
  if (!transaction) {
    throw new ReviewError('That transaction no longer exists.', 'not_found');
  }
  if (transaction.status !== 'approved') {
    throw new ReviewError(
      `${transaction.reference} is ${transaction.status}; only an approved transaction posts.`,
      'conflict'
    );
  }
  await refuseUnlessSegregated(principal, transaction.reference, ACTION_POSTED);

  const receipt =
    transaction.kind === 'deposit'
      ? await allocateReceiptNumber(principal.userId)
      : null;
  try {
    await withTransaction(async client => {
      if (receipt) {
        await client.query(
          `update transaction set receipt_number_id = $2 where id = $1`,
          [transaction.id, receipt.id]
        );
      }
      await postTransaction(
        transaction.id,
        { userId: principal.userId, description: principal.email },
        client
      );
      if (receipt) await markReceiptIssued(receipt.id, client);
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
    if (receipt) {
      await abandonReceiptNumber(
        receipt.id,
        err instanceof LedgerError
          ? err.message
          : 'The transaction failed while posting.'
      );
    }
    if (err instanceof LedgerError) {
      throw new ReviewError(err.message, 'conflict');
    }
    throw err;
  }
  return (await loadTransaction(id))!;
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
