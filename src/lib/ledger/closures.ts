// Closing an account (S-1702, FRD 7.1, CLS-US-001..006, ACC-US-005).
// Schema: migrations/0077; docs/ledger.md.
//
// A closure is a transaction of kind 'closure' — the matrix has routed the
// kind since 0070 — so the request rides the same chain, queue, trail and
// chevron as a withdrawal, and is paid out through the same disbursement
// step (S-1503, review.ts). What is this module's own is the request's
// life before the chain: a draft the officer builds up (the account, the
// reason, how the balance goes back), the signed request filed against it
// (documents.ts, owner 'transaction'), and the submission that puts the
// account into 'closing' so nothing else moves on it until it is decided.
//
// Only an account type that is not the membership's default can close
// here. Shares and the MSA go together, and taking them away is a
// resignation (S-1703): the refusal says so by name.
import { canTransact } from '../members/status';
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { query, withTransaction } from '../db/pool';
import { listDocumentTypes, offeredPaymentMethods } from '../config/reference';
import {
  documentsForTransaction,
  type TransactionDocument,
} from '../documents/documents';
import {
  offeredMethod,
  PaymentError,
  requireReference,
} from '../payments/payments';
import { fromCents, toCents } from '../payments/money';
import {
  abandonReceiptNumber,
  allocateReceiptNumber,
  markReceiptIssued,
} from '../payments/receipts';
import { LedgerError } from './ledger';
import { requireBankAccount, resolveBankAccount } from './bank-accounts';
import {
  claimantFrom,
  markDeceasedOnceAllClosed,
  nomineeOnApplication,
  type ClaimantInput,
} from './claimants';
import { notifyExit } from './exit-notifications';
import { notifySubmitted } from './transaction-notifications';
import { notifyReceiptIssued } from './receipt-notifications';
import { loadTransaction, type TransactionSummary } from './review';
import {
  resolveRoute,
  resubmitTransaction,
  submitTransaction,
} from './routing';

export class ClosureError extends Error {
  constructor(
    message: string,
    public readonly reason:
      'invalid' | 'not_found' | 'forbidden' | 'conflict' = 'invalid'
  ) {
    super(message);
    this.name = 'ClosureError';
  }
}

export const PERMISSION_CAPTURE = 'transaction.capture';
export const PERMISSION_POST = 'transaction.post';
// The signed request (migration 0077): the one document a closure needs.
export const REQUEST_DOCUMENT_CODE = 'closure_request';
// A request is the officer's to change while it is theirs.
export const EDITABLE = ['draft', 'returned'] as const;
// A request that is on its way: one of these on an account is why no
// second one can start, and why the account reads 'closing'.
export const IN_FLIGHT = [
  'draft',
  'submitted',
  'under_review',
  'approved',
  'returned',
] as const;

export interface ClosureInput {
  accountId: string;
  // Why the member is closing it. Mandatory: it goes on the signed request.
  reason: string;
  // How the balance goes back to them. Asked only where the matrix pays it
  // out at once, at the submit step (officer direction, as a withdrawal):
  // left out, the first offered method stands in until the Treasurer
  // records the real payout at the disbursement (S-1503).
  method?: string;
  methodReference?: string;
  // Which of the Society's bank accounts it is paid from (S-1902), where
  // the method touches one.
  bankAccountId?: string;
  // The holder has died (business decision): a non-member's balances go to
  // their nominee, or to another person the officer records, with a death
  // certificate instead of the holder's signature. A member who dies is
  // settled by a demised claim instead (demises.ts).
  onDeath?: { claimant: ClaimantInput };
}

export type ClosureEdit = Omit<ClosureInput, 'accountId' | 'onDeath'> & {
  // A closure on a death only: who is paid, changed while the request is
  // still the officer's.
  claimant?: ClaimantInput;
};

export type Closure = TransactionSummary;

export function isEditable(status: string): boolean {
  return (EDITABLE as readonly string[]).includes(status);
}

// The account as the rules see it.
interface Candidate {
  id: string;
  accountNo: string;
  accountTypeId: string;
  typeName: string;
  isMembershipDefault: boolean;
  status: string;
  memberId: string | null;
  customerId: string | null;
  holderStatus: string;
  // Where the holder's details, and so their nominee, are kept.
  holderApplicationId: string | null;
  balance: string;
}

