// A transaction's receipt (S-1601, S-1603, FRD 6.8). Schema: migrations/0017,
// 0068, 0075; docs/ledger.md, docs/payments.md.
//
// The number is taken from the one sequence payments use and issued when
// the money posts (deposits.ts, withdrawals.ts, transfers.ts, review.ts,
// reversals.ts), so a gap means the same thing everywhere. This module is
// the rest of its life: reading it for the sheet, recording a print, and
// voiding it with a reason — which withdraws the number, never the money.
// A posted transaction is corrected by a reversal (reversals.ts); a voided
// receipt says only that this piece of paper is not to be relied on.
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { checkSegregation } from '../admin/segregation';
import { query, withTransaction } from '../db/pool';
import { accountsClosedOnDeath, type AccountClosedOnDeath } from './claimants';
import { loadTransaction, type TransactionSummary } from './review';
import { KIND_WORDS, notifyReceiptVoided } from './void-notifications';
import { depositorForApplication } from '../applications/depositor';

export class ReceiptError extends Error {
  constructor(
    message: string,
    public readonly reason:
      'invalid' | 'not_found' | 'forbidden' | 'conflict' = 'invalid'
  ) {
    super(message);
    this.name = 'ReceiptError';
  }
}

export const PERMISSION_VOID = 'receipt.void';
export const ACTION_VOIDED = 'transaction.voided';

export interface TransactionReceipt {
  transaction: TransactionSummary;
  receiptNumberId: string;
  receiptNo: string;
  state: 'issued' | 'void';
  voidReason: string | null;
  voidedAt: Date | null;
  // Who recorded it, as which role, and who posted it (the same person for a
  // transaction that posted at once).
  capturedByRole: string | null;
  postedByName: string | null;
  // Who handed the money over, where that is not the holder: a Minor's
  // guardian, a Corporate member's contact person (QA-23) — the same rule
  // the fee receipt and the Cash Deposit Form follow (depositorFor). Null
  // for anything but money in, and where it is the holder themselves.
  depositorName: string | null;
  // A closure on a death: every account it closed, with what each paid.
  // Empty for anything else (transaction.claimantKind null).
  accountsClosed: AccountClosedOnDeath[];
}

// By the transaction's id, its receipt number's id, or the receipt number
// itself — whichever a link carries. Null when the transaction has no
// receipt yet (it is on its chain) or does not exist.
export async function loadTransactionReceipt(
  id: string
): Promise<TransactionReceipt | null> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(id);
  const result = await query<{
    transaction_id: string;
    receipt_number_id: string;
    receipt_no: string;
    state: string;
    reason: string | null;
    settled_at: Date | null;
    captured_by_role: string | null;
    posted_by_name: string | null;
  }>(
    `select t.id as transaction_id, r.id as receipt_number_id, r.receipt_no,
            r.state, r.reason, r.settled_at,
            (select tt.actor_role from transaction_transition tt
              where tt.transaction_id = t.id order by tt.id limit 1)
              as captured_by_role,
            pu.display_name as posted_by_name
       from transaction t
       join receipt_number r on r.id = t.receipt_number_id
       left join app_user pu on pu.id = t.posted_by
      where ($1::boolean and (t.id = $2::uuid or r.id = $2::uuid))
         or (not $1::boolean and r.receipt_no = $3::text)`,
    [isUuid, isUuid ? id : null, isUuid ? null : id.trim().toUpperCase()]
  );
  const row = result.rows[0];
  if (!row || (row.state !== 'issued' && row.state !== 'void')) return null;
  const transaction = await loadTransaction(row.transaction_id);
  if (!transaction) return null;
  let depositorName: string | null = null;
  if (transaction.kind === 'deposit' && !transaction.payeeName) {
    const holder = await query<{ application_id: string | null }>(
      `select coalesce(m.application_id, c.application_id) as application_id
         from transaction t
         left join member m on m.id = t.member_id
         left join customer c on c.id = t.customer_id
        where t.id = $1`,
      [transaction.id]
    );
    const depositor = await depositorForApplication(
      holder.rows[0]?.application_id ?? null
    );
    if (depositor.name && depositor.name !== transaction.holderName) {
      depositorName = depositor.name;
    }
  }
  const accountsClosed =
    transaction.kind === 'closure' && transaction.claimantKind
      ? await accountsClosedOnDeath(transaction.id)
      : [];
  return {
    transaction,
    receiptNumberId: row.receipt_number_id,
    receiptNo: row.receipt_no,
    state: row.state,
    voidReason: row.state === 'void' ? row.reason : null,
    voidedAt: row.state === 'void' ? row.settled_at : null,
    capturedByRole: row.captured_by_role,
    postedByName: row.posted_by_name,
    depositorName,
    accountsClosed,
  };
}

