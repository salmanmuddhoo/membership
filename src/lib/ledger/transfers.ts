// Recording a transfer (S-1504, FRD 6.4, open point 5). Schema:
// migrations/0073; docs/ledger.md.
//
// Two legs under one id, never two transactions that happen to match. The
// debit leg on the source meets every check a withdrawal does (S-1501) and
// the type's allows_transfer; the credit leg, when the destination is an
// account on the system, meets a deposit's (S-1305). The debit leg is what
// the matrix routes and the chain reviews: as 'transfer' when the money
// stays with the same holder, as 'withdrawal' when it leaves their control
// (FRD 6.4). A destination with no account here — a non-member, "Other" —
// gets no credit leg: the debit leg names the payee and is paid out through
// the disbursement step (S-1503). post_transaction() posts both legs or
// neither.
import { canTransact } from '../members/status';
import { createHash } from 'node:crypto';
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import type { TransactionKind } from '../config/reference';
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
import { requireBankAccount, resolveBankAccount } from './bank-accounts';
import { LedgerError } from './ledger';
import { notifyReceiptIssued } from './receipt-notifications';
import { loadTransaction, type TransactionSummary } from './review';
import { notifySubmitted } from './transaction-notifications';
import {
  resolveRoute,
  resubmitTransaction,
  submitTransaction,
} from './routing';
import {
  refuseUnlessWithdrawable,
  source,
  WithdrawalError,
} from './withdrawals';

export class TransferError extends Error {
  constructor(
    message: string,
    public readonly reason:
      'invalid' | 'not_found' | 'forbidden' | 'conflict' = 'invalid'
  ) {
    super(message);
    this.name = 'TransferError';
  }
}

export const PERMISSION_CAPTURE = 'transaction.capture';
export const PERMISSION_POST = 'transaction.post';

// The method a leg between two accounts here carries (0073): nothing
// changes hands outside the Society.
export const INTERNAL_METHOD = 'internal_transfer';

export type TransferDestination =
  // An account on the system: the same holder's, another member's, or a
  // customer's.
  | { kind: 'account'; accountId: string }
  // Nobody's account here: who was paid, and how.
  | {
      kind: 'payee';
      payeeName: string;
      method: string;
      methodReference?: string;
      // Which of the Society's bank accounts it is paid from (S-1901).
      bankAccountId?: string;
    };

export interface TransferInput {
  sourceAccountId: string;
  amount: string;
  destination: TransferDestination;
  reason?: string;
  idempotencyKey?: string;
}

export interface Transfer {
  id: string;
  reference: string;
  status: string;
  reason: string;
  // The leg the matrix routed, the chain reviews and the receipt is on.
  debitLeg: TransactionSummary;
  // Null when the destination is a payee with no account here.
  creditLeg: TransactionSummary | null;
}

function fingerprint(input: TransferInput, amountCents: number): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'transfer',
        sourceAccountId: input.sourceAccountId,
        amountCents,
        destination: input.destination,
        reason: (input.reason ?? '').trim(),
      })
    )
    .digest('hex');
}

function parseAmount(amount: string): number {
  let amountCents: number;
  try {
    amountCents = toCents(amount);
  } catch (err) {
    if (err instanceof MoneyError) {
      throw new TransferError('Enter the amount in rupees, e.g. 500.00.');
    }
    throw err;
  }
  if (amountCents <= 0) {
    throw new TransferError('The amount must be more than zero.');
  }
  return amountCents;
}

interface Destination {
  id: string;
  accountTypeId: string;
  status: string;
  memberId: string | null;
  customerId: string | null;
  holderStatus: string;
  typeName: string;
  allowsDeposit: boolean;
  maximumTransactionAmount: string | null;
}

