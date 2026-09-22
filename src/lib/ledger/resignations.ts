// Resigning from the Society (S-1703, FRD 7.2, RES-US-001..006). Schema:
// migrations/0078; docs/ledger.md.
//
// A resignation is a transaction of kind 'resignation' on the member's
// Shares account, covering every account of a membership-default type:
// Shares and the MSA go together and cannot be resigned singly, while a
// Hajj Savings or Investment account is untouched (FRD 7.2) and closes,
// if the member wants it closed, through S-1702. The request's life before
// its chain is a closure's (closures.ts): a draft the officer builds, the
// signed request filed against it, the submission that puts both accounts
// into 'closing'. What is this module's own is the pre-checks — each one
// configuration, each one named when it blocks — and that posting empties
// both accounts under one disbursement, one receipt, and ends the
// membership: member.status = 'resigned', dated (post_transaction).
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { query, withTransaction } from '../db/pool';
import { resignationChecks } from '../config/reference';
import {
  amountDueForApplication,
  paymentsForApplication,
  PaymentError,
  offeredMethod,
  requireReference,
} from '../payments/payments';
import { fromCents, toCents } from '../payments/money';
import {
  abandonReceiptNumber,
  allocateReceiptNumber,
  markReceiptIssued,
} from '../payments/receipts';
import {
  checkedReason,
  checklistComplete,
  IN_FLIGHT,
  isEditable,
  requestChecklist,
  type ClosureChecklistItem,
} from './closures';
import { LedgerError } from './ledger';
import { notifyExit } from './exit-notifications';
import { notifyReceiptIssued } from './receipt-notifications';
import { loadTransaction, type TransactionSummary } from './review';
import {
  resolveRoute,
  resubmitTransaction,
  submitTransaction,
} from './routing';

export class ResignationError extends Error {
  constructor(
    message: string,
    public readonly reason:
      'invalid' | 'not_found' | 'forbidden' | 'conflict' = 'invalid'
  ) {
    super(message);
    this.name = 'ResignationError';
  }
}

export const PERMISSION_CAPTURE = 'transaction.capture';
export const PERMISSION_POST = 'transaction.post';
export const REQUEST_DOCUMENT_CODE = 'resignation_request';

export interface ResignationInput {
  memberId: string;
  reason: string;
  // How the combined balance goes back to the member.
  method: string;
  methodReference?: string;
}

export type ResignationEdit = Omit<ResignationInput, 'memberId'>;
export type Resignation = TransactionSummary;

// The accounts a resignation covers: every one of a membership-default
// type, with what each holds.
export interface CoreAccount {
  id: string;
  accountNo: string;
  accountTypeId: string;
  typeName: string;
  status: string;
  balance: string;
}

export async function coreAccounts(memberId: string): Promise<CoreAccount[]> {
  const result = await query<{
    id: string;
    account_no: string;
    account_type_id: string;
    type_name: string;
    status: string;
    balance: string;
  }>(
    `select a.id, coalesce(a.account_no, m.member_no) as account_no,
            a.account_type_id, at.name as type_name, a.status,
            coalesce(b.balance, 0)::numeric(14, 2)::text as balance
       from account a
       join account_type at on at.id = a.account_type_id
       join member m on m.id = a.member_id
       left join account_balance b on b.account_id = a.id
      where a.member_id = $1 and at.is_membership_default
        and a.status <> 'closed'
      order by at.sort_order, a.opened_at`,
    [memberId]
  );
  return result.rows.map(r => ({
    id: r.id,
    accountNo: r.account_no,
    accountTypeId: r.account_type_id,
    typeName: r.type_name,
    status: r.status,
    balance: r.balance,
  }));
}

export function totalCents(accounts: CoreAccount[]): number {
  return accounts.reduce((sum, a) => sum + toCents(a.balance), 0);
}

async function memberFor(memberId: string): Promise<{
  id: string;
  status: string;
  applicationId: string | null;
}> {
  const result = await query<{
    id: string;
    status: string;
    application_id: string | null;
  }>(`select id, status, application_id from member where id = $1`, [memberId]);
  const r = result.rows[0];
  if (!r)
    throw new ResignationError('That member no longer exists.', 'not_found');
  return { id: r.id, status: r.status, applicationId: r.application_id };
}

