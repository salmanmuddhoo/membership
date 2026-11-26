import { formatMoney } from '../payments/money';
import type { TransactionSummary } from './review';

// What a transaction's status is called on screen: every finished
// transaction reads "Disbursed", not "Posted" (business decision) — a
// withdrawal, a transfer, a deposit, a closure, a resignation, a claim.
export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  approved: 'Approved',
  posted: 'Disbursed',
  returned: 'Returned',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export function paysOut(transaction: {
  kind: string;
  payeeName?: string | null;
}): boolean {
  return (
    transaction.kind === 'withdrawal' ||
    transaction.kind === 'closure' ||
    transaction.kind === 'resignation' ||
    transaction.kind === 'demise' ||
    (transaction.kind === 'transfer_leg' && !!transaction.payeeName)
  );
}

export function transactionStatusLabel(transaction: {
  kind: string;
  status: string;
  payeeName?: string | null;
  feeApplicationId?: string | null;
}): string {
  if (transaction.status !== 'posted') {
    return STATUS_LABELS[transaction.status] ?? transaction.status;
  }
  return recordedLabel(transaction) ?? 'Disbursed';
}

/**
 * What a finished deposit or transfer is called (officer direction): money
 * that arrived or moved is recorded, not disbursed. Null for everything
 * else, which reads Disbursed.
 */
export function recordedLabel(transaction: {
  kind: string;
  feeApplicationId?: string | null;
}): string | null {
  if (transaction.kind === 'deposit') return 'Deposit recorded';
  // A transfer paying a new member's fees is disbursed by the Treasurer
  // (officer direction), and reads so.
  if (transaction.feeApplicationId) return null;
  if (transaction.kind === 'transfer_leg') return 'Transfer recorded';
  return null;
}

/**
 * The last step of the chevron: Deposit recorded or Transfer recorded for
 * those, Disbursement for everything else.
 */
export function finalStepLabel(transaction: {
  kind: string;
  payeeName?: string | null;
  feeApplicationId?: string | null;
}): string {
  return recordedLabel(transaction) ?? 'Disbursement';
}

/** Where a transfer paying a new member's fees went: the application. */
export function feeDestination(t: {
  feeApplicationReference?: string | null;
  feeApplicantName?: string | null;
}): string | null {
  if (!t.feeApplicationReference) return null;
  return ['Membership fees', t.feeApplicationReference, t.feeApplicantName]
    .filter(Boolean)
    .join(' · ');
}

/**
 * A claim split between nominees (nominee-payouts.ts): who was paid what,
 * one line each with the reference of their own payment. Null for anything
 * paid to one person.
 */
export function paidToEachNominee(
  t: Pick<TransactionSummary, 'payouts' | 'currency'>
): string[] | null {
  if (!t.payouts || t.payouts.length < 2) return null;
  return t.payouts.map(p =>
    [p.name, formatMoney(p.amount, t.currency), p.methodReference]
      .filter(Boolean)
      .join(' · ')
  );
}
