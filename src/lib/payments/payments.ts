// Recording what an applicant paid (S-501, S-504, S-505).
//
// Three rules shape every function here.
//
//   * Nothing is ever edited. A payment is a record of an event, so a mistake
//     is voided and a return of money is its own record pointing at the
//     original. The database enforces this; this module simply never tries.
//   * The amounts come from the fee schedule version in force, and that
//     version's id is stored with the payment. A later change to the fees
//     cannot reach backwards into what this applicant was charged.
//   * A receipt number is committed before the payment is attempted, so a
//     failure leaves a visible gap rather than a silent one. See receipts.ts,
//     which explains why that is the only design that works.
import type { PoolClient } from 'pg';
import { recordAudit } from '../access/audit';
import { checkSegregation } from '../admin/segregation';
import { query, withTransaction } from '../db/pool';
import {
  currentFeeVersion,
  feeVersionById,
  listMembershipTypes,
  type FeeComponent,
  type FeeComponentCode,
} from '../config/reference';
import type { Principal } from '../access/principal';
import { fromCents, toCents, MoneyError } from './money';
import {
  abandonReceiptNumber,
  allocateReceiptNumber,
  markReceiptIssued,
} from './receipts';

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly reason:
      'not_found' | 'invalid' | 'forbidden' | 'conflict' = 'invalid'
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

// The methods the Society accepts. A check constraint mirrors this in the
// schema; both are here rather than in configuration because a method the
// system has never heard of has nowhere to be reconciled to.
export const PAYMENT_METHODS = [
  'cash',
  'cheque',
  'bank_transfer',
  'card',
  'mobile',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  cheque: 'Cheque',
  bank_transfer: 'Bank transfer',
  card: 'Card',
  mobile: 'Mobile money',
};

export const COMPONENT_LABELS: Record<FeeComponentCode, string> = {
  entrance: 'Entrance fee',
  takaful: 'Takaful contribution',
  shares: 'Shares',
  msa_deposit: 'MSA deposit',
  processing: 'Processing fee',
};

// The actions the segregation rules seeded in 0017 key on. Named once, so
// renaming one here cannot silently disable the control.
export const ENTITY_TYPE = 'payment';
export const ACTION_RECORDED = 'membership.payment.recorded';
export const ACTION_REFUNDED = 'membership.payment.refunded';
export const ACTION_VOIDED = 'membership.payment.voided';

// FRD 7.10.6: once a membership is approved, the entrance fee and the Takaful
// contribution have been earned and are not returned. Shares and the MSA
// deposit are the member's money and always are.
const NON_REFUNDABLE_ONCE_APPROVED: ReadonlySet<FeeComponentCode> = new Set([
  'entrance',
  'takaful',
]);

export interface PaymentLine {
  componentCode: FeeComponentCode;
  label: string;
  // What the schedule said when this was taken. Null on a refund line.
  scheduledAmount: string | null;
  amount: string;
}

