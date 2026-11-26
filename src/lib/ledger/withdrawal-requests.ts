// A withdrawal at the counter as a signed request (officer request,
// 26 November 2026).
//
// The client signs that they are withdrawing this amount before anything
// goes further: before the Secretary reviews a withdrawal that goes for
// approval, and before one paid out at once is paid. So a withdrawal an
// officer records lives first as a draft, the way a large cash deposit does
// (deposit-requests.ts): the details, the Withdrawal Form the client signs
// on screen and the officer files against the transaction (documents.ts,
// owner 'transaction'), then the submission by that same officer — which is
// the ordinary withdrawal from there: the matrix, the engine, the receipt.
//
// Every check runs at the start and again at the submission
// (checkedWithdrawal), so a balance that moved in between is caught. A
// withdrawal requested in the member app, or through the staff API by a
// system, is recorded in one act as before (recordWithdrawal): nobody is at
// a counter to sign.
import { createHash } from 'node:crypto';
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { listDocumentTypes } from '../config/reference';
import { query, withTransaction } from '../db/pool';
import {
  documentsForTransaction,
  type TransactionDocument,
} from '../documents/documents';
import { fromCents, toCents } from '../payments/money';
import {
  abandonReceiptNumber,
  allocateReceiptNumber,
  markReceiptIssued,
} from '../payments/receipts';
import { LedgerError } from './ledger';
import { notifyReceiptIssued } from './receipt-notifications';
import { loadTransaction, type TransactionSummary } from './review';
import { submitTransaction } from './routing';
import { notifySubmitted } from './transaction-notifications';
import {
  checkedWithdrawal,
  parseAmount,
  PERMISSION_CAPTURE,
  WITHDRAWAL_FORM_DOCUMENT_CODE,
  WithdrawalError,
  type WithdrawalInput,
} from './withdrawals';

export interface WithdrawalFormItem {
  documentTypeId: string;
  documentCode: string;
  documentName: string;
  filed: TransactionDocument | null;
}

async function ownedDraft(
  id: string,
  principal: Principal
): Promise<TransactionSummary> {
  const withdrawal = await loadTransaction(id);
  if (!withdrawal || withdrawal.kind !== 'withdrawal') {
    throw new WithdrawalError('That withdrawal no longer exists.', 'not_found');
  }
  if (withdrawal.status !== 'draft') {
    throw new WithdrawalError(
      `${withdrawal.reference} is ${withdrawal.status === 'posted' ? 'disbursed' : withdrawal.status}, so it cannot be changed.`,
      'conflict'
    );
  }
  if (withdrawal.capturedById !== principal.userId) {
    throw new WithdrawalError(
      `${withdrawal.reference} is ${withdrawal.capturedByName}'s to complete.`,
      'forbidden'
    );
  }
  return withdrawal;
}

function fingerprint(input: WithdrawalInput, amountCents: number): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'withdrawal-request',
        accountId: input.accountId,
        amountCents,
        method: input.method ?? '',
        methodReference: (input.methodReference ?? '').trim(),
        reason: (input.reason ?? '').trim(),
        payeeName: (input.payeeName ?? '').trim(),
      })
    )
    .digest('hex');
}

/**
 * Start the request: every check a withdrawal meets, then a draft that
 * moves nothing yet. The same form posted twice under its key is the same
 * request.
 */
export async function startWithdrawalRequest(
  input: WithdrawalInput,
  principal: Principal
): Promise<TransactionSummary> {
  if (!principal.permissions.has(PERMISSION_CAPTURE)) {
    throw new WithdrawalError(
      'You do not have permission to record withdrawals.',
      'forbidden'
    );
  }
  const amountCents = parseAmount(input.amount);
  const key = input.idempotencyKey?.trim() || null;
  const print = fingerprint(input, amountCents);
  if (key) {
    const existing = await query<{ id: string; fingerprint: string }>(
      `select id, idempotency_fingerprint as fingerprint from transaction
        where captured_by = $1 and idempotency_key = $2`,
      [principal.userId, key]
    );
    const row = existing.rows[0];
    if (row) {
      if (row.fingerprint !== print) {
        throw new WithdrawalError(
          'A different withdrawal was already submitted with this key.',
          'conflict',
          true
        );
      }
      return (await loadTransaction(row.id))!;
    }
  }

  const { from, payeeName, method, bankAccountId } = await checkedWithdrawal(
    input,
    amountCents,
    principal
  );

  const id = await withTransaction(async client => {
    const inserted = await client.query<{ id: string; reference: string }>(
      `insert into transaction
         (kind, member_id, customer_id, account_id, amount, method,
          method_reference, reason, status, idempotency_key,
          idempotency_fingerprint, captured_by, bank_account_id, payee_name)
       values ('withdrawal', $1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $10,
               $11, $12)
       returning id, reference`,
      [
        from.memberId,
        from.customerId,
        from.id,
        fromCents(amountCents),
        method.code,
        (input.methodReference ?? '').trim() || null,
        (input.reason ?? '').trim() || null,
        key,
        key ? print : null,
        principal.userId,
        bankAccountId,
        payeeName,
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
          kind: 'withdrawal',
          account_id: from.id,
          amount: fromCents(amountCents),
          method: method.code,
          payee_name: payeeName,
          withdrawal_form: 'required',
        },
      },
      client
    );
    return id;
  });
  return (await loadTransaction(id))!;
}

