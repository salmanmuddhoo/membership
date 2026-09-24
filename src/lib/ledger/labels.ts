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
}): string {
  if (transaction.status !== 'posted') {
    return STATUS_LABELS[transaction.status] ?? transaction.status;
  }
  // Every finished transaction reads Disbursed, regardless of kind
  // (business decision) — deposits and internal transfers included.
  return 'Disbursed';
}

/** The last step of the chevron, for every transaction: Disbursement. */
export function finalStepLabel(_transaction: {
  kind: string;
  payeeName?: string | null;
}): string {
  return 'Disbursement';
}