export interface Payment {
  id: string;
  receiptNo: string;
  serialNo: number;
  kind: 'payment' | 'refund';
  refundsId: string | null;
  refundsReceiptNo: string | null;
  applicationId: string | null;
  applicationReference: string | null;
  memberId: string | null;
  memberNo: string | null;
  feeVersionId: string;
  method: PaymentMethod;
  methodReference: string;
  currency: string;
  totalAmount: string;
  varianceReason: string;
  receivedAt: Date;
  recordedByName: string;
  recordedByEmail: string;
  voidedAt: Date | null;
  voidedByName: string | null;
  voidReason: string | null;
  lines: PaymentLine[];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
const PAYMENT_SELECT = `
  select p.id, p.kind, p.refunds_id, p.application_id, p.member_id,
         p.fee_version_id, p.method, p.method_reference, p.currency,
         p.total_amount, p.variance_reason, p.received_at,
         p.voided_at, p.void_reason,
         r.receipt_no, r.serial_no,
         orig.receipt_no as refunds_receipt_no,
         a.reference as application_reference,
         m.member_no,
         u.display_name as recorded_by_name, u.email as recorded_by_email,
         v.display_name as voided_by_name
    from payment p
    join receipt_number r on r.id = p.receipt_number_id
    join app_user u       on u.id = p.recorded_by
    left join payment orig_p          on orig_p.id = p.refunds_id
    left join receipt_number orig     on orig.id = orig_p.receipt_number_id
    left join membership_application a on a.id = p.application_id
    left join member m                 on m.id = p.member_id
    left join app_user v               on v.id = p.voided_by
`;

interface PaymentRow {
  id: string;
  kind: 'payment' | 'refund';
  refunds_id: string | null;
  application_id: string | null;
  member_id: string | null;
  fee_version_id: string;
  method: PaymentMethod;
  method_reference: string;
  currency: string;
  total_amount: string;
  variance_reason: string;
  received_at: Date;
  voided_at: Date | null;
  void_reason: string | null;
  receipt_no: string;
  serial_no: string;
  refunds_receipt_no: string | null;
  application_reference: string | null;
  member_no: string | null;
  recorded_by_name: string;
  recorded_by_email: string;
  voided_by_name: string | null;
}

interface LineRow {
  payment_id: string;
  component_code: FeeComponentCode;
  scheduled_amount: string | null;
  amount: string;
  sort_order: number;
}

function assemble(rows: PaymentRow[], lines: LineRow[]): Payment[] {
  const byPayment = new Map<string, PaymentLine[]>();
  for (const l of lines) {
    const list = byPayment.get(l.payment_id) ?? [];
    list.push({
      componentCode: l.component_code,
      label: COMPONENT_LABELS[l.component_code] ?? l.component_code,
      scheduledAmount: l.scheduled_amount,
      amount: l.amount,
    });
    byPayment.set(l.payment_id, list);
  }

  return rows.map(p => ({
    id: p.id,
    receiptNo: p.receipt_no,
    serialNo: Number(p.serial_no),
    kind: p.kind,
    refundsId: p.refunds_id,
    refundsReceiptNo: p.refunds_receipt_no,
    applicationId: p.application_id,
    applicationReference: p.application_reference,
    memberId: p.member_id,
    memberNo: p.member_no,
    feeVersionId: p.fee_version_id,
    method: p.method,
    methodReference: p.method_reference,
    currency: p.currency,
    totalAmount: p.total_amount,
    varianceReason: p.variance_reason,
    receivedAt: p.received_at,
    recordedByName: p.recorded_by_name,
    recordedByEmail: p.recorded_by_email,
    voidedAt: p.voided_at,
    voidedByName: p.voided_by_name,
    voidReason: p.void_reason,
    lines: byPayment.get(p.id) ?? [],
  }));
}

async function linesFor(paymentIds: string[]): Promise<LineRow[]> {
  if (paymentIds.length === 0) return [];
  const result = await query<LineRow>(
    `select payment_id, component_code, scheduled_amount, amount, sort_order
       from payment_line
      where payment_id = any($1::uuid[])
      order by sort_order, component_code`,
    [paymentIds]
  );
  return result.rows;
}

export async function loadPayment(id: string): Promise<Payment | null> {
  const result = await query<PaymentRow>(`${PAYMENT_SELECT} where p.id = $1`, [
    id,
  ]);
  if (result.rows.length === 0) return null;
  return assemble(result.rows, await linesFor([id]))[0];
}

// Everything recorded against one application: the payment, and any refunds
// that point at it. Ordered oldest first, which is the order it happened in.
export async function paymentsForApplication(
  applicationId: string
): Promise<Payment[]> {
  const result = await query<PaymentRow>(
    `${PAYMENT_SELECT} where p.application_id = $1 order by p.received_at`,
    [applicationId]
  );
  return assemble(result.rows, await linesFor(result.rows.map(r => r.id)));
}

/**
 * Everything taken from one member, however it was filed.
 *
 * Two ways, and both are needed. A payment made after approval names the
 * member. The one that admitted them in the first place names the APPLICATION
 * — the member did not exist when it was taken — so a query on member_id alone
 * finds nothing at all for most members, which is exactly the receipt a
 * Treasurer looking one up wants to see.
 */
export async function paymentsForMember(memberId: string): Promise<Payment[]> {
  const result = await query<PaymentRow>(
    `${PAYMENT_SELECT}
      where p.member_id = $1
         or p.application_id = (select application_id from member where id = $1)
      order by p.received_at`,
    [memberId]
  );
  return assemble(result.rows, await linesFor(result.rows.map(r => r.id)));
}

// Has this application been paid for? What the timeline asks.
export async function hasLivePayment(applicationId: string): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    `select exists (
       select 1 from payment
        where application_id = $1 and kind = 'payment' and voided_at is null
     ) as exists`,
    [applicationId]
  );
  return result.rows[0].exists;
}

