// Recording a withdrawal (S-1501, S-1502, S-1503). Schema: migrations/0064,
// 0065, 0072; docs/ledger.md.
//
// The first kind that takes money out, and the shape a transfer's debit leg
// follows (S-1504). The engine decides before anything is written, in the
// order FRD 6.3 reads and naming the first failure: the account and its
// type, the holder, the available balance (S-1502), the type's floor (hard,
// FRD 4.3 — a Shares account cannot be drawn below membership by mistake,
// decision 12), the type's maximum. Then the matrix (S-1401): below its
// band the withdrawal posts at once, paid out by the officer recording it;
// above it, it waits on its chain, and the disbursement is a separate act
// once approved (S-1503, postApprovedTransaction).
import { createHash } from 'node:crypto';
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { query, withTransaction } from '../db/pool';
import {
  offeredMethod,
  PaymentError,
  requireReference,
} from '../payments/payments';
import { fromCents, MoneyError, toCents } from '../payments/money';
import {
  abandonReceiptNumber,
  allocateReceiptNumber,
  markReceiptIssued,
} from '../payments/receipts';
import { availableBalance, LedgerError } from './ledger';
import { notifyReceiptIssued } from './receipt-notifications';
import { loadTransaction, type TransactionSummary } from './review';
import {
  resolveRoute,
  resubmitTransaction,
  submitTransaction,
} from './routing';

export class WithdrawalError extends Error {
  constructor(
    message: string,
    public readonly reason:
      'invalid' | 'not_found' | 'forbidden' | 'conflict' = 'invalid'
  ) {
    super(message);
    this.name = 'WithdrawalError';
  }
}

export const PERMISSION_CAPTURE = 'transaction.capture';
export const PERMISSION_POST = 'transaction.post';

export interface WithdrawalInput {
  accountId: string;
  amount: string;
  // How it is, or will be, paid out. The reference the method requires is
  // demanded when it posts at once; a withdrawal going to a chain gives it
  // at disbursement (S-1503).
  method: string;
  methodReference?: string;
  reason?: string;
  idempotencyKey?: string;
}

export type Withdrawal = TransactionSummary;

function fingerprint(input: WithdrawalInput, amountCents: number): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'withdrawal',
        accountId: input.accountId,
        amountCents,
        method: input.method,
        methodReference: (input.methodReference ?? '').trim(),
        reason: (input.reason ?? '').trim(),
      })
    )
    .digest('hex');
}

async function existingForKey(
  userId: string,
  key: string
): Promise<{ id: string; fingerprint: string } | null> {
  const result = await query<{ id: string; idempotency_fingerprint: string }>(
    `select id, idempotency_fingerprint from transaction
      where captured_by = $1 and idempotency_key = $2`,
    [userId, key]
  );
  const row = result.rows[0];
  return row ? { id: row.id, fingerprint: row.idempotency_fingerprint } : null;
}

function parseAmount(amount: string): number {
  let amountCents: number;
  try {
    amountCents = toCents(amount);
  } catch (err) {
    if (err instanceof MoneyError) {
      throw new WithdrawalError('Enter the amount in rupees, e.g. 500.00.');
    }
    throw err;
  }
  if (amountCents <= 0) {
    throw new WithdrawalError('The amount must be more than zero.');
  }
  return amountCents;
}

export interface Source {
  id: string;
  accountTypeId: string;
  status: string;
  memberId: string | null;
  customerId: string | null;
  holderStatus: string;
  typeName: string;
  allowsWithdrawal: boolean;
  allowsTransfer: boolean;
  minimumBalance: string;
  maximumTransactionAmount: string | null;
}