async function candidate(accountId: string): Promise<Candidate> {
  const result = await query<{
    id: string;
    account_no: string;
    account_type_id: string;
    type_name: string;
    is_membership_default: boolean;
    status: string;
    member_id: string | null;
    customer_id: string | null;
    holder_status: string;
    holder_application_id: string | null;
    balance: string;
  }>(
    `select a.id, coalesce(a.account_no, m.member_no) as account_no,
            a.account_type_id, at.name as type_name,
            a.is_membership_default, a.status, a.member_id, a.customer_id,
            coalesce(m.status, c.status) as holder_status,
            coalesce(m.application_id, c.application_id)
              as holder_application_id,
            coalesce(b.balance, 0)::numeric(14, 2)::text as balance
       from account a
       join account_type at on at.id = a.account_type_id
       left join member m on m.id = a.member_id
       left join customer c on c.id = a.customer_id
       left join account_balance b on b.account_id = a.id
      where a.id = $1`,
    [accountId]
  );
  const r = result.rows[0];
  if (!r) throw new ClosureError('That account no longer exists.', 'not_found');
  return {
    id: r.id,
    accountNo: r.account_no,
    accountTypeId: r.account_type_id,
    typeName: r.type_name,
    isMembershipDefault: r.is_membership_default,
    status: r.status,
    memberId: r.member_id,
    customerId: r.customer_id,
    holderStatus: r.holder_status,
    holderApplicationId: r.holder_application_id,
    balance: r.balance,
  };
}

// A closure already on its way for this account, other than the one asking.
async function closureInFlight(
  accountId: string,
  excludingId: string | null
): Promise<{ id: string; reference: string } | null> {
  const result = await query<{ id: string; reference: string }>(
    `select id, reference from transaction
      where account_id = $1 and kind = 'closure'
        and status = any($2::text[])
        and ($3::uuid is null or id <> $3::uuid)
      order by created_at desc limit 1`,
    [accountId, IN_FLIGHT, excludingId]
  );
  return result.rows[0] ?? null;
}

// The checks, the first failure named. `existing` is the request being
// edited or submitted, which is allowed to find the account already
// closing for it.
async function refuseUnlessClosable(
  account: Candidate,
  existing: TransactionSummary | null
): Promise<void> {
  if (account.isMembershipDefault) {
    throw new ClosureError(
      `${account.accountNo} · ${account.typeName} is a membership account. ` +
        'Closing it is a resignation.'
    );
  }
  if (account.status === 'closed') {
    throw new ClosureError(
      `${account.accountNo} is already closed.`,
      'conflict'
    );
  }
  if (
    account.status !== 'active' &&
    !(existing && account.status === 'closing')
  ) {
    throw new ClosureError(
      `This account is ${account.status}, so it cannot be closed now.`,
      'conflict'
    );
  }
  if (!canTransact(account.holderStatus)) {
    throw new ClosureError(
      `This ${account.memberId ? 'member' : 'customer'} is ${account.holderStatus}.`,
      'conflict'
    );
  }
  const other = await closureInFlight(account.id, existing?.id ?? null);
  if (other) {
    throw new ClosureError(
      `${other.reference} is already closing this account.`,
      'conflict'
    );
  }
}

async function checkedMethod(code: string) {
  try {
    return await offeredMethod(code);
  } catch (err) {
    if (err instanceof PaymentError) {
      throw new ClosureError('Choose how the balance is paid out.');
    }
    throw err;
  }
}

// The method given, checked; or, none given, the first one offered, as the
// stand-in the Treasurer replaces with the real payout (resignations.ts
// does the same).
async function methodOrDefault(code: string | undefined) {
  if (code && code.trim()) return checkedMethod(code);
  const [first] = await offeredPaymentMethods();
  if (!first) {
    throw new ClosureError(
      'No payment method is configured. Ask an administrator.'
    );
  }
  return checkedMethod(first.code);
}

// Who a deceased holder's balance goes to (business decision). Only a
// non-member's: a member still in the membership who dies is settled by a
// demised claim, which covers every account and adds the Takaful benefit.
async function deceasedClaimant(account: Candidate, input: ClaimantInput) {
  if (account.memberId && account.holderStatus === 'active') {
    throw new ClosureError(
      'A member who has died is settled by a demised claim.',
      'conflict'
    );
  }
  return claimantFrom(
    input,
    input.kind === 'nominee'
      ? await nomineeOnApplication(account.holderApplicationId)
      : null,
    message => new ClosureError(message),
    'No nominee is on file. Name who is paid.'
  );
}

export const DECEASED_REASON = 'The account holder has died.';

