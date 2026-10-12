// A new member's fees paid by another member (officer request; migration
// 0126). On the Payments step of a membership application, the entrance
// fee, Takaful and Shares are paid from an existing member's account — any
// of their accounts, Shares included — instead of at the counter.
//
// It is a transfer, and goes where every transfer goes: a debit leg on the
// paying account, routed by the matrix's Transfer bands and reviewed by its
// chain (officer answer: "through the transfer approval chain"). There is no
// credit leg — the applicant has no account yet — so nothing is disbursed;
// whoever records transfers posts it once approved, and the fee receipt is
// issued then (fee-transfer-settlement.ts). Until it posts the fees are not
// paid and the application cannot be submitted. The whole payment goes one
// way (officer answer): no part cash, part transfer.
//
// The paying account meets every check a transfer's source does — active,
// the holder able to transact, a guardian present, the available balance,
// the type's floor and its transaction ceiling — save the type's
// allows_transfer flag: Shares do not move between members' accounts, but
// they may pay a new member's fees (officer answer), still above the floor.
import type { PoolClient } from 'pg';
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { query, withTransaction } from '../db/pool';
import { LedgerError } from '../ledger/ledger';
import { notifyReceiptIssued } from '../ledger/receipt-notifications';
import { loadTransaction } from '../ledger/review';
import { resolveRoute, submitTransaction } from '../ledger/routing';
import { notifySubmitted } from '../ledger/transaction-notifications';
import {
  INTERNAL_METHOD,
  PERMISSION_CAPTURE,
  PERMISSION_RECORD,
} from '../ledger/transfers';
import {
  refuseUnlessWithdrawable,
  source,
  WithdrawalError,
} from '../ledger/withdrawals';
import {
  announceFeeReceipt,
  FeeTransferError,
  feeTransferForTransaction,
  settleFeeTransfer,
} from './fee-transfer-settlement';
import { fromCents } from './money';
import {
  checkFeeAmounts,
  liveFeeTransferFor,
  liveReceiptFor,
  PaymentError,
  refuseUnlessUndecided,
} from './payments';
import type { FeeComponentCode } from '../config/reference';
import {
  abandonReceiptNumber,
  allocateReceiptNumber,
  markReceiptIssued,
} from './receipts';

export { FeeTransferError } from './fee-transfer-settlement';

export const PERMISSION_RECORD_PAYMENT = 'payment.record';

export interface FeeTransferInput {
  applicationId: string;
  payerAccountId: string;
  amounts: Partial<Record<FeeComponentCode, string>>;
  varianceReason?: string;
}

export interface FeeTransferOutcome {
  transactionId: string;
  reference: string;
  // Posted at once (no chain for this amount): the fee receipt is issued.
  receiptNo: string | null;
}

// What the Payments step shows while a transfer is paying the fees.
export interface PendingFeeTransfer {
  transactionId: string;
  reference: string;
  status: string;
  amount: string;
  payerName: string;
  payerAccountNo: string;
  payerAccountTypeName: string;
  currentStepRole: string | null;
}

export async function pendingFeeTransfer(
  applicationId: string
): Promise<PendingFeeTransfer | null> {
  const live = await liveFeeTransferFor(applicationId);
  if (!live) return null;
  const leg = await loadTransaction(live.transactionId);
  if (!leg) return null;
  return {
    transactionId: leg.id,
    reference: leg.displayReference,
    status: leg.status,
    amount: leg.amount,
    payerName: leg.holderName,
    payerAccountNo: leg.accountNo,
    payerAccountTypeName: leg.accountTypeName,
    currentStepRole: leg.currentStepRole,
  };
}

function asPaymentError(err: unknown): never {
  if (err instanceof WithdrawalError) {
    throw new PaymentError(
      err.message,
      err.reason === 'not_found' ? 'not_found' : 'invalid'
    );
  }
  if (err instanceof FeeTransferError || err instanceof LedgerError) {
    throw new PaymentError(err.message, 'conflict');
  }
  throw err;
}

