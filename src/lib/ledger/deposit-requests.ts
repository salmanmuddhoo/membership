// A large cash deposit as a request (S-1306, the half M13 left; TXN-US-003,
// TXN-US-011, FRD 6.7).
//
// A deposit is one act — recorded and on the ledger before the officer lets
// go of the button (deposits.ts). Cash above payment.cash_source_of_fund_
// threshold is the exception: the Society wants the Source of Fund form
// signed and filed before that money is on an account, and a tick on the
// capture screen is not that. So such a deposit lives first as a request,
// the way a closure does (closures.ts): a draft the officer starts, the
// sheet the depositor signs on screen and files against the transaction
// (documents.ts, owner 'transaction'), and the submission by that same
// officer — which is the ordinary deposit from there: the matrix, the
// engine, the receipt. M23 had a second officer verify the form first;
// the Society has since dropped that check (officer direction), so the
// signed form on file is enough and no queue waits on it.
//
// One control, not two: the threshold and the ceiling are the entries a fee
// payment reads (applyCashPaymentRules), and the form is the document type
// migration 0062 seeded for a payment.
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import {
  cashSourceOfFundThreshold,
  listDocumentTypes,
  type PaymentMethod as PaymentMethodConfig,
} from '../config/reference';
import { query, withTransaction } from '../db/pool';
import {
  documentsForTransaction,
  type TransactionDocument,
} from '../documents/documents';
import {
  applyCashPaymentRules,
  offeredMethod,
  PaymentError,
} from '../payments/payments';
import { fromCents, toCents } from '../payments/money';
import {
  abandonReceiptNumber,
  allocateReceiptNumber,
  markReceiptIssued,
} from '../payments/receipts';
import {
  DepositError,
  destination,
  loadDeposit,
  parseAmount,
  PERMISSION_CAPTURE,
  PERMISSION_POST,
  refuseUnlessDepositable,
  type Deposit,
} from './deposits';
import { LedgerError } from './ledger';
import { notifyReceiptIssued } from './receipt-notifications';
import { loadTransaction } from './review';
import { resolveRoute, submitTransaction } from './routing';
import { notifySubmitted } from './transaction-notifications';

export const SOURCE_OF_FUND_DOCUMENT_CODE = 'source_of_fund_form';

export interface DepositRequestInput {
  accountId: string;
  amount: string;
  method: string;
  reason?: string;
}

export interface SourceOfFundItem {
  documentTypeId: string;
  documentCode: string;
  documentName: string;
  filed: TransactionDocument | null;
}

async function method(code: string): Promise<PaymentMethodConfig> {
  try {
    return await offeredMethod(code);
  } catch (err) {
    if (err instanceof PaymentError) throw new DepositError(err.message);
    throw err;
  }
}

/** Cash above the Source of Fund threshold: the one case this path is for. */
export async function needsSourceOfFundForm(
  paymentMethod: PaymentMethodConfig,
  amountCents: number
): Promise<boolean> {
  if (!paymentMethod.isCash) return false;
  return amountCents > toCents(await cashSourceOfFundThreshold());
}

// The ceiling still applies (the form does not lift it); the threshold is
// what brought us here, so the confirmation the rule asks for is the request
// itself.
async function cashRules(
  paymentMethod: PaymentMethodConfig,
  amountCents: number
): Promise<void> {
  try {
    await applyCashPaymentRules(paymentMethod, amountCents, true);
  } catch (err) {
    if (err instanceof PaymentError) throw new DepositError(err.message);
    throw err;
  }
}

async function ownedDraft(id: string, principal: Principal): Promise<Deposit> {
  const deposit = await loadDeposit(id);
  if (!deposit || deposit.kind !== 'deposit') {
    throw new DepositError(
      'That deposit request no longer exists.',
      'not_found'
    );
  }
  if (deposit.status !== 'draft') {
    throw new DepositError(
      `${deposit.reference} is ${deposit.status}, so it cannot be changed.`,
      'conflict'
    );
  }
  if (deposit.capturedById !== principal.userId) {
    throw new DepositError(
      `${deposit.reference} is ${deposit.capturedByName}'s to complete.`,
      'forbidden'
    );
  }
  return deposit;
}