export async function resignationInFlightFor(
  memberId: string
): Promise<{ id: string; reference: string; status: string } | null> {
  const result = await query<{ id: string; reference: string; status: string }>(
    `select id, reference, status from transaction
      where member_id = $1 and kind = 'resignation'
        and status = any($2::text[])
      order by created_at desc limit 1`,
    [memberId, IN_FLIGHT]
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// The pre-checks (RES-US-002): each one configuration, each one named
// ---------------------------------------------------------------------------
export interface ResignationCheck {
  code: 'pending_transactions' | 'unpaid_fees' | 'financing';
  label: string;
  // Off in configuration: shown as such, never blocks.
  enabled: boolean;
  passed: boolean;
  // What blocks, or what was found: one line.
  detail: string;
}

async function pendingOnCoreAccounts(
  memberId: string,
  excludingId: string | null
): Promise<string[]> {
  const result = await query<{ reference: string }>(
    `select t.reference
       from transaction t
       join account a on a.id = t.account_id
       join account_type at on at.id = a.account_type_id
      where a.member_id = $1 and at.is_membership_default
        and t.status in ('submitted', 'under_review', 'approved')
        and ($2::uuid is null or t.id <> $2::uuid)
      order by t.created_at`,
    [memberId, excludingId]
  );
  return result.rows.map(r => r.reference);
}

// What the membership was charged to join, less what was paid against it
// and not refunded or voided. A legacy member with no application here,
// or a type with no fee schedule, has nothing to check.
async function unpaidFeesCents(applicationId: string | null): Promise<number> {
  if (!applicationId) return 0;
  let due;
  try {
    due = await amountDueForApplication(applicationId);
  } catch (err) {
    if (err instanceof PaymentError) return 0;
    throw err;
  }
  const payments = await paymentsForApplication(applicationId);
  const paid = payments
    .filter(p => p.voidedAt === null)
    .reduce(
      (sum, p) => sum + (p.kind === 'refund' ? -1 : 1) * toCents(p.totalAmount),
      0
    );
  return Math.max(0, toCents(due.expectedTotal) - paid);
}

/**
 * Run every check for this member, for the screen and for submission. The
 * request being submitted is left out of the pending count.
 */
export async function checksFor(
  memberId: string,
  excludingId: string | null = null
): Promise<ResignationCheck[]> {
  const [switches, member] = await Promise.all([
    resignationChecks(),
    memberFor(memberId),
  ]);
  const pending = await pendingOnCoreAccounts(memberId, excludingId);
  const unpaid = await unpaidFeesCents(member.applicationId);
  return [
    {
      code: 'pending_transactions',
      label: 'No transaction on its way on Shares or the MSA',
      enabled: switches.pendingTransactions,
      passed: pending.length === 0,
      detail:
        pending.length === 0
          ? 'Nothing on its way.'
          : `${pending.join(', ')} still on its way.`,
    },
    {
      code: 'unpaid_fees',
      label: 'Joining fees fully paid',
      enabled: switches.unpaidFees,
      passed: unpaid === 0,
      detail:
        unpaid === 0
          ? 'Nothing owed.'
          : `Rs ${fromCents(unpaid)} of the joining fees unpaid.`,
    },
    {
      // Phase 3/4's hook (S-1703): nothing records financing yet, so this
      // passes; the switch is seeded off until there is something to check.
      code: 'financing',
      label: 'No financing outstanding',
      enabled: switches.financing,
      passed: true,
      detail: 'Nothing recorded.',
    },
  ];
}

export function blockingChecks(checks: ResignationCheck[]): ResignationCheck[] {
  return checks.filter(c => c.enabled && !c.passed);
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------
async function checkedMethod(code: string) {
  try {
    return await offeredMethod(code);
  } catch (err) {
    if (err instanceof PaymentError) {
      throw new ResignationError('Choose how the balance is paid out.');
    }
    throw err;
  }
}

function checkedReasonOrRefuse(reason: string | undefined): string {
  return checkedReason(
    reason,
    'Say why the member is leaving.',
    message => new ResignationError(message)
  );
}

async function ownedEditable(
  id: string,
  principal: Principal
): Promise<TransactionSummary> {
  const request = await loadTransaction(id);
  if (!request || request.kind !== 'resignation') {
    throw new ResignationError(
      'That resignation request no longer exists.',
      'not_found'
    );
  }
  if (!isEditable(request.status)) {
    throw new ResignationError(
      `${request.reference} is ${request.status}, so it cannot be changed.`,
      'conflict'
    );
  }
  if (request.capturedById !== principal.userId) {
    throw new ResignationError(
      `${request.reference} is ${request.capturedByName}'s to complete.`,
      'forbidden'
    );
  }
  return request;
}

async function refuseUnlessResignable(
  memberId: string,
  existing: TransactionSummary | null
): Promise<CoreAccount[]> {
  const member = await memberFor(memberId);
  if (member.status !== 'active') {
    throw new ResignationError(`This member is ${member.status}.`, 'conflict');
  }
  const accounts = await coreAccounts(memberId);
  if (accounts.length === 0) {
    throw new ResignationError(
      'This member has no Shares or MSA account to resign.',
      'conflict'
    );
  }
  for (const account of accounts) {
    if (
      account.status !== 'active' &&
      !(existing && account.status === 'closing')
    ) {
      throw new ResignationError(
        `${account.accountNo} · ${account.typeName} is ${account.status}, so the member cannot resign now.`,
        'conflict'
      );
    }
  }
  const other = await resignationInFlightFor(memberId);
  if (other && other.id !== existing?.id) {
    throw new ResignationError(
      `${other.reference} is already resigning this member.`,
      'conflict'
    );
  }
  return accounts;
}

/**
 * Start a resignation: a draft on the Shares account naming the reason and
 * the payout method, with the combined balance as it stands. Nothing moves
 * and the accounts are untouched until it is submitted.
 */
export async function startResignation(
  input: ResignationInput,
  principal: Principal
): Promise<Resignation> {
  if (!principal.permissions.has(PERMISSION_CAPTURE)) {
    throw new ResignationError(
      'You do not have permission to record a resignation.',
      'forbidden'
    );
  }
  const accounts = await refuseUnlessResignable(input.memberId, null);
  const reason = checkedReasonOrRefuse(input.reason);
  const method = await checkedMethod(input.method);

  const id = await withTransaction(async client => {
    const inserted = await client.query<{ id: string; reference: string }>(
      `insert into transaction
         (kind, member_id, account_id, amount, method, method_reference,
          reason, status, captured_by)
       values ('resignation', $1, $2, $3, $4, $5, $6, 'draft', $7)
       returning id, reference`,
      [
        input.memberId,
        accounts[0].id,
        fromCents(totalCents(accounts)),
        method.code,
        (input.methodReference ?? '').trim() || null,
        reason,
        principal.userId,
      ]
    );
    const { id, reference } = inserted.rows[0];
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'transaction.captured',
        entityType: 'transaction',
        entityId: reference,
        newValue: {
          kind: 'resignation',
          member_id: input.memberId,
          account_ids: accounts.map(a => a.id),
          balance: fromCents(totalCents(accounts)),
          method: method.code,
          reason,
        },
      },
      client
    );
    return id;
  });
  return (await loadTransaction(id))!;
}

export async function updateResignation(
  id: string,
  edit: ResignationEdit,
  principal: Principal
): Promise<Resignation> {
  const request = await ownedEditable(id, principal);
  const reason = checkedReasonOrRefuse(edit.reason);
  const method = await checkedMethod(edit.method);
  const methodReference = (edit.methodReference ?? '').trim() || null;
  await withTransaction(async client => {
    await client.query(
      `update transaction
          set reason = $2, method = $3, method_reference = $4
        where id = $1`,
      [request.id, reason, method.code, methodReference]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'transaction.edited',
        entityType: 'transaction',
        entityId: request.reference,
        previousValue: {
          reason: request.reason,
          method: request.method,
          method_reference: request.methodReference || null,
        },
        newValue: {
          reason,
          method: method.code,
          method_reference: methodReference,
        },
      },
      client
    );
  });
  return (await loadTransaction(id))!;
}