// The account the money is to land on, checked as a deposit checks its
// destination (S-1305).
async function destination(accountId: string): Promise<Destination> {
  const result = await query<{
    id: string;
    account_type_id: string;
    status: string;
    member_id: string | null;
    customer_id: string | null;
    holder_status: string;
    type_name: string;
    allows_deposit: boolean;
    maximum_transaction_amount: string | null;
  }>(
    `select a.id, a.account_type_id, a.status, a.member_id, a.customer_id,
            coalesce(m.status, c.status) as holder_status,
            at.name as type_name, at.allows_deposit,
            at.maximum_transaction_amount
       from account a
       join account_type at on at.id = a.account_type_id
       left join member m on m.id = a.member_id
       left join customer c on c.id = a.customer_id
      where a.id = $1`,
    [accountId]
  );
  const r = result.rows[0];
  if (!r) {
    throw new TransferError(
      'That destination account no longer exists.',
      'not_found'
    );
  }
  return {
    id: r.id,
    accountTypeId: r.account_type_id,
    status: r.status,
    memberId: r.member_id,
    customerId: r.customer_id,
    holderStatus: r.holder_status,
    typeName: r.type_name,
    allowsDeposit: r.allows_deposit,
    maximumTransactionAmount: r.maximum_transaction_amount,
  };
}

function refuseUnlessCreditable(to: Destination, amountCents: number): void {
  if (!canTransact(to.holderStatus)) {
    throw new TransferError(
      `The ${to.memberId ? 'member' : 'customer'} receiving it is ` +
        `${to.holderStatus}, so nothing can be transferred to them.`
    );
  }
  if (to.status !== 'active') {
    throw new TransferError(
      `The destination account is ${to.status}, so nothing can be transferred to it.`
    );
  }
  if (!to.allowsDeposit) {
    throw new TransferError(`${to.typeName} does not accept transfers in.`);
  }
  if (
    to.maximumTransactionAmount !== null &&
    amountCents > toCents(to.maximumTransactionAmount)
  ) {
    throw new TransferError(
      `A ${to.typeName} transaction cannot exceed ` +
        `${fromCents(toCents(to.maximumTransactionAmount))}.`
    );
  }
}

// Which rules of the matrix a transfer falls under (FRD 6.4): its own when
// the money stays with the same holder; a withdrawal's when it leaves
// their control — another person's account, or a payee with none.
function matrixKind(
  from: { memberId: string | null; customerId: string | null },
  to: { memberId: string | null; customerId: string | null } | null
): TransactionKind {
  const own =
    to !== null &&
    to.memberId === from.memberId &&
    to.customerId === from.customerId;
  return own ? 'transfer' : 'withdrawal';
}

export async function loadTransfer(id: string): Promise<Transfer | null> {
  const result = await query<{
    id: string;
    reference: string;
    status: string;
    reason: string;
    debit_id: string;
    credit_id: string | null;
  }>(
    `select tr.id, tr.reference, tr.status, coalesce(tr.reason, '') as reason,
            d.id as debit_id, c.id as credit_id
       from transfer tr
       join transaction d on d.transfer_id = tr.id and d.leg_direction = 'debit'
       left join transaction c on c.transfer_id = tr.id and c.leg_direction = 'credit'
      where tr.id = $1`,
    [id]
  );
  const r = result.rows[0];
  if (!r) return null;
  const [debitLeg, creditLeg] = await Promise.all([
    loadTransaction(r.debit_id),
    r.credit_id ? loadTransaction(r.credit_id) : Promise.resolve(null),
  ]);
  return {
    id: r.id,
    reference: r.reference,
    status: r.status,
    reason: r.reason,
    debitLeg: debitLeg!,
    creditLeg,
  };
}

async function existingForKey(
  userId: string,
  key: string
): Promise<{ transferId: string | null; fingerprint: string } | null> {
  const result = await query<{
    transfer_id: string | null;
    idempotency_fingerprint: string;
  }>(
    `select transfer_id, idempotency_fingerprint from transaction
      where captured_by = $1 and idempotency_key = $2`,
    [userId, key]
  );
  const row = result.rows[0];
  return row
    ? { transferId: row.transfer_id, fingerprint: row.idempotency_fingerprint }
    : null;
}