// Shared with a resignation (resignations.ts), which says what is missing
// in its own words and throws its own error.
export function checkedReason(
  reason: string | undefined,
  missing = 'Say why the account is closing.',
  refuse: (message: string) => Error = message => new ClosureError(message)
): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed === '') throw refuse(missing);
  if (trimmed.length > 500) {
    throw refuse('The reason is too long (500 characters at most).');
  }
  return trimmed;
}

async function ownedEditable(
  id: string,
  principal: Principal
): Promise<TransactionSummary> {
  const closure = await loadTransaction(id);
  if (!closure || closure.kind !== 'closure') {
    throw new ClosureError(
      'That closure request no longer exists.',
      'not_found'
    );
  }
  if (!isEditable(closure.status)) {
    throw new ClosureError(
      `${closure.reference} is ${closure.status}, so it cannot be changed.`,
      'conflict'
    );
  }
  if (closure.capturedById !== principal.userId) {
    throw new ClosureError(
      `${closure.reference} is ${closure.capturedByName}'s to complete.`,
      'forbidden'
    );
  }
  return closure;
}

/**
 * Start a closure request: a draft naming the account, the reason and the
 * payout method, with the balance as it stands. Nothing moves and the
 * account is untouched until it is submitted.
 */
export async function startClosure(
  input: ClosureInput,
  principal: Principal
): Promise<Closure> {
  if (!principal.permissions.has(PERMISSION_CAPTURE)) {
    throw new ClosureError(
      'You do not have permission to record a closure.',
      'forbidden'
    );
  }
  const account = await candidate(input.accountId);
  await refuseUnlessClosable(account, null);
  const claimant = input.onDeath
    ? await deceasedClaimant(account, input.onDeath.claimant)
    : null;
  const reason = checkedReason(
    claimant ? (input.reason ?? '').trim() || DECEASED_REASON : input.reason
  );
  const method = await methodOrDefault(input.method);
  const bankAccountId = await resolveBankAccount(
    input.bankAccountId,
    message => new ClosureError(message)
  );

  const id = await withTransaction(async client => {
    const inserted = await client.query<{ id: string; reference: string }>(
      `insert into transaction
         (kind, member_id, customer_id, account_id, amount, method,
          method_reference, reason, status, captured_by, bank_account_id,
          payee_name, claimant_kind, claimant)
       values ('closure', $1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9,
               $10, $11, $12)
       returning id, reference`,
      [
        account.memberId,
        account.customerId,
        account.id,
        account.balance,
        method.code,
        (input.methodReference ?? '').trim() || null,
        reason,
        principal.userId,
        bankAccountId,
        claimant?.name ?? null,
        claimant ? input.onDeath!.claimant.kind : null,
        claimant ? JSON.stringify(claimant) : null,
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
          kind: 'closure',
          account_id: account.id,
          balance: account.balance,
          method: method.code,
          reason,
          ...(claimant
            ? { claimant_kind: input.onDeath!.claimant.kind, claimant }
            : {}),
        },
      },
      client
    );
    return id;
  });
  return (await loadTransaction(id))!;
}

/**
 * Change the reason, and the payout where one is given (the submit step, for
 * a closure the matrix pays out at once), while the request is still the
 * officer's. What is not given stays as it was.
 */
