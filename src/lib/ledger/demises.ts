// A deceased member's claim (S-1704, FRD 7.3, DEM-US-001..007). Schema:
// migrations/0079; docs/ledger.md.
//
// A claim is a transaction of kind 'demise' covering every account the
// member holds: on approval each is emptied and closed under the one
// disbursement, one receipt, paid to the claimant, and the membership ends
// — member.status = 'demised', dated (post_transaction). The Takaful
// benefit is the Society's own money, read from configuration when the
// claim is submitted, carried on the transaction as its own line and in
// the total, and never in the ledger.
//
// The request's life before its chain is a closure's (closures.ts) with no
// signature of the member's to take: the claimant is named — the nominee
// the member named on their application (S-602) by default, or another
// person the officer records — and the death certificate and the affidavit
// are filed against the transaction. The affidavit is a category, not a
// validation: whether the file is the right legal instrument is the
// reviewer's call.
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import {
  claimantFrom,
  nomineeOnApplication,
  type ClaimantInput,
} from './claimants';
import { offeredPaymentMethods, takafulBenefit } from '../config/reference';
import { query, withTransaction } from '../db/pool';
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
import {
  checklistComplete,
  IN_FLIGHT,
  isEditable,
  requestChecklist,
  type ClosureChecklistItem,
} from './closures';
import { LedgerError } from './ledger';
import { requireBankAccount, resolveBankAccount } from './bank-accounts';
import { notifyExit } from './exit-notifications';
import { notifySubmitted } from './transaction-notifications';
import { notifyReceiptIssued } from './receipt-notifications';
import {
  loadTransaction,
  type Claimant,
  type TransactionSummary,
} from './review';
import {
  resolveRoute,
  resubmitTransaction,
  submitTransaction,
} from './routing';

export class DemiseError extends Error {
  constructor(
    message: string,
    public readonly reason:
      'invalid' | 'not_found' | 'forbidden' | 'conflict' = 'invalid'
  ) {
    super(message);
    this.name = 'DemiseError';
  }
}

export const PERMISSION_CAPTURE = 'transaction.capture';
export const PERMISSION_POST = 'transaction.post';

export type { ClaimantInput } from './claimants';

export interface DemiseInput {
  memberId: string;
  claimant: ClaimantInput;
  // How the total goes to the claimant. Asked only where the matrix pays
  // the claim out at once, at the submit step (officer direction, as a
  // withdrawal): left out, the first offered method stands in until the
  // Treasurer records the real payout at the disbursement (S-1503).
  method?: string;
  methodReference?: string;
  // Which of the Society's bank accounts it is paid from (S-1902), where
  // the method touches one.
  bankAccountId?: string;
  reason?: string;
}

// Everything optional: what is not given stays as it was (the submit step
// sends only the payout, for a claim the matrix pays out at once).
export type DemiseEdit = Partial<Omit<DemiseInput, 'memberId'>>;
export type Demise = TransactionSummary;

export interface ClaimAccount {
  id: string;
  accountNo: string;
  accountTypeId: string;
  typeName: string;
  status: string;
  balance: string;
}