async function paidBy(destination: TransferDestination, postsNow: boolean) {
  if (destination.kind === 'account') {
    return {
      code: INTERNAL_METHOD,
      reference: null,
      payeeName: null,
      bankAccountId: null,
    };
  }
  const payeeName = destination.payeeName.trim();
  if (!payeeName) throw new TransferError('Say who the money goes to.');
  const bankAccountId = await resolveBankAccount(
    destination.bankAccountId,
    message => new TransferError(message)
  );
  try {
    const method = await offeredMethod(destination.method);
    if (postsNow) {
      requireReference(method, destination.methodReference);
      requireBankAccount(
        method,
        bankAccountId,
        message => new TransferError(message)
      );
    }
    return {
      code: method.code,
      reference: (destination.methodReference ?? '').trim() || null,
      payeeName,
      bankAccountId,
    };
  } catch (err) {
    if (err instanceof PaymentError) {
      throw new TransferError(
        destination.method ? err.message : 'Choose how it is paid out.'
      );
    }
    throw err;
  }
}

export async function recordTransfer(
  input: TransferInput,
  principal: Principal
): Promise<Transfer> {
  if (!principal.permissions.has(PERMISSION_CAPTURE)) {
    throw new TransferError(
      'You do not have permission to record transfers.',
      'forbidden'
    );
  }
  const amountCents = parseAmount(input.amount);

  const key = input.idempotencyKey?.trim() || null;
  const print = fingerprint(input, amountCents);
  if (key) {
    const existing = await existingForKey(principal.userId, key);
    if (existing) {
      if (existing.fingerprint !== print || !existing.transferId) {
        throw new TransferError(
          'A different transfer was already submitted with this key.',
          'conflict'
        );
      }
      return (await loadTransfer(existing.transferId))!;
    }
  }

  const from = await source(input.sourceAccountId).catch(err => {
    if (err instanceof WithdrawalError) {
      throw new TransferError(
        'That source account no longer exists.',
        'not_found'
      );
    }
    throw err;
  });
  let to: Destination | null = null;
  if (input.destination.kind === 'account') {
    if (input.destination.accountId === from.id) {
      throw new TransferError('Choose a different account to transfer to.');
    }
    to = await destination(input.destination.accountId);
  }
  try {
    await refuseUnlessWithdrawable(from, amountCents, null, 'transfer');
  } catch (err) {
    if (err instanceof WithdrawalError) throw new TransferError(err.message);
    throw err;
  }
  if (to) refuseUnlessCreditable(to, amountCents);

  const kind = matrixKind(from, to);
  const route = await resolveRoute({
    kind,
    accountTypeId: from.accountTypeId,
    amountCents,
    roleCodes: principal.roles,
  });
  if (!route.definition && !principal.permissions.has(PERMISSION_POST)) {
    throw new TransferError(
      'You may record a transfer but not post it. Ask an Account Officer to ' +
        'record it.',
      'forbidden'
    );
  }
  const paid = await paidBy(input.destination, !route.definition);
  const receipt = route.definition
    ? null
    : await allocateReceiptNumber(principal.userId);

  try {
    const transferId = await withTransaction(async client => {
      const transfer = await client.query<{ id: string; reference: string }>(
        `insert into transfer (member_id, customer_id, reason, captured_by)
         values ($1, $2, $3, $4) returning id, reference`,
        [
          from.memberId,
          from.customerId,
          (input.reason ?? '').trim() || null,
          principal.userId,
        ]
      );
      const { id: transferId, reference: transferReference } = transfer.rows[0];
      let debit;
      try {
        debit = await client.query<{ id: string; reference: string }>(
          `insert into transaction
             (kind, member_id, customer_id, account_id, amount, method,
              method_reference, reason, status, receipt_number_id,
              idempotency_key, idempotency_fingerprint, captured_by,
              transfer_id, leg_direction, payee_name, bank_account_id)
           values ('transfer_leg', $1, $2, $3, $4, $5, $6, $7, 'submitted', $8,
                   $9, $10, $11, $12, 'debit', $13, $14)
           returning id, reference`,
          [
            from.memberId,
            from.customerId,
            from.id,
            fromCents(amountCents),
            paid.code,
            paid.reference,
            (input.reason ?? '').trim() || null,
            receipt?.id ?? null,
            key,
            key ? print : null,
            principal.userId,
            transferId,
            paid.payeeName,
            paid.bankAccountId,
          ]
        );
      } catch (err) {
        if (
          (err as { code?: string }).code === '23505' &&
          (err as { constraint?: string }).constraint ===
            'transaction_idempotency_idx'
        ) {
          throw new TransferError(
            'This transfer is being recorded.',
            'conflict'
          );
        }
        throw err;
      }
      const { id: debitId, reference: debitReference } = debit.rows[0];
      if (to) {
        await client.query(
          `insert into transaction
             (kind, member_id, customer_id, account_id, amount, method,
              reason, status, captured_by, transfer_id, leg_direction)
           values ('transfer_leg', $1, $2, $3, $4, $5, $6, 'submitted', $7,
                   $8, 'credit')`,
          [
            to.memberId,
            to.customerId,
            to.id,
            fromCents(amountCents),
            INTERNAL_METHOD,
            (input.reason ?? '').trim() || null,
            principal.userId,
            transferId,
          ]
        );
      }
      await recordAudit(
        {
          actorUserId: principal.userId,
          actorDescription: principal.email,
          action: 'transaction.captured',
          entityType: 'transaction',
          entityId: debitReference,
          newValue: {
            kind: 'transfer_leg',
            transfer: transferReference,
            matrix_kind: kind,
            from_account_id: from.id,
            to_account_id: to?.id ?? null,
            payee_name: paid.payeeName,
            amount: fromCents(amountCents),
            method: paid.code,
          },
        },
        client
      );
      const submission = await submitTransaction(
        client,
        { id: debitId, reference: debitReference, kind },
        route,
        principal
      );
      if (!submission.posted) {
        await client.query(
          `update transfer set status = 'submitted' where id = $1`,
          [transferId]
        );
      } else if (receipt) {
        await markReceiptIssued(receipt.id, client);
      }
      return transferId;
    });
    const made = (await loadTransfer(transferId))!;
    if (receipt) await notifyReceiptIssued(made.debitLeg.id);
    // Both holders hear of a posted transfer; a chain's first step hears
    // it is waiting (S-1803, S-1804).
    await notifySubmitted([made.debitLeg, made.creditLeg], {
      byUserId: principal.userId,
    });
    return made;
  } catch (err) {
    if (receipt) {
      await abandonReceiptNumber(
        receipt.id,
        err instanceof TransferError || err instanceof LedgerError
          ? err.message
          : 'The transfer failed while being recorded.'
      );
    }
    if (err instanceof LedgerError) {
      throw new TransferError(err.message, 'conflict');
    }
    throw err;
  }
}

