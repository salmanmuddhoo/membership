// Reversing a posted transaction (S-1505, decision 12). Schema:
// migrations/0066, 0074; docs/ledger.md.
//
// A posted transaction is never edited and never deleted. The correction is
// a reversing transaction that names it, posts the opposite direction on the
// same account for the same amount through the engine, and takes its own
// receipt. The original stands, with the reversal beside it on the trail. A
// transfer is reversed whole: one call reverses both legs, in one database
// transaction, so a half-reversed transfer cannot exist.
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { checkSegregation } from '../admin/segregation';
import { query, withTransaction } from '../db/pool';
import {
  abandonReceiptNumber,
  allocateReceiptNumber,
  markReceiptIssued,
} from '../payments/receipts';
import { LedgerError, postTransaction } from './ledger';
import { notifyReceiptIssued } from './receipt-notifications';
import { loadTransaction, type TransactionSummary } from './review';

export class ReversalError extends Error {
  constructor(
    message: string,
    public readonly reason:
      'invalid' | 'not_found' | 'forbidden' | 'conflict' = 'invalid'
  ) {
    super(message);
    this.name = 'ReversalError';
  }
}

// The Treasurer's, as voiding a payment is (0069): undoing money that moved
// is the same act whichever record it sits on.
export const PERMISSION_REVERSE = 'receipt.void';
export const ACTION_REVERSED = 'transaction.reversed';

export interface Reversal {
  // The reversal of the transaction named, and of its other leg when it was
  // a transfer.
  reversals: TransactionSummary[];
}

async function alreadyReversed(transactionId: string): Promise<string | null> {
  const result = await query<{ reference: string }>(
    `select reference from transaction
      where reverses_id = $1 and status = 'posted' limit 1`,
    [transactionId]
  );
  return result.rows[0]?.reference ?? null;
}

/**
 * The posted reversal of a transaction, if it has one — so a page offers
 * Reverse only while there is something left to reverse, and says what
 * reversed it once there is not.
 */
export async function reversalOf(
  transactionId: string
): Promise<{ id: string; reference: string } | null> {
  const result = await query<{ id: string; reference: string }>(
    `select id, reference from transaction
      where reverses_id = $1 and status = 'posted'
      order by created_at limit 1`,
    [transactionId]
  );
  return result.rows[0] ?? null;
}

/**
 * Reverse a posted transaction, with a reason. Both legs of a transfer go
 * together; the receipt is on the reversal of the transaction named.
 */
/** The kinds that close accounts as they pay out, and so are never reversed. */
export const EXIT_KINDS = ['closure', 'resignation', 'demise'] as const;

export async function reverseTransaction(
  id: string,
  input: { reason: string },
  principal: Principal
): Promise<Reversal> {
  if (!principal.permissions.has(PERMISSION_REVERSE)) {
    throw new ReversalError(
      'You do not have permission to reverse transactions.',
      'forbidden'
    );
  }
  const original = await loadTransaction(id);
  if (!original) {
    throw new ReversalError('That transaction no longer exists.', 'not_found');
  }
  if (original.status !== 'posted') {
    throw new ReversalError(
      `${original.reference} is ${original.status}; only a posted transaction can be reversed.`,
      'conflict'
    );
  }
  // An exit closed the accounts it paid out of; there is nothing left for
  // a reversal to put the money back into. Undoing a resignation is a
  // rejoin, and a closed account comes back by being reopened (M26) — both
  // through their own approval chain, not this (QA-04).
  if ((EXIT_KINDS as readonly string[]).includes(original.kind)) {
    throw new ReversalError(
      `${original.reference} closed the accounts it paid out of, so it cannot be reversed.`,
      'conflict'
    );
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new ReversalError('Say why it is being reversed.');
  }
  const done = await alreadyReversed(original.id);
  if (done) {
    throw new ReversalError(
      `${original.reference} was already reversed by ${done}.`,
      'conflict'
    );
  }
  const verdict = await checkSegregation(
    principal.userId,
    'transaction',
    original.reference,
    ACTION_REVERSED
  );
  if (!verdict.allowed) {
    throw new ReversalError(
      verdict.conflict?.description ??
        'You may not reverse a transaction you captured.',
      'forbidden'
    );
  }

  // A transfer is undone whole: the leg named and its other leg.
  const targets: TransactionSummary[] = [original];
  if (original.transferId) {
    const other = await query<{ id: string }>(
      `select id from transaction
        where transfer_id = $1 and id <> $2 and status = 'posted'`,
      [original.transferId, original.id]
    );
    for (const row of other.rows) {
      const leg = await loadTransaction(row.id);
      if (leg) targets.push(leg);
    }
  }

  // Said in words before a receipt number is spent: the ledger itself
  // refuses a closed account too, but names it by its id.
  const closed = await query<{ account_no: string }>(
    `select account_no from account
      where id = any($1::uuid[]) and status = 'closed'
      order by account_no`,
    [targets.map(t => t.accountId)]
  );
  if (closed.rows.length > 0) {
    throw new ReversalError(
      `${original.reference} cannot be reversed: account ${closed.rows.map(r => r.account_no).join(', ')} is closed.`,
      'conflict'
    );
  }

  const receipt = await allocateReceiptNumber(principal.userId);
  const actor = { userId: principal.userId, description: principal.email };
  try {
    const ids = await withTransaction(async client => {
      const created: string[] = [];
      for (const [index, target] of targets.entries()) {
        const inserted = await client.query<{ id: string; reference: string }>(
          `insert into transaction
             (kind, member_id, customer_id, account_id, amount, method,
              method_reference, reason, status, receipt_number_id,
              captured_by, reverses_id, submitted_at, bank_account_id)
           select 'reversal', member_id, customer_id, account_id, amount,
                  method, method_reference, $2, 'submitted', $3, $4, id, now(),
                  bank_account_id
             from transaction where id = $1
           returning id, reference`,
          [target.id, reason, index === 0 ? receipt.id : null, principal.userId]
        );
        const { id: reversalId, reference } = inserted.rows[0];
        await client.query(
          `insert into transaction_transition
             (transaction_id, from_status, to_status, actor_user_id, actor_role, comment)
           values ($1, null, 'submitted', $2, $3, $4)`,
          [
            reversalId,
            principal.userId,
            principal.roleNames.join(', ') || null,
            reason,
          ]
        );
        await postTransaction(reversalId, actor, client);
        await client.query(
          `insert into transaction_transition
             (transaction_id, from_status, to_status, actor_user_id, actor_role)
           values ($1, 'submitted', 'posted', $2, $3)`,
          [reversalId, principal.userId, principal.roleNames.join(', ') || null]
        );
        await recordAudit(
          {
            actorUserId: principal.userId,
            actorDescription: principal.email,
            action: ACTION_REVERSED,
            entityType: 'transaction',
            entityId: target.reference,
            newValue: { reversed_by: reference, reason },
          },
          client
        );
        created.push(reversalId);
      }
      await markReceiptIssued(receipt.id, client);
      return created;
    });
    await notifyReceiptIssued(ids[0]);
    const reversals = await Promise.all(ids.map(id => loadTransaction(id)));
    return { reversals: reversals.filter((r): r is TransactionSummary => !!r) };
  } catch (err) {
    await abandonReceiptNumber(
      receipt.id,
      err instanceof LedgerError
        ? err.message
        : 'The reversal failed while posting.'
    );
    if (err instanceof LedgerError) {
      throw new ReversalError(err.message, 'conflict');
    }
    throw err;
  }
}