/** The form the request needs, and what is on file for it. */
export async function withdrawalFormItem(
  transactionId: string
): Promise<WithdrawalFormItem | null> {
  const [types, filed] = await Promise.all([
    listDocumentTypes(),
    documentsForTransaction(transactionId),
  ]);
  const type = types.find(t => t.code === WITHDRAWAL_FORM_DOCUMENT_CODE);
  if (!type) return null;
  return {
    documentTypeId: type.id,
    documentCode: type.code,
    documentName: type.name,
    filed: filed.find(d => d.documentTypeId === type.id) ?? null,
  };
}

/**
 * Submit the request: the signed form on file, then every check again and
 * from there the withdrawal recorded in one act — the matrix, the engine,
 * the receipt when it is paid out at once.
 */
export async function submitWithdrawalRequest(
  id: string,
  principal: Principal
): Promise<TransactionSummary> {
  const withdrawal = await ownedDraft(id, principal);
  const item = await withdrawalFormItem(withdrawal.id);
  if (!item) {
    throw new WithdrawalError(
      'The Withdrawal Form document type is not configured. Ask an ' +
        'administrator.'
    );
  }
  if (!item.filed) {
    throw new WithdrawalError(
      'File the signed Withdrawal Form before submitting.'
    );
  }
  if (item.filed.state === 'rejected') {
    throw new WithdrawalError(
      'The Withdrawal Form was rejected. Sign and file it again.'
    );
  }

  const amountCents = toCents(withdrawal.amount);
  const { route } = await checkedWithdrawal(
    {
      accountId: withdrawal.accountId,
      method: withdrawal.method,
      methodReference: withdrawal.methodReference,
      reason: withdrawal.reason,
      bankAccountId: withdrawal.bankAccountId ?? undefined,
      payeeName: withdrawal.payeeName ?? undefined,
    },
    amountCents,
    principal
  );
  const receipt = route.definition
    ? null
    : await allocateReceiptNumber(principal.userId);

  try {
    await withTransaction(async client => {
      await client.query(
        `update transaction set receipt_number_id = $2 where id = $1`,
        [withdrawal.id, receipt?.id ?? null]
      );
      const submission = await submitTransaction(
        client,
        {
          id: withdrawal.id,
          reference: withdrawal.reference,
          kind: 'withdrawal',
        },
        route,
        principal
      );
      if (submission.posted && receipt) {
        await markReceiptIssued(receipt.id, client);
      }
    });
    if (receipt) await notifyReceiptIssued(withdrawal.id);
    const made = (await loadTransaction(withdrawal.id))!;
    await notifySubmitted([made], { byUserId: principal.userId });
    return made;
  } catch (err) {
    if (receipt) {
      await abandonReceiptNumber(
        receipt.id,
        err instanceof WithdrawalError || err instanceof LedgerError
          ? err.message
          : 'The withdrawal failed while being submitted.'
      );
    }
    if (err instanceof LedgerError) {
      throw new WithdrawalError(err.message, 'conflict');
    }
    throw err;
  }
}

/** Withdraw a request that was never submitted. */
export async function cancelWithdrawalRequest(
  id: string,
  principal: Principal
): Promise<TransactionSummary> {
  const withdrawal = await ownedDraft(id, principal);
  await withTransaction(async client => {
    await client.query(
      `update transaction set status = 'cancelled' where id = $1`,
      [withdrawal.id]
    );
    await client.query(
      `insert into transaction_transition
         (transaction_id, from_status, to_status, step_code, actor_user_id,
          actor_role)
       values ($1, 'draft', 'cancelled', null, $2, $3)`,
      [withdrawal.id, principal.userId, principal.roleNames.join(', ') || null]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'transaction.cancelled',
        entityType: 'transaction',
        entityId: withdrawal.reference,
        previousValue: { status: 'draft' },
        newValue: { status: 'cancelled' },
      },
      client
    );
  });
  return (await loadTransaction(id))!;
}