export interface TransferEdit {
  amount: string;
  reason?: string;
  // For a payee leg only: how it is to be paid out, and from which of the
  // Society's bank accounts (S-1902).
  method?: string;
  methodReference?: string;
  bankAccountId?: string;
}

/**
 * S-1404 for a transfer: its captor corrects a returned one — the amount,
 * the note, and for a payee the method — and sends it back. The accounts
 * stay: a different destination is a different transfer. Both legs take
 * the new amount, every check runs again, and routing decides where it
 * re-enters (resubmitTransaction).
 */
export async function resubmitTransfer(
  debitLegId: string,
  input: TransferEdit,
  principal: Principal
): Promise<Transfer> {
  const leg = await loadTransaction(debitLegId);
  if (!leg || leg.kind !== 'transfer_leg' || leg.legDirection !== 'debit') {
    throw new TransferError('That transfer no longer exists.', 'not_found');
  }
  if (leg.status !== 'returned') {
    throw new TransferError(
      `${leg.transferReference} is ${leg.status}, so it cannot be changed.`,
      'conflict'
    );
  }
  if (leg.capturedById !== principal.userId) {
    throw new TransferError(
      'Only the officer who recorded this transfer can change it.',
      'forbidden'
    );
  }
  if (!principal.permissions.has(PERMISSION_CAPTURE)) {
    throw new TransferError(
      'You do not have permission to record transfers.',
      'forbidden'
    );
  }
  const amountCents = parseAmount(input.amount);
  const from = await source(leg.accountId);
  const to = leg.counterpartAccountId
    ? await destination(leg.counterpartAccountId)
    : null;
  try {
    await refuseUnlessWithdrawable(from, amountCents, leg.id, 'transfer');
  } catch (err) {
    if (err instanceof WithdrawalError) throw new TransferError(err.message);
    throw err;
  }
  if (to) refuseUnlessCreditable(to, amountCents);

  const kind = matrixKind(from, to);
  const route = await resolveRoute({
    kind,
    accountTypeId: from.accountTypeId,
    amountCents,
    roleCodes: principal.roles,
  });
  if (!route.definition && !principal.permissions.has(PERMISSION_POST)) {
    throw new TransferError(
      'At this amount the transfer would post at once, which you may not ' +
        'do. Ask an Account Officer to record it.',
      'forbidden'
    );
  }
  const paid = await paidBy(
    to
      ? { kind: 'account', accountId: to.id }
      : {
          kind: 'payee',
          payeeName: leg.payeeName ?? '',
          method: input.method ?? leg.method,
          methodReference: input.methodReference ?? leg.methodReference,
          bankAccountId: input.bankAccountId ?? leg.bankAccountId ?? undefined,
        },
    !route.definition
  );
  const receipt = route.definition
    ? null
    : await allocateReceiptNumber(principal.userId);

  try {
    await withTransaction(async client => {
      await client.query(
        `update transaction
            set amount = $2, method = $3, method_reference = $4, reason = $5,
                receipt_number_id = $6, bank_account_id = $7
          where id = $1`,
        [
          leg.id,
          fromCents(amountCents),
          paid.code,
          paid.reference,
          (input.reason ?? '').trim() || null,
          receipt?.id ?? null,
          paid.bankAccountId,
        ]
      );
      await client.query(
        `update transaction set amount = $2, reason = $3
          where transfer_id = $1 and leg_direction = 'credit'`,
        [
          leg.transferId,
          fromCents(amountCents),
          (input.reason ?? '').trim() || null,
        ]
      );
      await client.query(`update transfer set reason = $2 where id = $1`, [
        leg.transferId,
        (input.reason ?? '').trim() || null,
      ]);
      await recordAudit(
        {
          actorUserId: principal.userId,
          actorDescription: principal.email,
          action: 'transaction.resubmitted',
          entityType: 'transaction',
          entityId: leg.reference,
          previousValue: {
            amount: leg.amount,
            method: leg.method,
            method_reference: leg.methodReference || null,
            reason: leg.reason || null,
          },
          newValue: {
            amount: fromCents(amountCents),
            method: paid.code,
            method_reference: paid.reference,
            reason: (input.reason ?? '').trim() || null,
          },
        },
        client
      );
      const submission = await resubmitTransaction(
        client,
        {
          id: leg.id,
          reference: leg.reference,
          kind,
          workflowDefinitionId: leg.workflowDefinitionId,
          currentStepCode: leg.currentStepCode,
        },
        route,
        principal
      );
      if (submission.posted) {
        if (receipt) await markReceiptIssued(receipt.id, client);
      } else {
        await client.query(
          `update transfer set status = (select status from transaction where id = $2)
            where id = $1`,
          [leg.transferId, leg.id]
        );
      }
    });
    if (receipt) await notifyReceiptIssued(leg.id);
    const made = (await loadTransfer(leg.transferId!))!;
    await notifySubmitted([made.debitLeg, made.creditLeg], {
      byUserId: principal.userId,
      resubmitted: true,
    });
    return made;
  } catch (err) {
    if (receipt) {
      await abandonReceiptNumber(
        receipt.id,
        err instanceof TransferError || err instanceof LedgerError
          ? err.message
          : 'The transfer failed while being recorded.'
      );
    }
    if (err instanceof LedgerError) {
      throw new TransferError(err.message, 'conflict');
    }
    throw err;
  }
}