// The account money is to leave, with what the checks need. Shared with a
// transfer's debit leg (S-1504), which meets every check a withdrawal does.
export async function source(accountId: string): Promise<Source> {
  const result = await query<{
    id: string;
    account_type_id: string;
    status: string;
    member_id: string | null;
    customer_id: string | null;
    holder_status: string;
    type_name: string;
    allows_withdrawal: boolean;
    allows_transfer: boolean;
    minimum_balance: string;
    maximum_transaction_amount: string | null;
  }>(
    `select a.id, a.account_type_id, a.status, a.member_id, a.customer_id,
            coalesce(m.status, c.status) as holder_status,
            at.name as type_name, at.allows_withdrawal, at.allows_transfer,
            at.minimum_balance, at.maximum_transaction_amount
       from account a
       join account_type at on at.id = a.account_type_id
       left join member m on m.id = a.member_id
       left join customer c on c.id = a.customer_id
      where a.id = $1`,
    [accountId]
  );
  const r = result.rows[0];
  if (!r) {
    throw new WithdrawalError('That account no longer exists.', 'not_found');
  }
  return {
    id: r.id,
    accountTypeId: r.account_type_id,
    status: r.status,
    memberId: r.member_id,
    customerId: r.customer_id,
    holderStatus: r.holder_status,
    typeName: r.type_name,
    allowsWithdrawal: r.allows_withdrawal,
    allowsTransfer: r.allows_transfer,
    minimumBalance: r.minimum_balance,
    maximumTransactionAmount: r.maximum_transaction_amount,
  };
}

// The checks, in FRD 6.3's order, the first failure named (S-1501). The
// available balance excludes what is already on its way out (S-1502), and a
// transaction being corrected excludes itself from that.
export async function refuseUnlessWithdrawable(
  from: Source,
  amountCents: number,
  excludingTransactionId: string | null = null,
  operation: 'withdrawal' | 'transfer' = 'withdrawal'
): Promise<void> {
  const verb = operation === 'transfer' ? 'transferred' : 'withdrawn';
  if (from.status !== 'active') {
    throw new WithdrawalError(
      `This account is ${from.status}, so nothing can be ${verb} from it.`
    );
  }
  if (operation === 'withdrawal' && !from.allowsWithdrawal) {
    throw new WithdrawalError(`${from.typeName} does not allow withdrawals.`);
  }
  if (operation === 'transfer' && !from.allowsTransfer) {
    throw new WithdrawalError(`${from.typeName} does not allow transfers.`);
  }
  if (from.holderStatus !== 'active') {
    throw new WithdrawalError(
      `This ${from.memberId ? 'member' : 'customer'} is ${from.holderStatus}, ` +
        `so nothing can be ${verb}.`
    );
  }
  const figures = await availableBalance(from.id);
  let availableCents = toCents(figures.available);
  if (excludingTransactionId) {
    const own = await query<{ amount: string; status: string }>(
      `select amount, status from transaction where id = $1`,
      [excludingTransactionId]
    );
    const row = own.rows[0];
    if (row && ['submitted', 'under_review', 'approved'].includes(row.status)) {
      availableCents += toCents(row.amount);
    }
  }
  if (amountCents > availableCents) {
    const pending = toCents(figures.pendingDebits);
    throw new WithdrawalError(
      `Only ${fromCents(availableCents)} is available on this account` +
        (pending > 0
          ? ` (${fromCents(pending)} is already on its way out).`
          : '.')
    );
  }
  const floorCents = toCents(from.minimumBalance);
  if (availableCents - amountCents < floorCents) {
    throw new WithdrawalError(
      `A ${from.typeName} account must keep at least ` +
        `${fromCents(floorCents)}; only ` +
        `${fromCents(Math.max(0, availableCents - floorCents))} can be ${verb}.`
    );
  }
  if (
    from.maximumTransactionAmount !== null &&
    amountCents > toCents(from.maximumTransactionAmount)
  ) {
    throw new WithdrawalError(
      `A ${from.typeName} transaction cannot exceed ` +
        `${fromCents(toCents(from.maximumTransactionAmount))}.`
    );
  }
}

