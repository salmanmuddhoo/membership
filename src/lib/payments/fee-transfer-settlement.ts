// The second half of a new member's fees paid by another member's transfer
// (officer request; migration 0126; fee-transfers.ts is the first half).
//
// When the transfer's debit leg posts — at once, or once its chain approves
// and someone records it — the fee receipt is issued against the
// application in the same database transaction, under the system's own
// 'member_transfer' method, with the amounts that were checked when the
// transfer was asked for. A transfer that posted is a payment that stands;
// one that did not post is no payment at all. Kept apart from
// fee-transfers.ts so the posting code in ledger/review.ts can call it
// without importing the request side, which imports review.ts.
import type { PoolClient } from 'pg';
import { query } from '../db/pool';
import { notifyFeeReceiptIssued } from './fee-receipts';
import { toCents } from './money';
import {
  insertFeePayment,
  loadPayment,
  type CheckedFees,
  type FeeLine,
} from './payments';
import type { ReceiptAllocation } from './receipts';

export const FEE_TRANSFER_METHOD = 'member_transfer';

export class FeeTransferError extends Error {
  constructor(
    message: string,
    public readonly reason:
      'invalid' | 'not_found' | 'forbidden' | 'conflict' = 'invalid'
  ) {
    super(message);
    this.name = 'FeeTransferError';
  }
}

export interface FeeTransferRecord {
  id: string;
  applicationId: string;
  transactionId: string;
  feeVersionId: string;
  lines: FeeLine[];
  totalAmount: string;
  varianceReason: string;
  paymentId: string | null;
  requestedBy: string;
  requestedByRole: string;
  requestedByEmail: string;
}

export async function feeTransferForTransaction(
  transactionId: string
): Promise<FeeTransferRecord | null> {
  const result = await query<{
    id: string;
    application_id: string;
    transaction_id: string;
    fee_version_id: string;
    lines: FeeLine[];
    total_amount: string;
    variance_reason: string;
    payment_id: string | null;
    requested_by: string;
    requested_by_role: string;
    requested_by_email: string;
  }>(
    `select ft.id, ft.application_id, ft.transaction_id, ft.fee_version_id,
            ft.lines, ft.total_amount, ft.variance_reason, ft.payment_id, ft.requested_by,
            ft.requested_by_role, u.email as requested_by_email
       from fee_transfer ft
       join app_user u on u.id = ft.requested_by
      where ft.transaction_id = $1`,
    [transactionId]
  );
  const r = result.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    applicationId: r.application_id,
    transactionId: r.transaction_id,
    feeVersionId: r.fee_version_id,
    lines: r.lines,
    totalAmount: r.total_amount,
    varianceReason: r.variance_reason,
    paymentId: r.payment_id,
    requestedBy: r.requested_by,
    requestedByRole: r.requested_by_role,
    requestedByEmail: r.requested_by_email,
  };
}

/**
 * Issue the fee receipt for a fee transfer whose debit leg has just posted,
 * inside the posting's own database transaction. Refuses — and so takes
 * the posting down with it — an application already decided or already
 * receipted: money is not moved for fees nothing can be paid against.
 */
export async function settleFeeTransfer(
  client: PoolClient,
  feeTransfer: FeeTransferRecord,
  allocation: ReceiptAllocation,
  methodReference: string
): Promise<string> {
  if (feeTransfer.paymentId) {
    throw new FeeTransferError(
      'These fees were already receipted.',
      'conflict'
    );
  }
  const application = await client.query<{ status: string }>(
    `select status from membership_application
      where id = $1 for no key update`,
    [feeTransfer.applicationId]
  );
  const status = application.rows[0]?.status;
  if (!status) {
    throw new FeeTransferError(
      'The application these fees are for no longer exists.',
      'not_found'
    );
  }
  if (status === 'approved' || status === 'rejected') {
    throw new FeeTransferError(
      `The application these fees are for was ${status}. Cancel the transfer.`,
      'conflict'
    );
  }

  const totalCents = feeTransfer.lines.reduce(
    (sum, line) => sum + toCents(line.amount),
    0
  );
  const scheduledCents = feeTransfer.lines.reduce(
    (sum, line) => sum + toCents(line.scheduled),
    0
  );
  const fees: CheckedFees = {
    feeVersionId: feeTransfer.feeVersionId,
    lines: feeTransfer.lines,
    totalCents,
    varianceCents: totalCents - scheduledCents,
    varianceReason: feeTransfer.varianceReason,
  };
  const paymentId = await insertFeePayment(client, {
    applicationId: feeTransfer.applicationId,
    allocation,
    fees,
    method: FEE_TRANSFER_METHOD,
    methodReference,
    sourceOfFund: '',
    sourceOfFundFormConfirmed: false,
    receivedAt: null,
    recordedBy: {
      userId: feeTransfer.requestedBy,
      roleNames: feeTransfer.requestedByRole,
      email: feeTransfer.requestedByEmail,
    },
  });
  await client.query(`update fee_transfer set payment_id = $2 where id = $1`, [
    feeTransfer.id,
    paymentId,
  ]);
  return paymentId;
}

/** The fee receipt to the applicant, once committed. Never throws. */
export async function announceFeeReceipt(paymentId: string): Promise<void> {
  try {
    const payment = await loadPayment(paymentId);
    if (payment) await notifyFeeReceiptIssued(payment);
  } catch (err) {
    console.error('[fee-transfer] receipt notification', err);
  }
}