// Every account the member holds that is not closed, with what it holds.
export async function claimAccounts(memberId: string): Promise<ClaimAccount[]> {
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
      where a.member_id = $1 and a.status <> 'closed'
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

export interface ClaimTotals {
  accounts: ClaimAccount[];
  accountsTotal: string;
  takafulBenefit: string;
  total: string;
}

// The two figures and their sum (S-1704): what the accounts hold, and the
// benefit — the configured one for a claim not yet submitted, the one the
// claim carries once it is.
export async function claimTotals(
  memberId: string,
  benefit?: string
): Promise<ClaimTotals> {
  const accounts = await claimAccounts(memberId);
  const takaful = benefit ?? (await takafulBenefit());
  const accountsCents = accounts.reduce(
    (sum, a) => sum + toCents(a.balance),
    0
  );
  return {
    accounts,
    accountsTotal: fromCents(accountsCents),
    takafulBenefit: fromCents(toCents(takaful)),
    total: fromCents(accountsCents + toCents(takaful)),
  };
}

async function memberFor(memberId: string): Promise<{
  id: string;
  status: string;
  applicationId: string | null;
  membershipTypeCode: string;
}> {
  const result = await query<{
    id: string;
    status: string;
    application_id: string | null;
    type_code: string;
  }>(
    `select m.id, m.status, m.application_id, t.code as type_code
       from member m
       join membership_type t on t.id = m.membership_type_id
      where m.id = $1`,
    [memberId]
  );
  const r = result.rows[0];
  if (!r) throw new DemiseError('That member no longer exists.', 'not_found');
  return {
    id: r.id,
    status: r.status,
    applicationId: r.application_id,
    membershipTypeCode: r.type_code,
  };
}

/**
 * Whether a member of this type can be the subject of a claim at all. A
 * claim settles a death (FRD 7.3) and carries the funeral benefit; a
 * Corporate member is an entity, not a person, and leaves by resignation or
 * by closing its accounts. Read by the member's page for the button, and
 * enforced in refuseUnlessClaimable. `typeCode` is the membership type's
 * own code, not its label, as depositorFor reads it.
 */
export function claimableMembershipType(typeCode: string): boolean {
  return typeCode !== 'corporate';
}

/**
 * The nominee the member named (S-602): the first nominee party on their
 * founding application, as captured. Null for a legacy member with no
 * application here, or one with no nominee entered.
 */
export async function nomineeFor(memberId: string): Promise<Claimant | null> {
  const member = await memberFor(memberId);
  return nomineeOnApplication(member.applicationId);
}

async function resolvedClaimant(
  memberId: string,
  input: ClaimantInput
): Promise<Claimant> {
  return claimantFrom(
    input,
    input.kind === 'nominee' ? await nomineeFor(memberId) : null,
    message => new DemiseError(message),
    'No nominee is on file for this member. Name the claimant.'
  );
}

async function checkedMethod(code: string) {
  try {
    return await offeredMethod(code);
  } catch (err) {
    if (err instanceof PaymentError) {
      throw new DemiseError('Choose how the claim is paid out.');
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
    throw new DemiseError(
      'No payment method is configured. Ask an administrator.'
    );
  }
  return checkedMethod(first.code);
}

function checkedReason(reason: string | undefined): string | null {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length > 500) {
    throw new DemiseError('The note is too long (500 characters at most).');
  }
  return trimmed || null;
}

export async function demiseInFlightFor(
  memberId: string
): Promise<{ id: string; reference: string; status: string } | null> {
  const result = await query<{ id: string; reference: string; status: string }>(
    `select id, reference, status from transaction
      where member_id = $1 and kind = 'demise'
        and status = any($2::text[])
      order by created_at desc limit 1`,
    [memberId, IN_FLIGHT]
  );
  return result.rows[0] ?? null;
}

async function ownedEditable(
  id: string,
  principal: Principal
): Promise<TransactionSummary> {
  const claim = await loadTransaction(id);
  if (!claim || claim.kind !== 'demise') {
    throw new DemiseError('That claim no longer exists.', 'not_found');
  }
  if (!isEditable(claim.status)) {
    throw new DemiseError(
      `${claim.reference} is ${claim.status === 'posted' ? 'disbursed' : claim.status}, so it cannot be changed.`,
      'conflict'
    );
  }
  if (claim.capturedById !== principal.userId) {
    throw new DemiseError(
      `${claim.reference} is ${claim.capturedByName}'s to complete.`,
      'forbidden'
    );
  }
  return claim;
}

// A transaction still on its way (submitted, under review, approved) on
// any of the member's accounts: the total a claim would pay is about to
// change. Checked at the first step (officer feedback: a claim that cannot
// be submitted should not be started and its documents filed first) and
// again at submit.
export async function transactionOnItsWay(
  memberId: string,
  excludingId: string | null = null
): Promise<string | null> {
  const result = await query<{ reference: string }>(
    `select t.reference
       from transaction t
       join account a on a.id = t.account_id
      where a.member_id = $1
        and ($2::uuid is null or t.id <> $2::uuid)
        and t.status in ('submitted', 'under_review', 'approved')
      order by t.created_at limit 1`,
    [memberId, excludingId]
  );
  return result.rows[0]?.reference ?? null;
}

export function onItsWayMessage(reference: string): string {
  return `${reference} is still on its way. Wait for it to post or be decided.`;
}

async function refuseUnlessClaimable(
  memberId: string,
  existing: TransactionSummary | null
): Promise<ClaimAccount[]> {
  const member = await memberFor(memberId);
  if (!claimableMembershipType(member.membershipTypeCode)) {
    throw new DemiseError(
      'A corporate member has no demised claim. Resign the member instead.',
      'conflict'
    );
  }
  if (member.status !== 'active') {
    throw new DemiseError(`This member is ${member.status}.`, 'conflict');
  }
  const accounts = await claimAccounts(memberId);
  for (const account of accounts) {
    if (
      account.status !== 'active' &&
      !(existing && account.status === 'closing')
    ) {
      throw new DemiseError(
        `${account.accountNo} · ${account.typeName} is ${account.status}, so the claim cannot be made now.`,
        'conflict'
      );
    }
  }
  const other = await demiseInFlightFor(memberId);
  if (other && other.id !== existing?.id) {
    throw new DemiseError(
      `${other.reference} is already settling this member.`,
      'conflict'
    );
  }
  return accounts;
}

/**
 * Start a claim: a draft naming the claimant and how they are paid, with
 * the total as it stands — every account's balance and the configured
 * benefit. Nothing moves and the accounts are untouched until it is
 * submitted.
 */
export async function startDemise(
  input: DemiseInput,
  principal: Principal
): Promise<Demise> {
  if (!principal.permissions.has(PERMISSION_CAPTURE)) {
    throw new DemiseError(
      'You do not have permission to record a claim.',
      'forbidden'
    );
  }
  const accounts = await refuseUnlessClaimable(input.memberId, null);
  if (accounts.length === 0) {
    throw new DemiseError('This member has no account to settle.', 'conflict');
  }
  const onItsWay = await transactionOnItsWay(input.memberId);
  if (onItsWay) {
    throw new DemiseError(onItsWayMessage(onItsWay), 'conflict');
  }
  // Whoever starts it submits it: a claim that would post at once, started
  // by someone who may not post, could never be submitted.
  const route = await resolveRoute({
    kind: 'demise',
    accountTypeId: accounts[0].accountTypeId,
    amountCents: toCents((await claimTotals(input.memberId)).total),
    roleCodes: principal.roles,
  });
  if (!route.definition && !principal.permissions.has(PERMISSION_POST)) {
    throw new DemiseError(
      'This claim posts at once, which you may not do. Ask an Account ' +
        'Officer to record it.',
      'forbidden'
    );
  }
  const claimant = await resolvedClaimant(input.memberId, input.claimant);
  const method = await methodOrDefault(input.method);
  const reason = checkedReason(input.reason);
  const totals = await claimTotals(input.memberId);
  const bankAccountId = await resolveBankAccount(
    input.bankAccountId,
    message => new DemiseError(message)
  );

  const id = await withTransaction(async client => {
    const inserted = await client.query<{ id: string; reference: string }>(
      `insert into transaction
         (kind, member_id, account_id, amount, method, method_reference,
          reason, status, captured_by, payee_name, claimant_kind, claimant,
          takaful_benefit, bank_account_id)
       values ('demise', $1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11,
               $12)
       returning id, reference`,
      [
        input.memberId,
        accounts[0].id,
        totals.total,
        method.code,
        (input.methodReference ?? '').trim() || null,
        reason,
        principal.userId,
        claimant.name,
        input.claimant.kind,
        JSON.stringify(claimant),
        totals.takafulBenefit,
        bankAccountId,
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
          kind: 'demise',
          member_id: input.memberId,
          account_ids: accounts.map(a => a.id),
          claimant_kind: input.claimant.kind,
          claimant: claimant.name,
          accounts_total: totals.accountsTotal,
          takaful_benefit: totals.takafulBenefit,
          method: method.code,
        },
      },
      client
    );
    return id;
  });
  return (await loadTransaction(id))!;
}