export async function requestFeeTransfer(
  input: FeeTransferInput,
  principal: Principal
): Promise<FeeTransferOutcome> {
  if (
    !principal.permissions.has(PERMISSION_RECORD_PAYMENT) ||
    !principal.permissions.has(PERMISSION_CAPTURE)
  ) {
    throw new PaymentError(
      'You do not have permission to take fees by transfer.',
      'forbidden'
    );
  }

  const application = await query<{
    reference: string;
    application_kind: string;
    applicant_name: string;
  }>(
    `select a.reference, a.application_kind,
            trim(coalesce(p.values->>'name', '') || ' '
                 || coalesce(p.values->>'surname', '')) as applicant_name
       from membership_application a
       left join application_party p
         on p.application_id = a.id and p.subject = 'applicant'
        and p.ordinal = 1
      where a.id = $1`,
    [input.applicationId]
  );
  const app = application.rows[0];
  if (!app) {
    throw new PaymentError('That application no longer exists.', 'not_found');
  }
  if (app.application_kind !== 'membership') {
    throw new PaymentError(
      'Fees by transfer are taken only on a membership application.'
    );
  }
  await refuseUnlessUndecided(input.applicationId);
  const fees = await checkFeeAmounts(
    input.applicationId,
    input.amounts,
    input.varianceReason
  );

  const receipted = await liveReceiptFor(input.applicationId);
  if (receipted) {
    throw new PaymentError(
      `This application was already receipted as ${receipted}.`,
      'conflict'
    );
  }
  const live = await liveFeeTransferFor(input.applicationId);
  if (live) {
    throw new PaymentError(
      `Transfer ${live.reference} is already paying these fees.`,
      'conflict'
    );
  }

  if (!input.payerAccountId) {
    throw new PaymentError('Choose the account the fees are paid from.');
  }
  const from = await source(input.payerAccountId).catch(asPaymentError);
  if (!from.memberId) {
    throw new PaymentError('Choose an account held by a member.');
  }
  // Shares included (officer answer): allows_transfer is the rule for
  // transfers between accounts, not for a new member's fees. Every other
  // check, the floor among them, holds.
  await refuseUnlessWithdrawable(
    { ...from, allowsTransfer: true },
    fees.totalCents,
    null,
    'transfer'
  ).catch(asPaymentError);

  const route = await resolveRoute({
    kind: 'transfer',
    accountTypeId: from.accountTypeId,
    amountCents: fees.totalCents,
    roleCodes: principal.roles,
  });
  if (!route.definition && !principal.permissions.has(PERMISSION_RECORD)) {
    throw new PaymentError(
      'You may start a transfer but not record it. Ask someone who records ' +
        'transfers to take these fees.',
      'forbidden'
    );
  }

  // Posted at once: both receipts — the paying member's for the transfer,
  // the applicant's for the fees — are numbered before anything is written,
  // as every receipt is (S-502).
  const transferReceipt = route.definition
    ? null
    : await allocateReceiptNumber(principal.userId);
  const feeReceipt = route.definition
    ? null
    : await allocateReceiptNumber(principal.userId);
  const reason = `Membership fees · ${app.reference}${
    app.applicant_name ? ` · ${app.applicant_name}` : ''
  }`;

  let paymentId: string | null = null;
  try {
    const debitId = await withTransaction(async client => {
      // Locked, then asked again: two officers cannot each start a
      // transfer, or one a transfer and another a cash receipt.
      await client.query(
        `select id from membership_application where id = $1 for no key update`,
        [input.applicationId]
      );
      const taken = await client.query(
        `select 1 from payment
          where application_id = $1 and kind = 'payment' and voided_at is null
         union all
         select 1 from fee_transfer ft
           join transaction t on t.id = ft.transaction_id
          where ft.application_id = $1 and ft.payment_id is null
            and t.status in ('submitted', 'under_review', 'approved', 'returned')`,
        [input.applicationId]
      );
      if ((taken.rowCount ?? 0) > 0) {
        throw new PaymentError(
          'These fees have just been taken by someone else.',
          'conflict'
        );
      }

      const transfer = await client.query<{ id: string; reference: string }>(
        `insert into transfer (member_id, customer_id, reason, captured_by)
         values ($1, null, $2, $3) returning id, reference`,
        [from.memberId, reason, principal.userId]
      );
      const { id: transferId, reference: transferReference } = transfer.rows[0];
      const debit = await client.query<{ id: string; reference: string }>(
        `insert into transaction
           (kind, member_id, account_id, amount, method, reason, status,
            receipt_number_id, captured_by, transfer_id, leg_direction)
         values ('transfer_leg', $1, $2, $3, $4, $5, 'submitted', $6, $7, $8,
                 'debit')
         returning id, reference`,
        [
          from.memberId,
          from.id,
          fromCents(fees.totalCents),
          INTERNAL_METHOD,
          reason,
          transferReceipt?.id ?? null,
          principal.userId,
          transferId,
        ]
      );
      const { id: legId, reference: legReference } = debit.rows[0];
      await client.query(
        `insert into fee_transfer
           (application_id, transaction_id, fee_version_id, lines,
            total_amount, variance_reason, requested_by, requested_by_role)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
        [
          input.applicationId,
          legId,
          fees.feeVersionId,
          JSON.stringify(fees.lines),
          fromCents(fees.totalCents),
          fees.varianceReason,
          principal.userId,
          principal.roleNames.join(', '),
        ]
      );
      await recordAudit(
        {
          actorUserId: principal.userId,
          actorDescription: principal.email,
          action: 'transaction.captured',
          entityType: 'transaction',
          entityId: legReference,
          newValue: {
            kind: 'transfer_leg',
            transfer: transferReference,
            matrix_kind: 'transfer',
            from_account_id: from.id,
            fees_for_application: app.reference,
            amount: fromCents(fees.totalCents),
            method: INTERNAL_METHOD,
          },
        },
        client
      );
      const submission = await submitTransaction(
        client,
        { id: legId, reference: legReference, kind: 'transfer' },
        route,
        principal
      );
      if (!submission.posted) {
        await client.query(
          `update transfer set status = 'submitted' where id = $1`,
          [transferId]
        );
      } else {
        await markReceiptIssued(transferReceipt!.id, client);
        const record = await client.query<{ id: string }>(
          `select id from fee_transfer where transaction_id = $1`,
          [legId]
        );
        paymentId = await settleFeeTransfer(
          client,
          {
            id: record.rows[0].id,
            applicationId: input.applicationId,
            transactionId: legId,
            feeVersionId: fees.feeVersionId,
            lines: fees.lines,
            totalAmount: fromCents(fees.totalCents),
            varianceReason: fees.varianceReason,
            paymentId: null,
            requestedBy: principal.userId,
            requestedByRole: principal.roleNames.join(', '),
            requestedByEmail: principal.email,
          },
          feeReceipt!,
          await feeReceiptReference(client, transferReference, from.memberId!)
        );
      }
      return legId;
    });

    const leg = (await loadTransaction(debitId))!;
    if (transferReceipt) await notifyReceiptIssued(debitId);
    await notifySubmitted([leg, null], { byUserId: principal.userId });
    if (paymentId) await announceFeeReceipt(paymentId);
    return {
      transactionId: debitId,
      reference: leg.displayReference,
      receiptNo: paymentId ? feeReceipt!.receiptNo : null,
    };
  } catch (err) {
    const why =
      err instanceof PaymentError ||
      err instanceof FeeTransferError ||
      err instanceof LedgerError
        ? err.message
        : 'The transfer failed while being recorded.';
    if (transferReceipt) await abandonReceiptNumber(transferReceipt.id, why);
    if (feeReceipt) await abandonReceiptNumber(feeReceipt.id, why);
    return asPaymentError(err);
  }
}

// What the fee receipt says the payment was: the transfer, and whose.
export async function feeReceiptReference(
  client: PoolClient,
  transferReference: string,
  memberId: string
): Promise<string> {
  const member = await client.query<{ member_no: string }>(
    `select member_no from member where id = $1`,
    [memberId]
  );
  const memberNo = member.rows[0]?.member_no;
  return memberNo ? `${transferReference} · ${memberNo}` : transferReference;
}

/**
 * Stop a transfer paying an application's fees before it posts — the payer
 * changed their mind, a reviewer returned it, or the fees are to be paid
 * another way. Nothing has moved, so nothing is undone; the Payments step
 * is open again.
 */
export async function cancelFeeTransfer(
  applicationId: string,
  principal: Principal
): Promise<string> {
  if (!principal.permissions.has(PERMISSION_RECORD_PAYMENT)) {
    throw new PaymentError(
      'You do not have permission to take fees.',
      'forbidden'
    );
  }
  const live = await liveFeeTransferFor(applicationId);
  if (!live) {
    throw new PaymentError('No transfer is paying these fees.', 'not_found');
  }
  const record = await feeTransferForTransaction(live.transactionId);
  await withTransaction(async client => {
    const locked = await client.query<{
      status: string;
      reference: string;
      transfer_id: string;
      approval_rule_id: string | null;
      workflow_definition_id: string | null;
    }>(
      `select status, reference, transfer_id, approval_rule_id,
              workflow_definition_id
         from transaction where id = $1 for update`,
      [live.transactionId]
    );
    const tx = locked.rows[0];
    if (
      !tx ||
      !['submitted', 'under_review', 'approved', 'returned'].includes(
        tx.status
      ) ||
      record?.paymentId
    ) {
      throw new PaymentError(
        `${live.reference} has already been decided.`,
        'conflict'
      );
    }
    await client.query(
      `update transaction set status = 'cancelled', current_step_code = null
        where id = $1`,
      [live.transactionId]
    );
    await client.query(
      `update transfer set status = 'cancelled' where id = $1`,
      [tx.transfer_id]
    );
    await client.query(
      `insert into transaction_transition
         (transaction_id, from_status, to_status, step_code, actor_user_id,
          actor_role, approval_rule_id, workflow_definition_id)
       values ($1, $2, 'cancelled', null, $3, $4, $5, $6)`,
      [
        live.transactionId,
        tx.status,
        principal.userId,
        principal.roleNames.join(', ') || null,
        tx.approval_rule_id,
        tx.workflow_definition_id,
      ]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'transaction.cancelled',
        entityType: 'transaction',
        entityId: tx.reference,
        previousValue: { status: tx.status },
        newValue: { status: 'cancelled' },
      },
      client
    );
  });
  return live.reference;
}