// ---------------------------------------------------------------------------
// S-501 · What is due
// ---------------------------------------------------------------------------
export interface DueComponent {
  code: FeeComponentCode;
  label: string;
  amount: string;
  requirement: FeeComponent['requirement'];
}

export interface AmountDue {
  feeVersionId: string;
  scheduleName: string;
  versionNo: number;
  // Only what can actually be charged. A component configured not applicable
  // is absent, because S-501 says it cannot be paid — and a form that shows a
  // field nobody may fill in is a form that invites the question.
  components: DueComponent[];
  expectedTotal: string;
}

export async function amountDueForApplication(
  applicationId: string
): Promise<AmountDue> {
  const application = await query<{
    membership_type_id: string;
    status: string;
  }>(
    `select membership_type_id, status from membership_application where id = $1`,
    [applicationId]
  );
  if (application.rows.length === 0) {
    throw new PaymentError('That application no longer exists.', 'not_found');
  }

  const type = (await listMembershipTypes()).find(
    t => t.id === application.rows[0].membership_type_id
  );
  if (!type?.feeScheduleId) {
    throw new PaymentError(
      `No fee schedule is set for ${type?.name ?? 'this membership type'}.`
    );
  }

  const version = await currentFeeVersion(type.feeScheduleId);
  if (!version) {
    throw new PaymentError(
      `${type.name} has no published fee version to charge against.`
    );
  }

  const chargeable = version.components.filter(
    c => c.requirement !== 'not_applicable'
  );

  return {
    feeVersionId: version.versionId,
    scheduleName: version.scheduleName,
    versionNo: version.versionNo,
    components: chargeable.map(c => ({
      code: c.code,
      label: COMPONENT_LABELS[c.code] ?? c.code,
      amount: c.amount,
      requirement: c.requirement,
    })),
    // Only what is required. An optional component that was not taken is not a
    // shortfall, so counting it would make every ordinary payment look wrong.
    expectedTotal: fromCents(
      chargeable
        .filter(c => c.requirement === 'required')
        .reduce((total, c) => total + toCents(c.amount), 0)
    ),
  };
}

// ---------------------------------------------------------------------------
// S-501 · Recording a payment
// ---------------------------------------------------------------------------
export interface RecordPaymentInput {
  applicationId: string;
  method: PaymentMethod;
  methodReference?: string;
  receivedAt?: Date;
  amounts: Partial<Record<FeeComponentCode, string>>;
  // Required only when the total differs from the schedule.
  varianceReason?: string;
}

