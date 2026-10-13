// A new member's fees paid by another member (officer request; migration
// 0126). On the Payments step of a membership application, the entrance
// fee, Takaful and Shares are paid from an existing member's account — any
// of their accounts, Shares included — instead of at the counter.
//
// It is a transfer, and goes where every transfer goes: a debit leg on the
// paying account, routed by the matrix's Transfer bands and reviewed by its
// chain (officer answer: "through the transfer approval chain"). There is no
// credit leg — the applicant has no account yet. It never posts at once:
// approved by its chain, or straight away below the band, it waits for the
// Treasurer to disburse it (officer direction), and the fee receipt is
// issued then (fee-transfer-settlement.ts). Until then the fees are pending:
// the application may be submitted and its documents verified, but the
// Secretary's step waits (applications/workflow.ts). The whole payment goes
// one way (officer answer): no part cash, part transfer.
//
// The paying account meets every check a transfer's source does — active,
// the holder able to transact, a guardian present, the available balance,
// the type's floor and its transaction ceiling — save the type's
// allows_transfer flag: Shares do not move between members' accounts, but
// they may pay a new member's fees (officer answer), still above the floor.
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { query, withTransaction } from '../db/pool';
import { LedgerError } from '../ledger/ledger';
import { loadTransaction } from '../ledger/review';
import { resolveRoute, submitTransaction } from '../ledger/routing';
import { notifySubmitted } from '../ledger/transaction-notifications';
import { INTERNAL_METHOD, PERMISSION_CAPTURE } from '../ledger/transfers';
import {
  refuseUnlessWithdrawable,
  source,
  WithdrawalError,
} from '../ledger/withdrawals';
import {
  FeeTransferError,
  feeTransferForTransaction,
} from './fee-transfer-settlement';
import { fromCents, toCents } from './money';
import {
  checkFeeAmounts,
  liveFeeTransferFor,
  liveReceiptFor,
  PaymentError,
  refuseUnlessUndecided,
} from './payments';
import type { FeeComponentCode } from '../config/reference';
import { canTransact } from '../members/status';

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
  const reason = `Membership fees · ${app.reference}${
    app.applicant_name ? ` · ${app.applicant_name}` : ''
  }`;

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
            captured_by, transfer_id, leg_direction)
         values ('transfer_leg', $1, $2, $3, $4, $5, 'submitted', $6, $7,
                 'debit')
         returning id, reference`,
        [
          from.memberId,
          from.id,
          fromCents(fees.totalCents),
          INTERNAL_METHOD,
          reason,
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
      if (route.definition) {
        // Above the band: the chain reviews it, then the Treasurer
        // disburses it.
        await submitTransaction(
          client,
          { id: legId, reference: legReference, kind: 'transfer' },
          route,
          principal
        );
        await client.query(
          `update transfer set status = 'submitted' where id = $1`,
          [transferId]
        );
      } else {
        // Below it, nobody reviews it, but it never posts at once either:
        // the fees stay pending until the Treasurer disburses (officer
        // direction), so it waits, approved, in the Treasurer's queue.
        await client.query(
          `update transaction
              set status = 'approved', approval_rule_id = $2,
                  workflow_definition_id = null, current_step_code = null,
                  submitted_at = now()
            where id = $1`,
          [legId, route.rule?.id ?? null]
        );
        await client.query(
          `insert into transaction_transition
             (transaction_id, from_status, to_status, step_code,
              actor_user_id, actor_role, comment, approval_rule_id,
              workflow_definition_id)
           values ($1, null, 'approved', null, $2, $3, null, $4, null)`,
          [
            legId,
            principal.userId,
            principal.roleNames.join(', ') || null,
            route.rule?.id ?? null,
          ]
        );
        await client.query(
          `update transfer set status = 'approved' where id = $1`,
          [transferId]
        );
      }
      return legId;
    });

    const leg = (await loadTransaction(debitId))!;
    await notifySubmitted([leg, null], { byUserId: principal.userId });
    return { transactionId: debitId, reference: leg.displayReference };
  } catch (err) {
    return asPaymentError(err);
  }
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

// The accounts a member could pay a new member's fees from, for the
// Payments step (officer request): every open account, any type — Hajj and
// Investment as much as Shares — with what it can pay now, which is the
// available balance less what is already on its way out and the type's
// floor. Found by the member's number or name.
export interface PayerAccount {
  accountId: string;
  accountNo: string;
  typeName: string;
  payable: string;
}

export interface Payer {
  memberId: string;
  memberNo: string;
  name: string;
  accounts: PayerAccount[];
}

export async function payersMatching(
  typed: string,
  limit = 6
): Promise<Payer[]> {
  const prefix = typed.trim().toUpperCase().replace(/\s+/g, '');
  const words = typed.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const members = await query<{
    id: string;
    member_no: string;
    status: string;
    name: string;
  }>(
    `select m.id, m.member_no, m.status,
            trim(coalesce(p.values->>'name', '') || ' '
                 || coalesce(p.values->>'surname', '')) as name
       from member m
       left join application_party p
         on p.application_id = m.application_id
        and p.subject = 'applicant' and p.ordinal = 1
      where starts_with(upper(m.member_no), $1)
         or not exists (
              select 1 from unnest($2::text[]) w
               where strpos(lower(coalesce(p.values->>'name', '') || ' '
                                  || coalesce(p.values->>'surname', '')), w) = 0)
      order by starts_with(upper(m.member_no), $1) desc, name, m.member_no
      limit $3`,
    [prefix, words, limit * 2]
  );
  const payers = members.rows
    .filter(m => canTransact(m.status))
    .slice(0, limit);
  if (payers.length === 0) return [];
  const accounts = await query<{
    member_id: string;
    account_id: string;
    account_no: string;
    type_name: string;
    payable: string;
  }>(
    `select a.member_id, a.id as account_id,
            coalesce(a.account_no, m.member_no) as account_no,
            at.name as type_name,
            greatest(coalesce(b.balance, 0) - coalesce(out.amount, 0)
                     - at.minimum_balance, 0)::numeric(14, 2)::text as payable
       from account a
       join member m on m.id = a.member_id
       join account_type at on at.id = a.account_type_id
       left join account_balance b on b.account_id = a.id
       left join lateral (
              select sum(t.amount) as amount from transaction t
               where t.account_id = a.id
                 and (t.kind in ('withdrawal', 'closure', 'resignation', 'demise')
                      or (t.kind = 'transfer_leg' and t.leg_direction = 'debit'))
                 and t.status in ('submitted', 'under_review', 'approved')) out
         on true
      where a.member_id = any($1::uuid[]) and a.status = 'active'
      order by at.is_membership_default desc, at.name, account_no`,
    [payers.map(p => p.id)]
  );
  return payers.map(p => ({
    memberId: p.id,
    memberNo: p.member_no,
    name: p.name,
    accounts: accounts.rows
      .filter(a => a.member_id === p.id)
      .map(a => ({
        accountId: a.account_id,
        accountNo: a.account_no,
        typeName: a.type_name,
        payable: fromCents(toCents(a.payable)),
      })),
  }));
}