export interface PrintHistory {
  count: number;
  firstPrintedAt: Date | null;
  firstPrintedByName: string | null;
}

export async function transactionPrintHistory(
  transactionId: string
): Promise<PrintHistory> {
  const result = await query<{
    n: string;
    first_at: Date | null;
    first_by: string | null;
  }>(
    `select count(*) as n,
            min(p.printed_at) as first_at,
            (select u.display_name
               from receipt_print f
               join app_user u on u.id = f.printed_by
              where f.transaction_id = $1
              order by f.printed_at
              limit 1) as first_by
       from receipt_print p
      where p.transaction_id = $1`,
    [transactionId]
  );
  const row = result.rows[0];
  return {
    count: Number(row.n),
    firstPrintedAt: row.first_at,
    firstPrintedByName: row.first_by,
  };
}

// Recorded when the officer prints, not when the page is opened (S-503).
export async function recordTransactionReceiptPrint(
  transactionId: string,
  principal: Principal
): Promise<void> {
  if (!principal.permissions.has('transaction.view')) {
    throw new ReceiptError(
      'You do not have permission to view transactions.',
      'forbidden'
    );
  }
  await query(
    'insert into receipt_print (transaction_id, printed_by) values ($1, $2)',
    [transactionId, principal.userId]
  );
}

/**
 * S-1603 · Void a transaction's receipt, with a reason. The number is
 * withdrawn and the sequence shows a void; the transaction stays posted —
 * the money moved, and undoing that is a reversal (S-1505). Refused to the
 * officer who captured it (0069's segregation rule).
 */
export async function voidTransactionReceipt(
  transactionId: string,
  reason: string,
  principal: Principal
): Promise<TransactionReceipt> {
  if (!principal.permissions.has(PERMISSION_VOID)) {
    throw new ReceiptError(
      'You do not have permission to void receipts.',
      'forbidden'
    );
  }
  const trimmed = reason.trim();
  if (trimmed === '') {
    throw new ReceiptError('Say why the receipt is being voided.');
  }
  const receipt = await loadTransactionReceipt(transactionId);
  if (!receipt) {
    throw new ReceiptError('That receipt no longer exists.', 'not_found');
  }
  if (receipt.state === 'void') {
    throw new ReceiptError(
      `Receipt ${receipt.receiptNo} is already void.`,
      'conflict'
    );
  }
  const verdict = await checkSegregation(
    principal.userId,
    'transaction',
    receipt.transaction.reference,
    ACTION_VOIDED
  );
  if (!verdict.allowed) {
    throw new ReceiptError(
      `${verdict.conflict!.description} Someone else must void it.`,
      'forbidden'
    );
  }

  await withTransaction(async client => {
    const updated = await client.query(
      `update receipt_number
          set state = 'void', settled_at = now(), reason = $2
        where id = $1 and state = 'issued'`,
      [receipt.receiptNumberId, trimmed.slice(0, 500)]
    );
    if (updated.rowCount === 0) {
      throw new ReceiptError(
        `Receipt ${receipt.receiptNo} is already void.`,
        'conflict'
      );
    }
    await client.query(
      `insert into financial_event (event_type, transaction_id, receipt_no, payload)
       values ('transaction.voided', $1, $2, $3)`,
      [
        receipt.transaction.id,
        receipt.receiptNo,
        JSON.stringify({
          reference: receipt.transaction.reference,
          kind: receipt.transaction.kind,
          account_id: receipt.transaction.accountId,
          amount: receipt.transaction.amount,
          currency: receipt.transaction.currency,
          receipt_no: receipt.receiptNo,
          reason: trimmed,
          voided_by: principal.email,
        }),
      ]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: ACTION_VOIDED,
        entityType: 'transaction',
        entityId: receipt.transaction.reference,
        previousValue: { receipt_no: receipt.receiptNo, state: 'issued' },
        newValue: { state: 'void', reason: trimmed },
      },
      client
    );
  });
  const voided = (await loadTransactionReceipt(transactionId))!;
  // Whoever else may void hears of it (S-1805).
  const t = voided.transaction;
  await notifyReceiptVoided({
    receiptNo: voided.receiptNo,
    reference: t.transferReference ?? t.reference,
    kind: KIND_WORDS[t.kind] ?? t.kind,
    memberName: t.holderName,
    amount: t.amount,
    currency: t.currency,
    account: `${t.accountNo} · ${t.accountTypeName}`,
    reason: trimmed,
    voidedBy: { userId: principal.userId, name: principal.displayName },
    path: `/receipts/${t.id}`,
    entityType: 'transaction',
    entityId: t.id,
  });
  return voided;
}