export async function recordPayment(
  input: RecordPaymentInput,
  principal: Principal
): Promise<Payment> {
  if (!principal.permissions.has('payment.record')) {
    throw new PaymentError(
      'You do not have permission to record payments.',
      'forbidden'
    );
  }

  if (!PAYMENT_METHODS.includes(input.method)) {
    throw new PaymentError('Choose how the payment was made.');
  }

  // A decided application is not one to take money on: an approved applicant
  // is a member and pays through their account, and a rejected one is owed a
  // refund rather than a receipt. The page hides the form, but the rule
  // belongs here — a form that is merely hidden is still a form that posts.
  const status = await query<{ status: string }>(
    'select status from membership_application where id = $1',
    [input.applicationId]
  );
  if (status.rows.length === 0) {
    throw new PaymentError('That application no longer exists.', 'not_found');
  }
  if (status.rows[0].status === 'approved') {
    throw new PaymentError(
      'This application has been approved. Record the payment against the ' +
        'member instead.',
      'conflict'
    );
  }
  if (status.rows[0].status === 'rejected') {
    throw new PaymentError(
      'This application was rejected, so no receipt can be issued against it.',
      'conflict'
    );
  }

  const due = await amountDueForApplication(input.applicationId);
  const chargeable = new Map(due.components.map(c => [c.code, c]));

  // A component the schedule does not offer cannot be paid, and neither can
  // one configured not applicable — which is the same refusal, because
  // amountDue has already left those out.
  for (const code of Object.keys(input.amounts) as FeeComponentCode[]) {
    if (!chargeable.has(code)) {
      throw new PaymentError(
        `${COMPONENT_LABELS[code] ?? code} is not payable on this ` +
          'membership type.'
      );
    }
  }

  let requiredPaid = 0;
  let total = 0;
  const lines: Array<{
    code: FeeComponentCode;
    scheduled: string;
    amount: string;
    sortOrder: number;
  }> = [];

  due.components.forEach((component, index) => {
    const raw = (input.amounts[component.code] ?? '0').trim() || '0';
    let cents: number;
    try {
      cents = toCents(raw);
    } catch (error) {
      throw new PaymentError(
        error instanceof MoneyError
          ? `${component.label}: ${error.message}`
          : `${component.label} is not an amount.`
      );
    }
    if (cents < 0) {
      throw new PaymentError(`${component.label} cannot be negative.`);
    }

    total += cents;
    if (component.requirement === 'required') requiredPaid += cents;

    lines.push({
      code: component.code,
      scheduled: component.amount,
      amount: fromCents(cents),
      sortOrder: index,
    });
  });

  if (total === 0) {
    throw new PaymentError('Enter what was paid before recording a receipt.');
  }

  // S-501: a difference from the schedule is allowed, but never by accident.
  const variance = requiredPaid - toCents(due.expectedTotal);
  const varianceReason = (input.varianceReason ?? '').trim();
  if (variance !== 0 && varianceReason === '') {
    const word = variance > 0 ? 'more' : 'less';
    throw new PaymentError(
      `That is ${fromCents(Math.abs(variance))} ${word} than the ` +
        `${due.expectedTotal} due. Say why before recording it.`
    );
  }

  const existing = await query<{ receipt_no: string }>(
    `select r.receipt_no
       from payment p
       join receipt_number r on r.id = p.receipt_number_id
      where p.application_id = $1 and p.kind = 'payment'
        and p.voided_at is null`,
    [input.applicationId]
  );
  if (existing.rows.length > 0) {
    throw new PaymentError(
      `This application was already receipted as ${existing.rows[0].receipt_no}. ` +
        'Void that receipt if it was wrong.',
      'conflict'
    );
  }

  const allocation = await allocateReceiptNumber(principal.userId);

  try {
    const id = await withTransaction(async client => {
      // The application is locked for the insert so that two officers cannot
      // each pass the check above and both file a receipt.
      const locked = await client.query<{ id: string; reference: string }>(
        `select id, reference from membership_application
          where id = $1 for no key update`,
        [input.applicationId]
      );
      if (locked.rows.length === 0) {
        throw new PaymentError(
          'That application no longer exists.',
          'not_found'
        );
      }

      const duplicate = await client.query(
        `select 1 from payment
          where application_id = $1 and kind = 'payment' and voided_at is null`,
        [input.applicationId]
      );
      if ((duplicate.rowCount ?? 0) > 0) {
        throw new PaymentError(
          'This application has just been receipted by someone else.',
          'conflict'
        );
      }

      const inserted = await client.query<{ id: string }>(
        `insert into payment
           (receipt_number_id, kind, application_id, fee_version_id, method,
            method_reference, total_amount, variance_reason, received_at,
            recorded_by)
         values ($1, 'payment', $2, $3, $4, $5, $6, $7, coalesce($8, now()), $9)
         returning id`,
        [
          allocation.id,
          input.applicationId,
          due.feeVersionId,
          input.method,
          (input.methodReference ?? '').trim(),
          fromCents(total),
          varianceReason,
          input.receivedAt ?? null,
          principal.userId,
        ]
      );
      const paymentId = inserted.rows[0].id;

      for (const line of lines) {
        await client.query(
          `insert into payment_line
             (payment_id, component_code, scheduled_amount, amount, sort_order)
           values ($1, $2, $3, $4, $5)`,
          [paymentId, line.code, line.scheduled, line.amount, line.sortOrder]
        );
      }

      await markReceiptIssued(allocation.id, client);

      await emitFinancialEvent(client, {
        eventType: 'payment.recorded',
        paymentId,
        receiptNo: allocation.receiptNo,
        payload: {
          kind: 'payment',
          applicationId: input.applicationId,
          applicationReference: locked.rows[0].reference,
          feeVersionId: due.feeVersionId,
          currency: 'MUR',
          totalAmount: fromCents(total),
          method: input.method,
          components: lines.map(l => ({
            code: l.code,
            scheduledAmount: l.scheduled,
            amount: l.amount,
          })),
          variance: variance === 0 ? null : fromCents(variance),
          varianceReason: varianceReason || null,
          recordedBy: principal.email,
        },
      });

      await recordAudit(
        {
          actorUserId: principal.userId,
          actorDescription: principal.email,
          action: ACTION_RECORDED,
          entityType: ENTITY_TYPE,
          entityId: paymentId,
          newValue: {
            receiptNo: allocation.receiptNo,
            applicationReference: locked.rows[0].reference,
            totalAmount: fromCents(total),
            method: input.method,
          },
        },
        client
      );

      return paymentId;
    });

    return (await loadPayment(id))!;
  } catch (error) {
    // The number is spent either way — it can never be reused — but why it was
    // spent is recorded, so reconciliation reports a gap with a reason rather
    // than a number nobody can account for.
    await abandonReceiptNumber(
      allocation.id,
      error instanceof PaymentError
        ? error.message
        : 'The payment failed while being recorded.'
    );
    throw error;
  }
}