async function checkedMethod(code: string) {
  try {
    return await offeredMethod(code);
  } catch (err) {
    if (err instanceof PaymentError) {
      throw new WithdrawalError('Choose how it is paid out.');
    }
    throw err;
  }
}

export async function recordWithdrawal(
  input: WithdrawalInput,
  principal: Principal
): Promise<Withdrawal> {
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
    const existing = await existingForKey(principal.userId, key);
    if (existing) {
      if (existing.fingerprint !== print) {
        throw new WithdrawalError(
          'A different withdrawal was already submitted with this key.',
          'conflict'
        );
      }
      return (await loadTransaction(existing.id))!;
    }
  }

  const method = await checkedMethod(input.method);
  const from = await source(input.accountId);
  await refuseUnlessWithdrawable(from, amountCents);

  const route = await resolveRoute({
    kind: 'withdrawal',
    accountTypeId: from.accountTypeId,
    amountCents,
    roleCodes: principal.roles,
  });
  if (!route.definition) {
    if (!principal.permissions.has(PERMISSION_POST)) {
      throw new WithdrawalError(
        'You may record a withdrawal but not pay it out. Ask an Account ' +
          'Officer to record it.',
        'forbidden'
      );
    }
    // Paid out now: the reference the method needs, now.
    try {
      requireReference(method, input.methodReference);
    } catch (err) {
      if (err instanceof PaymentError) throw new WithdrawalError(err.message);
      throw err;
    }
  }
  const receipt = route.definition
    ? null
    : await allocateReceiptNumber(principal.userId);

  try {
    const id = await withTransaction(async client => {
      let inserted;
      try {
        inserted = await client.query<{ id: string; reference: string }>(
          `insert into transaction
             (kind, member_id, customer_id, account_id, amount, method,
              method_reference, reason, status, receipt_number_id,
              idempotency_key, idempotency_fingerprint, captured_by)
           values ('withdrawal', $1, $2, $3, $4, $5, $6, $7, 'submitted', $8,
                   $9, $10, $11)
           returning id, reference`,
          [
            from.memberId,
            from.customerId,
            from.id,
            fromCents(amountCents),
            method.code,
            (input.methodReference ?? '').trim() || null,
            (input.reason ?? '').trim() || null,
            receipt?.id ?? null,
            key,
            key ? print : null,
            principal.userId,
          ]
        );
      } catch (err) {
        if (
          (err as { code?: string }).code === '23505' &&
          (err as { constraint?: string }).constraint ===
            'transaction_idempotency_idx'
        ) {
          throw new WithdrawalError(
            'This withdrawal is being recorded.',
            'conflict'
          );
        }
        throw err;
      }
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
          },
        },
        client
      );
      const submission = await submitTransaction(
        client,
        { id, reference, kind: 'withdrawal' },
        route,
        principal
      );
      if (submission.posted && receipt) {
        await markReceiptIssued(receipt.id, client);
      }
      return id;
    });
    if (receipt) await notifyReceiptIssued(id);
    return (await loadTransaction(id))!;
  } catch (err) {
    if (receipt) {
      await abandonReceiptNumber(
        receipt.id,
        err instanceof WithdrawalError || err instanceof LedgerError
          ? err.message
          : 'The withdrawal failed while being recorded.'
      );
    }
    if (err instanceof LedgerError) {
      throw new WithdrawalError(err.message, 'conflict');
    }
    throw err;
  }
}

export type WithdrawalEdit = Omit<WithdrawalInput, 'idempotencyKey'>;

/**
 * S-1404 for a withdrawal: its captor corrects a returned one and sends it
 * back — re-entering at the step that returned it, or re-routed when the
 * amount crossed a band (resubmitTransaction). Every check above runs
 * again on the new figures.
 */