export async function updateClosure(
  id: string,
  edit: ClosureEdit,
  principal: Principal
): Promise<Closure> {
  const closure = await ownedEditable(id, principal);
  // Who is paid, on a death, where the edit names them again.
  const claimant =
    edit.claimant && closure.claimantKind
      ? await deceasedClaimant(
          await candidate(closure.accountId),
          edit.claimant
        )
      : closure.claimant;
  const claimantKind = claimant
    ? (edit.claimant?.kind ?? closure.claimantKind)
    : null;
  const reason = checkedReason(
    claimant ? (edit.reason ?? '').trim() || DECEASED_REASON : edit.reason
  );
  const method = await checkedMethod(edit.method ?? closure.method);
  const methodReference =
    edit.methodReference === undefined
      ? closure.methodReference || null
      : edit.methodReference.trim() || null;
  const bankAccountId =
    edit.bankAccountId === undefined
      ? (closure.bankAccountId ?? null)
      : await resolveBankAccount(
          edit.bankAccountId,
          message => new ClosureError(message)
        );
  await withTransaction(async client => {
    await client.query(
      `update transaction
          set reason = $2, method = $3, method_reference = $4,
              bank_account_id = $5, payee_name = $6, claimant_kind = $7,
              claimant = $8
        where id = $1`,
      [
        closure.id,
        reason,
        method.code,
        methodReference,
        bankAccountId,
        claimant?.name ?? null,
        claimantKind,
        claimant ? JSON.stringify(claimant) : null,
      ]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'transaction.edited',
        entityType: 'transaction',
        entityId: closure.reference,
        previousValue: {
          reason: closure.reason,
          method: closure.method,
          method_reference: closure.methodReference || null,
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

export interface ClosureChecklistItem {
  documentTypeId: string;
  documentCode: string;
  documentName: string;
  filed: TransactionDocument | null;
}

// The kinds of transaction that are a request the officer builds before it
// goes to its chain, and the signed paper each one needs.
export const REQUEST_DOCUMENT_CODES: Record<string, string[]> = {
  closure: [REQUEST_DOCUMENT_CODE],
  resignation: ['resignation_request'],
  demise: ['death_certificate', 'affidavit'],
};

export const DEATH_DOCUMENT_CODES = ['death_certificate'];

export function isExitRequest(kind: string): boolean {
  return kind in REQUEST_DOCUMENT_CODES;
}

/**
 * What a request has to carry, and what it does: the signed request, filed
 * against the transaction (documents.ts). One item per kind today; a
 * demised claim adds its certificate and affidavit (S-1704).
 */
export async function requestChecklist(
  transactionId: string,
  kind: string,
  // A closure on a death: the death certificate, not the holder's
  // signature.
  onDeath = false
): Promise<ClosureChecklistItem[]> {
  const codes =
    kind === 'closure' && onDeath
      ? DEATH_DOCUMENT_CODES
      : REQUEST_DOCUMENT_CODES[kind];
  if (!codes) return [];
  const [types, filed] = await Promise.all([
    listDocumentTypes(),
    documentsForTransaction(transactionId),
  ]);
  return codes.flatMap(code => {
    const type = types.find(t => t.code === code);
    if (!type) return [];
    return [
      {
        documentTypeId: type.id,
        documentCode: type.code,
        documentName: type.name,
        filed: filed.find(d => d.documentTypeId === type.id) ?? null,
      },
    ];
  });
}

export async function closureChecklist(
  transactionId: string
): Promise<ClosureChecklistItem[]> {
  const onDeath = await query<{ on_death: boolean }>(
    `select claimant_kind is not null as on_death from transaction
      where id = $1`,
    [transactionId]
  );
  return requestChecklist(
    transactionId,
    'closure',
    onDeath.rows[0]?.on_death ?? false
  );
}

export function checklistComplete(items: ClosureChecklistItem[]): boolean {
  return items.length > 0 && items.every(i => i.filed !== null);
}

/**
 * Submit the request to its chain. The account goes into 'closing' — no
 * other transaction posts on it until this one is decided — and the amount
 * becomes the balance as it stands now, which is what the Treasurer pays
 * out. A returned request re-enters where it left (S-1404).
 *
 * The matrix always routes a closure to a chain as seeded (0070); an
 * administrator who makes it post at once gets a closure that pays out and
 * closes the account here, by someone holding transaction.post.
 */
export async function submitClosure(
  id: string,
  principal: Principal
): Promise<Closure> {
  const closure = await ownedEditable(id, principal);
  const account = await candidate(closure.accountId);
  await refuseUnlessClosable(account, closure);
  if (!checklistComplete(await closureChecklist(closure.id))) {
    throw new ClosureError(
      closure.claimantKind
        ? 'File the death certificate before submitting.'
        : 'File the signed closure request before submitting.'
    );
  }
  const inFlight = await query<{ reference: string }>(
    `select reference from transaction
      where account_id = $1 and id <> $2
        and status in ('submitted', 'under_review', 'approved')
      order by created_at limit 1`,
    [account.id, closure.id]
  );
  if (inFlight.rowCount) {
    throw new ClosureError(
      `${inFlight.rows[0].reference} is still on its way on this account. ` +
        'Wait for it to post or be decided.',
      'conflict'
    );
  }

  const amountCents = toCents(account.balance);
  const method = await checkedMethod(closure.method);
  const route = await resolveRoute({
    kind: 'closure',
    accountTypeId: account.accountTypeId,
    amountCents,
    roleCodes: principal.roles,
  });
  if (!route.definition) {
    if (!principal.permissions.has(PERMISSION_POST)) {
      throw new ClosureError(
        'This closure posts at once, which you may not do. Ask an Account ' +
          'Officer to submit it.',
        'forbidden'
      );
    }
    try {
      requireReference(method, closure.methodReference);
    } catch (err) {
      if (err instanceof PaymentError) throw new ClosureError(err.message);
      throw err;
    }
    requireBankAccount(
      method,
      closure.bankAccountId,
      message => new ClosureError(message)
    );
  }
  const receipt = route.definition
    ? null
    : await allocateReceiptNumber(principal.userId);

  try {
    await withTransaction(async client => {
      await client.query(
        `update transaction set amount = $2, receipt_number_id = $3
          where id = $1`,
        [closure.id, fromCents(amountCents), receipt?.id ?? null]
      );
      await client.query(
        `update account set status = 'closing'
          where id = $1 and status = 'active'`,
        [account.id]
      );
      const submission =
        closure.status === 'returned'
          ? await resubmitTransaction(
              client,
              {
                id: closure.id,
                reference: closure.reference,
                kind: 'closure',
                workflowDefinitionId: closure.workflowDefinitionId,
                currentStepCode: closure.currentStepCode,
              },
              route,
              principal
            )
          : await submitTransaction(
              client,
              { id: closure.id, reference: closure.reference, kind: 'closure' },
              route,
              principal
            );
      if (submission.posted && receipt) {
        await markReceiptIssued(receipt.id, client);
      }
      if (submission.posted) {
        await markDeceasedOnceAllClosed(client, closure.id, principal);
      }
    });
    if (receipt) await notifyReceiptIssued(closure.id);
    const submitted = (await loadTransaction(closure.id))!;
    // Told it arrived — or, routed nowhere, that it was paid out (S-1705).
    await notifyExit(submitted, receipt ? 'approved' : 'submitted');
    // The step it waits at hears so too (S-1804).
    await notifySubmitted([submitted], {
      byUserId: principal.userId,
      resubmitted: closure.status === 'returned',
    });
    return submitted;
  } catch (err) {
    if (receipt) {
      await abandonReceiptNumber(
        receipt.id,
        err instanceof ClosureError || err instanceof LedgerError
          ? err.message
          : 'The closure failed while being submitted.'
      );
    }
    if (err instanceof LedgerError) {
      throw new ClosureError(err.message, 'conflict');
    }
    throw err;
  }
}

/**
 * Withdraw a request that has not been decided: a draft, or one a reviewer
 * returned. The account, if it was closing, is open again.
 */
export async function cancelClosure(
  id: string,
  principal: Principal
): Promise<Closure> {
  const closure = await ownedEditable(id, principal);
  await withTransaction(async client => {
    await client.query(
      `update transaction set status = 'cancelled', current_step_code = null
        where id = $1`,
      [closure.id]
    );
    await client.query(
      `update account set status = 'active'
        where id = $1 and status = 'closing'`,
      [closure.accountId]
    );
    await client.query(
      `insert into transaction_transition
         (transaction_id, from_status, to_status, step_code, actor_user_id,
          actor_role, approval_rule_id, workflow_definition_id)
       values ($1, $2, 'cancelled', null, $3, $4, $5, $6)`,
      [
        closure.id,
        closure.status,
        principal.userId,
        principal.roleNames.join(', ') || null,
        closure.approvalRuleId,
        closure.workflowDefinitionId,
      ]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'transaction.cancelled',
        entityType: 'transaction',
        entityId: closure.reference,
        previousValue: { status: closure.status },
        newValue: { status: 'cancelled' },
      },
      client
    );
  });
  return (await loadTransaction(id))!;
}

/**
 * The closure on its way for each of a holder's accounts, if any — what
 * the member page shows in place of "Close" (S-1702).
 */
export async function closuresInFlightFor(holder: {
  memberId?: string;
  customerId?: string;
}): Promise<Map<string, { id: string; reference: string; status: string }>> {
  const result = await query<{
    account_id: string;
    id: string;
    reference: string;
    status: string;
  }>(
    `select distinct on (account_id) account_id, id, reference, status
       from transaction
      where kind = 'closure' and status = any($3::text[])
        and (($1::uuid is not null and member_id = $1::uuid)
          or ($2::uuid is not null and customer_id = $2::uuid))
      order by account_id, created_at desc`,
    [holder.memberId ?? null, holder.customerId ?? null, IN_FLIGHT]
  );
  return new Map(
    result.rows.map(r => [
      r.account_id,
      { id: r.id, reference: r.reference, status: r.status },
    ])
  );
}