/**
 * Start the request: the account, the amount and the method, checked as a
 * deposit is, written as a draft that posts nothing yet.
 */
export async function startDepositRequest(
  input: DepositRequestInput,
  principal: Principal
): Promise<Deposit> {
  if (!principal.permissions.has(PERMISSION_CAPTURE)) {
    throw new DepositError(
      'You do not have permission to record deposits.',
      'forbidden'
    );
  }
  const amountCents = parseAmount(input.amount);
  const paymentMethod = await method(input.method);
  if (!(await needsSourceOfFundForm(paymentMethod, amountCents))) {
    throw new DepositError(
      'This deposit does not need a Source of Fund form. Record it directly.'
    );
  }
  await cashRules(paymentMethod, amountCents);
  const to = await destination(input.accountId);
  refuseUnlessDepositable(to, amountCents);

  const id = await withTransaction(async client => {
    const inserted = await client.query<{ id: string; reference: string }>(
      `insert into transaction
         (kind, member_id, customer_id, account_id, amount, method, reason,
          status, captured_by, source_of_fund_form_confirmed)
       values ('deposit', $1, $2, $3, $4, $5, $6, 'draft', $7, false)
       returning id, reference`,
      [
        to.memberId,
        to.customerId,
        to.id,
        fromCents(amountCents),
        paymentMethod.code,
        (input.reason ?? '').trim() || null,
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
          kind: 'deposit',
          account_id: to.id,
          amount: fromCents(amountCents),
          method: paymentMethod.code,
          source_of_fund_form: 'required',
        },
      },
      client
    );
    return id;
  });
  return (await loadDeposit(id))!;
}

/** Change the amount or the reason while the request is still a draft. */
export async function updateDepositRequest(
  id: string,
  edit: { amount: string; reason?: string },
  principal: Principal
): Promise<Deposit> {
  const deposit = await ownedDraft(id, principal);
  const amountCents = parseAmount(edit.amount);
  const paymentMethod = await method(deposit.method);
  if (!(await needsSourceOfFundForm(paymentMethod, amountCents))) {
    throw new DepositError(
      'At this amount no Source of Fund form is needed. Cancel this request ' +
        'and record the deposit directly.'
    );
  }
  await cashRules(paymentMethod, amountCents);
  const to = await destination(deposit.accountId);
  refuseUnlessDepositable(to, amountCents);
  const reason = (edit.reason ?? '').trim() || null;
  await withTransaction(async client => {
    await client.query(
      `update transaction set amount = $2, reason = $3 where id = $1`,
      [deposit.id, fromCents(amountCents), reason]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'transaction.edited',
        entityType: 'transaction',
        entityId: deposit.reference,
        previousValue: { amount: deposit.amount, reason: deposit.reason },
        newValue: { amount: fromCents(amountCents), reason },
      },
      client
    );
  });
  return (await loadDeposit(id))!;
}

/** The form the request needs, and what is on file for it. */
export async function sourceOfFundItem(
  transactionId: string
): Promise<SourceOfFundItem | null> {
  const [types, filed] = await Promise.all([
    listDocumentTypes(),
    documentsForTransaction(transactionId),
  ]);
  const type = types.find(t => t.code === SOURCE_OF_FUND_DOCUMENT_CODE);
  if (!type) return null;
  return {
    documentTypeId: type.id,
    documentCode: type.code,
    documentName: type.name,
    filed: filed.find(d => d.documentTypeId === type.id) ?? null,
  };
}

/**
 * Submit the request: the signed form on file (officer direction: the
 * officer who recorded it submits it, with no second check), and from there the
 * deposit an officer would have recorded at once — the matrix, the engine,
 * the receipt when it posts.
 */
