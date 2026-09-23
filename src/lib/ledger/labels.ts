// What a transaction's status is called on screen, by kind (officer
// direction): money paid out is "disbursed", not "posted" — a withdrawal,
// a transfer to a payee — and an exit ends as it is: closed, resigned,
// settled. Money in posts.
export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  approved: 'Approved',
  posted: 'Posted',
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
  switch (transaction.kind) {
    case 'closure':
      return 'Closed';
    case 'resignation':
      return 'Resigned';
    case 'demise':
      return 'Settled';
    default:
      return paysOut(transaction) ? 'Disbursed' : 'Posted';
  }
}

/** The last step of the chevron, by kind: Posted, or Disbursement. */
export function finalStepLabel(transaction: {
  kind: string;
  payeeName?: string | null;
}): string {
  return paysOut(transaction) ? 'Disbursement' : 'Posted';
}