export async function updateDemise(
  id: string,
  edit: DemiseEdit,
  principal: Principal
): Promise<Demise> {
  const claim = await ownedEditable(id, principal);
  const claimantKind = edit.claimant?.kind ?? claim.claimantKind;
  const claimant = edit.claimant
    ? await resolvedClaimant(claim.holderId, edit.claimant)
    : claim.claimant;
  if (!claimant || !claimantKind) {
    throw new DemiseError('Say who the claimant is.');
  }
  // The payout only where one is given (the submit step, for a claim the
  // matrix pays out at once): what is not given stays as it was.
  const method = await checkedMethod(edit.method ?? claim.method);
  const methodReference =
    edit.methodReference === undefined
      ? claim.methodReference || null
      : edit.methodReference.trim() || null;
  const reason =
    edit.reason === undefined
      ? claim.reason || null
      : checkedReason(edit.reason);
  const bankAccountId =
    edit.bankAccountId === undefined
      ? (claim.bankAccountId ?? null)
      : await resolveBankAccount(
          edit.bankAccountId,
          message => new DemiseError(message)
        );
  await withTransaction(async client => {
    await client.query(
      `update transaction
          set payee_name = $2, claimant_kind = $3, claimant = $4,
              method = $5, method_reference = $6, reason = $7,
              bank_account_id = $8
        where id = $1`,
      [
        claim.id,
        claimant.name,
        claimantKind,
        JSON.stringify(claimant),
        method.code,
        methodReference,
        reason,
        bankAccountId,
      ]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'transaction.edited',
        entityType: 'transaction',
        entityId: claim.reference,
        previousValue: {
          claimant_kind: claim.claimantKind,
          claimant: claim.claimant,
          method: claim.method,
          method_reference: claim.methodReference || null,
          reason: claim.reason || null,
        },
        newValue: {
          claimant_kind: claimantKind,
          claimant,
          method: method.code,
          method_reference: methodReference,
          reason,
        },
      },
      client
    );
  });
  return (await loadTransaction(id))!;
}

export function demiseChecklist(
  transactionId: string
): Promise<ClosureChecklistItem[]> {
  return requestChecklist(transactionId, 'demise');
}