export function resignationChecklist(
  transactionId: string
): Promise<ClosureChecklistItem[]> {
  return requestChecklist(transactionId, 'resignation');
}

/**
 * Submit the request to its chain: the signed request on file, every
 * enabled check passed, the amount refreshed to what the core accounts
 * hold, and both accounts into 'closing'. A returned request re-enters
 * where it left (S-1404).
 */
export async function submitResignation(
  id: string,
  principal: Principal
): Promise<Resignation> {
  const request = await ownedEditable(id, principal);
  const accounts = await refuseUnlessResignable(request.holderId, request);
  if (!checklistComplete(await resignationChecklist(request.id))) {
    throw new ResignationError(
      'File the signed resignation request before submitting.'
    );
  }
  const blocking = blockingChecks(
    await checksFor(request.holderId, request.id)
  );
  if (blocking.length > 0) {
    throw new ResignationError(
      blocking.map(c => `${c.label}: ${c.detail}`).join(' '),
      'conflict'
    );
  }

  const amountCents = totalCents(accounts);
  const method = await checkedMethod(request.method);
  const route = await resolveRoute({
    kind: 'resignation',
    accountTypeId: accounts[0].accountTypeId,
    amountCents,
    roleCodes: principal.roles,
  });
  if (!route.definition) {
    if (!principal.permissions.has(PERMISSION_POST)) {
      throw new ResignationError(
        'This resignation posts at once, which you may not do. Ask an ' +
          'Account Officer to submit it.',
        'forbidden'
      );
    }
    try {
      requireReference(method, request.methodReference);
    } catch (err) {
      if (err instanceof PaymentError) throw new ResignationError(err.message);
      throw err;
    }
  }
  const receipt = route.definition
    ? null
    : await allocateReceiptNumber(principal.userId);

  try {
    await withTransaction(async client => {
      await client.query(
        `update transaction set amount = $2, receipt_number_id = $3
          where id = $1`,
        [request.id, fromCents(amountCents), receipt?.id ?? null]
      );
      await client.query(
        `update account set status = 'closing'
          where id = any($1::uuid[]) and status = 'active'`,
        [accounts.map(a => a.id)]
      );
      const submission =
        request.status === 'returned'
          ? await resubmitTransaction(
              client,
              {
                id: request.id,
                reference: request.reference,
                kind: 'resignation',
                workflowDefinitionId: request.workflowDefinitionId,
                currentStepCode: request.currentStepCode,
              },
              route,
              principal
            )
          : await submitTransaction(
              client,
              {
                id: request.id,
                reference: request.reference,
                kind: 'resignation',
              },
              route,
              principal
            );
      if (submission.posted && receipt) {
        await markReceiptIssued(receipt.id, client);
      }
    });
    if (receipt) await notifyReceiptIssued(request.id);
    const submitted = (await loadTransaction(request.id))!;
    // Told it arrived — or, routed nowhere, that it was paid out (S-1705).
    await notifyExit(submitted, receipt ? 'approved' : 'submitted');
    return submitted;
  } catch (err) {
    if (receipt) {
      await abandonReceiptNumber(
        receipt.id,
        err instanceof ResignationError || err instanceof LedgerError
          ? err.message
          : 'The resignation failed while being submitted.'
      );
    }
    if (err instanceof LedgerError) {
      throw new ResignationError(err.message, 'conflict');
    }
    throw err;
  }
}

/** Withdraw a draft or a returned request; the accounts are open again. */
export async function cancelResignation(
  id: string,
  principal: Principal
): Promise<Resignation> {
  const request = await ownedEditable(id, principal);
  await withTransaction(async client => {
    await client.query(
      `update transaction set status = 'cancelled', current_step_code = null
        where id = $1`,
      [request.id]
    );
    await client.query(
      `update account a set status = 'active'
         from account_type at
        where at.id = a.account_type_id and at.is_membership_default
          and a.member_id = $1 and a.status = 'closing'`,
      [request.holderId]
    );
    await client.query(
      `insert into transaction_transition
         (transaction_id, from_status, to_status, step_code, actor_user_id,
          actor_role, approval_rule_id, workflow_definition_id)
       values ($1, $2, 'cancelled', null, $3, $4, $5, $6)`,
      [
        request.id,
        request.status,
        principal.userId,
        principal.roleNames.join(', ') || null,
        request.approvalRuleId,
        request.workflowDefinitionId,
      ]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'transaction.cancelled',
        entityType: 'transaction',
        entityId: request.reference,
        previousValue: { status: request.status },
        newValue: { status: 'cancelled' },
      },
      client
    );
  });
  return (await loadTransaction(id))!;
}