// ---------------------------------------------------------------------------
// S-505 · Refunds
// ---------------------------------------------------------------------------
export interface RefundInput {
  paymentId: string;
  method: PaymentMethod;
  methodReference?: string;
  reason: string;
  amounts: Partial<Record<FeeComponentCode, string>>;
}

// What is still returnable on a payment, component by component: what was
// taken, less what has already gone back, less anything the approval has
// earned.
export interface RefundableComponent {
  code: FeeComponentCode;
  label: string;
  paid: string;
  alreadyRefunded: string;
  refundable: string;
  // Present when nothing may be returned, so the screen can say why rather
  // than showing a field that refuses everything typed into it.
  blockedReason?: string;
}

export async function refundableComponents(
  paymentId: string
): Promise<RefundableComponent[]> {
  const payment = await loadPayment(paymentId);
  if (!payment) {
    throw new PaymentError('That receipt no longer exists.', 'not_found');
  }
  if (payment.kind !== 'payment') {
    throw new PaymentError('A refund cannot itself be refunded.');
  }

  const refunded = await query<{
    component_code: FeeComponentCode;
    total: string;
  }>(
    `select l.component_code, sum(l.amount) as total
       from payment r
       join payment_line l on l.payment_id = r.id
      where r.refunds_id = $1 and r.voided_at is null
      group by l.component_code`,
    [paymentId]
  );
  const already = new Map(
    refunded.rows.map(r => [r.component_code, toCents(r.total)])
  );

  const approved = payment.applicationId
    ? await isApproved(payment.applicationId)
    : true;

  return payment.lines.map(line => {
    const paid = toCents(line.amount);
    const back = already.get(line.componentCode) ?? 0;
    const earned =
      approved && NON_REFUNDABLE_ONCE_APPROVED.has(line.componentCode);

    return {
      code: line.componentCode,
      label: line.label,
      paid: line.amount,
      alreadyRefunded: fromCents(back),
      refundable: earned ? '0.00' : fromCents(Math.max(paid - back, 0)),
      ...(earned
        ? {
            blockedReason:
              'Not refundable once the membership has been approved.',
          }
        : {}),
    };
  });
}