export async function resubmitWithdrawal(
  id: string,
  input: WithdrawalEdit,
  principal: Principal
): Promise<Withdrawal> {
  const withdrawal = await loadTransaction(id);
  if (!withdrawal || withdrawal.kind !== 'withdrawal') {
    throw new WithdrawalError('That withdrawal no longer exists.', 'not_found');
  }
  if (withdrawal.status !== 'returned') {
    throw new WithdrawalError(
      `${withdrawal.reference} is ${withdrawal.status}, so it cannot be changed.`,
      'conflict'
    );
  }
  if (withdrawal.capturedById !== principal.userId) {
    throw new WithdrawalError(
      'Only the officer who recorded this withdrawal can change it.',
      'forbidden'
    );
  }
  if (!principal.permissions.has(PERMISSION_CAPTURE)) {
    throw new WithdrawalError(
      'You do not have permission to record withdrawals.',
      'forbidden'
    );
  }
  const amountCents = parseAmount(input.amount);
  const method = await checkedMethod(input.method);
  const from = await source(input.accountId);
  if (
    from.memberId !==
      (withdrawal.holderKind === 'member' ? withdrawal.holderId : null) ||
    from.customerId !==
      (withdrawal.holderKind === 'customer' ? withdrawal.holderId : null)
  ) {
    throw new WithdrawalError('Choose one of this person’s accounts.');
  }
  await refuseUnlessWithdrawable(from, amountCents, withdrawal.id);

  const route = await resolveRoute({
    kind: 'withdrawal',
    accountTypeId: from.accountTypeId,
    amountCents,
    roleCodes: principal.roles,
  });
  if (!route.definition) {
    if (!principal.permissions.has(PERMISSION_POST)) {
      throw new WithdrawalError(
        'At this amount the withdrawal would be paid out at once, which you ' +
          'may not do. Ask an Account Officer to record it.',
        'forbidden'
      );
    }
    try {
      requireReference(method, input.methodReference);
    } catch (err) {
      if (err instanceof PaymentError) throw new WithdrawalError(err.message);
      throw err;
    }
  }
  const receipt = route.definition
    ? null
    : await allocateReceiptNumber(principal.userId);

  try {
    await withTransaction(async client => {
      await client.query(
        `update transaction
            set account_id = $2, amount = $3, method = $4,
                method_reference = $5, reason = $6, receipt_number_id = $7
          where id = $1`,
        [
          withdrawal.id,
          from.id,
          fromCents(amountCents),
          method.code,
          (input.methodReference ?? '').trim() || null,
          (input.reason ?? '').trim() || null,
          receipt?.id ?? null,
        ]
      );
      await recordAudit(
        {
          actorUserId: principal.userId,
          actorDescription: principal.email,
          action: 'transaction.resubmitted',
          entityType: 'transaction',
          entityId: withdrawal.reference,
          previousValue: {
            account_id: withdrawal.accountId,
            amount: withdrawal.amount,
            method: withdrawal.method,
            method_reference: withdrawal.methodReference || null,
            reason: withdrawal.reason || null,
          },
          newValue: {
            account_id: from.id,
            amount: fromCents(amountCents),
            method: method.code,
            method_reference: (input.methodReference ?? '').trim() || null,
            reason: (input.reason ?? '').trim() || null,
          },
        },
        client
      );
      const submission = await resubmitTransaction(
        client,
        {
          id: withdrawal.id,
          reference: withdrawal.reference,
          kind: 'withdrawal',
          workflowDefinitionId: withdrawal.workflowDefinitionId,
          currentStepCode: withdrawal.currentStepCode,
        },
        route,
        principal
      );
      if (submission.posted && receipt) {
        await markReceiptIssued(receipt.id, client);
      }
    });
    if (receipt) await notifyReceiptIssued(id);
    return (await loadTransaction(id))!;
  } catch (err) {
    if (receipt) {
      await abandonReceiptNumber(
        receipt.id,
        err instanceof WithdrawalError || err instanceof LedgerError
          ? err.message
          : 'The withdrawal failed while being recorded.'
      );
    }
    if (err instanceof LedgerError) {
      throw new WithdrawalError(err.message, 'conflict');
    }
    throw err;
  }
}