/**
 * Submit the claim to its chain: the certificate and the affidavit on
 * file, the benefit read from configuration now and carried on the claim,
 * the amount refreshed to what every account holds plus that benefit, and
 * every account into 'closing'. A returned claim re-enters where it left.
 */
export async function submitDemise(
  id: string,
  principal: Principal
): Promise<Demise> {
  const claim = await ownedEditable(id, principal);
  const accounts = await refuseUnlessClaimable(claim.holderId, claim);
  if (!checklistComplete(await demiseChecklist(claim.id))) {
    throw new DemiseError(
      'File the death certificate and the affidavit before submitting.'
    );
  }
  const onItsWay = await transactionOnItsWay(claim.holderId, claim.id);
  if (onItsWay) {
    throw new DemiseError(onItsWayMessage(onItsWay), 'conflict');
  }

  const totals = await claimTotals(claim.holderId);
  const amountCents = toCents(totals.total);
  const method = await checkedMethod(claim.method);
  const route = await resolveRoute({
    kind: 'demise',
    accountTypeId: accounts[0].accountTypeId,
    amountCents,
    roleCodes: principal.roles,
  });
  if (!route.definition) {
    if (!principal.permissions.has(PERMISSION_POST)) {
      throw new DemiseError(
        'This claim posts at once, which you may not do. Ask an Account ' +
          'Officer to submit it.',
        'forbidden'
      );
    }
    try {
      requireReference(method, claim.methodReference);
    } catch (err) {
      if (err instanceof PaymentError) throw new DemiseError(err.message);
      throw err;
    }
    requireBankAccount(
      method,
      claim.bankAccountId,
      message => new DemiseError(message)
    );
  }
  const receipt = route.definition
    ? null
    : await allocateReceiptNumber(principal.userId);

  try {
    await withTransaction(async client => {
      await client.query(
        `update transaction
            set amount = $2, takaful_benefit = $3, receipt_number_id = $4
          where id = $1`,
        [claim.id, totals.total, totals.takafulBenefit, receipt?.id ?? null]
      );
      await client.query(
        `update account set status = 'closing'
          where id = any($1::uuid[]) and status = 'active'`,
        [accounts.map(a => a.id)]
      );
      const submission =
        claim.status === 'returned'
          ? await resubmitTransaction(
              client,
              {
                id: claim.id,
                reference: claim.reference,
                kind: 'demise',
                workflowDefinitionId: claim.workflowDefinitionId,
                currentStepCode: claim.currentStepCode,
              },
              route,
              principal
            )
          : await submitTransaction(
              client,
              { id: claim.id, reference: claim.reference, kind: 'demise' },
              route,
              principal
            );
      if (submission.posted && receipt) {
        await markReceiptIssued(receipt.id, client);
      }
    });
    if (receipt) await notifyReceiptIssued(claim.id);
    const submitted = (await loadTransaction(claim.id))!;
    // Told it arrived — or, routed nowhere, that it was paid out (S-1705).
    await notifyExit(submitted, receipt ? 'approved' : 'submitted');
    // The step it waits at hears so too (S-1804).
    await notifySubmitted([submitted], {
      byUserId: principal.userId,
      resubmitted: claim.status === 'returned',
    });
    return submitted;
  } catch (err) {
    if (receipt) {
      await abandonReceiptNumber(
        receipt.id,
        err instanceof DemiseError || err instanceof LedgerError
          ? err.message
          : 'The claim failed while being submitted.'
      );
    }
    if (err instanceof LedgerError) {
      throw new DemiseError(err.message, 'conflict');
    }
    throw err;
  }
}

/** Withdraw a draft or a returned claim; the accounts are open again. */
export async function cancelDemise(
  id: string,
  principal: Principal
): Promise<Demise> {
  const claim = await ownedEditable(id, principal);
  await withTransaction(async client => {
    await client.query(
      `update transaction set status = 'cancelled', current_step_code = null
        where id = $1`,
      [claim.id]
    );
    await client.query(
      `update account set status = 'active'
        where member_id = $1 and status = 'closing'`,
      [claim.holderId]
    );
    await client.query(
      `insert into transaction_transition
         (transaction_id, from_status, to_status, step_code, actor_user_id,
          actor_role, approval_rule_id, workflow_definition_id)
       values ($1, $2, 'cancelled', null, $3, $4, $5, $6)`,
      [
        claim.id,
        claim.status,
        principal.userId,
        principal.roleNames.join(', ') || null,
        claim.approvalRuleId,
        claim.workflowDefinitionId,
      ]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'transaction.cancelled',
        entityType: 'transaction',
        entityId: claim.reference,
        previousValue: { status: claim.status },
        newValue: { status: 'cancelled' },
      },
      client
    );
  });
  return (await loadTransaction(id))!;
}