export async function submitDepositRequest(
  id: string,
  principal: Principal
): Promise<Deposit> {
  const deposit = await ownedDraft(id, principal);
  const item = await sourceOfFundItem(deposit.id);
  if (!item) {
    throw new DepositError(
      'The Source of Fund form document type is not configured. Ask an ' +
        'administrator.'
    );
  }
  if (!item.filed) {
    throw new DepositError(
      'File the signed Source of Fund form before submitting.'
    );
  }
  if (item.filed.state === 'rejected') {
    throw new DepositError(
      'The Source of Fund form was rejected. Sign and file it again.'
    );
  }

  const amountCents = toCents(deposit.amount);
  const paymentMethod = await method(deposit.method);
  await cashRules(paymentMethod, amountCents);
  const to = await destination(deposit.accountId);
  refuseUnlessDepositable(to, amountCents);

  const route = await resolveRoute({
    kind: 'deposit',
    accountTypeId: to.accountTypeId,
    amountCents,
    roleCodes: principal.roles,
  });
  if (!route.definition && !principal.permissions.has(PERMISSION_POST)) {
    throw new DepositError(
      'You may record a deposit but not post it. Ask an Account Officer to ' +
        'submit it.',
      'forbidden'
    );
  }
  const receipt = route.definition
    ? null
    : await allocateReceiptNumber(principal.userId);

  try {
    await withTransaction(async client => {
      await client.query(
        `update transaction
            set source_of_fund_form_confirmed = true, receipt_number_id = $2
          where id = $1`,
        [deposit.id, receipt?.id ?? null]
      );
      const submission = await submitTransaction(
        client,
        { id: deposit.id, reference: deposit.reference, kind: 'deposit' },
        route,
        principal
      );
      if (submission.posted && receipt) {
        await markReceiptIssued(receipt.id, client);
      }
    });
    if (receipt) await notifyReceiptIssued(deposit.id);
    await notifySubmitted([await loadTransaction(deposit.id)], {
      byUserId: principal.userId,
    });
    return (await loadDeposit(deposit.id))!;
  } catch (err) {
    if (receipt) {
      await abandonReceiptNumber(
        receipt.id,
        err instanceof DepositError || err instanceof LedgerError
          ? err.message
          : 'The deposit failed while being submitted.'
      );
    }
    if (err instanceof LedgerError) {
      throw new DepositError(err.message, 'conflict');
    }
    throw err;
  }
}

/** Withdraw a request that was never submitted. */
export async function cancelDepositRequest(
  id: string,
  principal: Principal
): Promise<Deposit> {
  const deposit = await ownedDraft(id, principal);
  await withTransaction(async client => {
    await client.query(
      `update transaction set status = 'cancelled' where id = $1`,
      [deposit.id]
    );
    await client.query(
      `insert into transaction_transition
         (transaction_id, from_status, to_status, step_code, actor_user_id,
          actor_role)
       values ($1, 'draft', 'cancelled', null, $2, $3)`,
      [deposit.id, principal.userId, principal.roleNames.join(', ') || null]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'transaction.cancelled',
        entityType: 'transaction',
        entityId: deposit.reference,
        previousValue: { status: 'draft' },
        newValue: { status: 'cancelled' },
      },
      client
    );
  });
  return (await loadDeposit(id))!;
}

/** The captor's own draft requests for a holder, for the pages to link. */
export async function depositRequestsInFlightFor(holder: {
  memberId: string | null;
  customerId: string | null;
}): Promise<{ id: string; reference: string; accountId: string }[]> {
  const result = await query<{
    id: string;
    reference: string;
    account_id: string;
  }>(
    `select id, reference, account_id from transaction
      where kind = 'deposit' and status = 'draft'
        and (($1::uuid is not null and member_id = $1::uuid)
          or ($2::uuid is not null and customer_id = $2::uuid))
      order by created_at`,
    [holder.memberId, holder.customerId]
  );
  return result.rows.map(r => ({
    id: r.id,
    reference: r.reference,
    accountId: r.account_id,
  }));
}