async function isApproved(applicationId: string): Promise<boolean> {
  const result = await query<{ status: string }>(
    'select status from membership_application where id = $1',
    [applicationId]
  );
  return result.rows[0]?.status === 'approved';
}

export async function refundPayment(
  input: RefundInput,
  principal: Principal
): Promise<Payment> {
  if (!principal.permissions.has('payment.refund')) {
    throw new PaymentError(
      'You do not have permission to refund payments.',
      'forbidden'
    );
  }

  const original = await loadPayment(input.paymentId);
  if (!original) {
    throw new PaymentError('That receipt no longer exists.', 'not_found');
  }
  if (original.kind !== 'payment') {
    throw new PaymentError('A refund cannot itself be refunded.');
  }
  if (original.voidedAt) {
    throw new PaymentError(
      `Receipt ${original.receiptNo} was voided; there is nothing to refund.`,
      'conflict'
    );
  }

  const reason = input.reason.trim();
  if (reason === '') {
    throw new PaymentError('Say why the money is going back.');
  }

  // The person who took the money is not the person who returns it (S-203).
  const verdict = await checkSegregation(
    principal.userId,
    ENTITY_TYPE,
    original.id,
    ACTION_REFUNDED
  );
  if (!verdict.allowed) {
    throw new PaymentError(
      `${verdict.conflict!.description} Someone else must action this refund.`,
      'forbidden'
    );
  }

  const refundable = await refundableComponents(input.paymentId);
  const byCode = new Map(refundable.map(r => [r.code, r]));

  let total = 0;
  const lines: Array<{
    code: FeeComponentCode;
    amount: string;
    sortOrder: number;
  }> = [];

  for (const [code, raw] of Object.entries(input.amounts) as Array<
    [FeeComponentCode, string]
  >) {
    const entry = byCode.get(code);
    if (!entry) {
      throw new PaymentError(
        `${COMPONENT_LABELS[code] ?? code} was not paid on receipt ` +
          `${original.receiptNo}.`
      );
    }

    let cents: number;
    try {
      cents = toCents((raw ?? '0').trim() || '0');
    } catch (error) {
      throw new PaymentError(
        error instanceof MoneyError
          ? `${entry.label}: ${error.message}`
          : `${entry.label} is not an amount.`
      );
    }
    if (cents === 0) continue;
    if (cents < 0) {
      throw new PaymentError(`${entry.label} cannot be negative.`);
    }

    if (entry.blockedReason) {
      throw new PaymentError(`${entry.label}: ${entry.blockedReason}`);
    }
    const ceiling = toCents(entry.refundable);
    if (cents > ceiling) {
      throw new PaymentError(
        `${entry.label}: only ${entry.refundable} of the ${entry.paid} paid ` +
          'is still refundable.'
      );
    }

    total += cents;
    lines.push({
      code,
      amount: fromCents(cents),
      sortOrder: lines.length,
    });
  }

  if (total === 0) {
    throw new PaymentError('Enter what is going back before recording it.');
  }

  const allocation = await allocateReceiptNumber(principal.userId);

  try {
    const id = await withTransaction(async client => {
      // Locked so two refunds cannot each pass the ceiling check above and
      // together return more than was taken.
      await client.query('select 1 from payment where id = $1 for update', [
        original.id,
      ]);

      const alreadyOut = await client.query<{ total: string | null }>(
        `select sum(l.amount) as total
           from payment r
           join payment_line l on l.payment_id = r.id
          where r.refunds_id = $1 and r.voided_at is null`,
        [original.id]
      );
      const outstanding =
        toCents(original.totalAmount) -
        toCents(alreadyOut.rows[0].total ?? '0');
      if (total > outstanding) {
        throw new PaymentError(
          'Another refund was recorded against this receipt while you were ' +
            'working. Reopen it and try again.',
          'conflict'
        );
      }

      const inserted = await client.query<{ id: string }>(
        `insert into payment
           (receipt_number_id, kind, refunds_id, application_id, member_id,
            fee_version_id, method, method_reference, total_amount,
            variance_reason, recorded_by)
         values ($1, 'refund', $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id`,
        [
          allocation.id,
          original.id,
          original.applicationId,
          original.memberId,
          original.feeVersionId,
          input.method,
          (input.methodReference ?? '').trim(),
          fromCents(total),
          reason,
          principal.userId,
        ]
      );
      const refundId = inserted.rows[0].id;

      for (const line of lines) {
        await client.query(
          `insert into payment_line
             (payment_id, component_code, amount, sort_order)
           values ($1, $2, $3, $4)`,
          [refundId, line.code, line.amount, line.sortOrder]
        );
      }

      await markReceiptIssued(allocation.id, client);

      // S-504: a compensating event. The original is not touched.
      await emitFinancialEvent(client, {
        eventType: 'payment.refunded',
        paymentId: refundId,
        receiptNo: allocation.receiptNo,
        payload: {
          kind: 'refund',
          refundsPaymentId: original.id,
          refundsReceiptNo: original.receiptNo,
          applicationId: original.applicationId,
          applicationReference: original.applicationReference,
          memberId: original.memberId,
          feeVersionId: original.feeVersionId,
          currency: original.currency,
          totalAmount: fromCents(total),
          method: input.method,
          components: lines.map(l => ({ code: l.code, amount: l.amount })),
          reason,
          recordedBy: principal.email,
        },
      });

      await recordAudit(
        {
          actorUserId: principal.userId,
          actorDescription: principal.email,
          action: ACTION_REFUNDED,
          // Against the ORIGINAL, so the receipt's own history reads whole and
          // the segregation check has something to find.
          entityType: ENTITY_TYPE,
          entityId: original.id,
          newValue: {
            refundReceiptNo: allocation.receiptNo,
            totalAmount: fromCents(total),
            components: lines.map(l => l.code),
            reason,
          },
        },
        client
      );

      return refundId;
    });

    return (await loadPayment(id))!;
  } catch (error) {
    await abandonReceiptNumber(
      allocation.id,
      error instanceof PaymentError
        ? error.message
        : 'The refund failed while being recorded.'
    );
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Voiding a receipt issued in error
// ---------------------------------------------------------------------------
export async function voidPayment(
  paymentId: string,
  reason: string,
  principal: Principal
): Promise<Payment> {
  if (!principal.permissions.has('payment.void')) {
    throw new PaymentError(
      'You do not have permission to void receipts.',
      'forbidden'
    );
  }

  const trimmed = reason.trim();
  if (trimmed === '') {
    throw new PaymentError('Say why the receipt is being voided.');
  }

  const payment = await loadPayment(paymentId);
  if (!payment) {
    throw new PaymentError('That receipt no longer exists.', 'not_found');
  }
  if (payment.voidedAt) {
    throw new PaymentError(
      `Receipt ${payment.receiptNo} is already void.`,
      'conflict'
    );
  }

  const verdict = await checkSegregation(
    principal.userId,
    ENTITY_TYPE,
    payment.id,
    ACTION_VOIDED
  );
  if (!verdict.allowed) {
    throw new PaymentError(
      `${verdict.conflict!.description} Someone else must void it.`,
      'forbidden'
    );
  }

  await withTransaction(async client => {
    const refunds = await client.query(
      `select 1 from payment
        where refunds_id = $1 and voided_at is null`,
      [payment.id]
    );
    if ((refunds.rowCount ?? 0) > 0) {
      throw new PaymentError(
        `Receipt ${payment.receiptNo} has been refunded. Void the refund ` +
          'first.',
        'conflict'
      );
    }

    const updated = await client.query(
      `update payment
          set voided_at = now(), voided_by = $2, void_reason = $3
        where id = $1 and voided_at is null`,
      [payment.id, principal.userId, trimmed]
    );
    if (updated.rowCount === 0) {
      throw new PaymentError(
        `Receipt ${payment.receiptNo} is already void.`,
        'conflict'
      );
    }

    // The number goes with it, so the sequence shows a void rather than an
    // issued receipt whose payment says otherwise.
    await client.query(
      `update receipt_number
          set state = 'void', settled_at = now(), reason = $2
        where receipt_no = $1`,
      [payment.receiptNo, trimmed.slice(0, 500)]
    );

    await emitFinancialEvent(client, {
      eventType: 'payment.voided',
      paymentId: payment.id,
      receiptNo: payment.receiptNo,
      payload: {
        kind: payment.kind,
        applicationId: payment.applicationId,
        applicationReference: payment.applicationReference,
        memberId: payment.memberId,
        currency: payment.currency,
        totalAmount: payment.totalAmount,
        reason: trimmed,
        voidedBy: principal.email,
      },
    });

    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: ACTION_VOIDED,
        entityType: ENTITY_TYPE,
        entityId: payment.id,
        previousValue: {
          receiptNo: payment.receiptNo,
          totalAmount: payment.totalAmount,
        },
        newValue: { reason: trimmed },
      },
      client
    );
  });

  return (await loadPayment(payment.id))!;
}

// ---------------------------------------------------------------------------
// S-503 · Printing
// ---------------------------------------------------------------------------
export interface PrintHistory {
  count: number;
  firstPrintedAt: Date | null;
  firstPrintedByName: string | null;
}

export async function printHistoryFor(
  paymentId: string
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
              where f.payment_id = $1
              order by f.printed_at
              limit 1) as first_by
       from receipt_print p
      where p.payment_id = $1`,
    [paymentId]
  );

  const row = result.rows[0];
  return {
    count: Number(row.n),
    firstPrintedAt: row.first_at,
    firstPrintedByName: row.first_by,
  };
}

// Recorded when the officer actually prints, not when the page is opened.
// Opening a receipt to read it is not a reprint, and marking it as one would
// make the stamp meaningless within a week.
export async function recordReceiptPrint(
  paymentId: string,
  principal: Principal
): Promise<void> {
  if (!principal.permissions.has('payment.view')) {
    throw new PaymentError(
      'You do not have permission to view receipts.',
      'forbidden'
    );
  }
  await query(
    'insert into receipt_print (payment_id, printed_by) values ($1, $2)',
    [paymentId, principal.userId]
  );
}

// ---------------------------------------------------------------------------
// S-504 · The event stream
// ---------------------------------------------------------------------------
interface FinancialEventInput {
  eventType: 'payment.recorded' | 'payment.refunded' | 'payment.voided';
  paymentId: string;
  receiptNo: string;
  payload: Record<string, unknown>;
}

// Always inside the caller's transaction. An event describing a payment that
// rolled back would be worse than no event at all: Phase 3 would post it.
async function emitFinancialEvent(
  client: PoolClient,
  event: FinancialEventInput
): Promise<void> {
  await client.query(
    `insert into financial_event (event_type, payment_id, receipt_no, payload)
     values ($1, $2, $3, $4::jsonb)`,
    [
      event.eventType,
      event.paymentId,
      event.receiptNo,
      JSON.stringify(event.payload),
    ]
  );
}

// The stream, for a consumer that checkpoints on sequence_no (S-504).
export interface FinancialEvent {
  sequenceNo: number;
  eventType: string;
  paymentId: string;
  receiptNo: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

export async function financialEventsSince(
  after: number,
  limit = 100
): Promise<FinancialEvent[]> {
  const result = await query<{
    sequence_no: string;
    event_type: string;
    payment_id: string;
    receipt_no: string;
    occurred_at: Date;
    payload: Record<string, unknown>;
  }>(
    `select sequence_no, event_type, payment_id, receipt_no, occurred_at, payload
       from financial_event
      where sequence_no > $1
      order by sequence_no
      limit $2`,
    [after, Math.min(Math.max(limit, 1), 500)]
  );

  return result.rows.map(r => ({
    sequenceNo: Number(r.sequence_no),
    eventType: r.event_type,
    paymentId: r.payment_id,
    receiptNo: r.receipt_no,
    occurredAt: r.occurred_at,
    payload: r.payload,
  }));
}

// Read the amounts a receipt charged, from the version it charged them under.
// Used by the printed receipt so a reprint years later shows the schedule as
// it stood, not as it stands.
export async function feeVersionFor(
  payment: Payment
): Promise<{ versionNo: number; components: FeeComponent[] } | null> {
  return feeVersionById(payment.feeVersionId);
}
