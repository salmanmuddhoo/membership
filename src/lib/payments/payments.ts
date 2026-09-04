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
  cashSourceOfFundThreshold,
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
// deposit are the member's own money, sitting in their two accounts, and
// always come back.
const NON_REFUNDABLE_ONCE_APPROVED: ReadonlySet<FeeComponentCode> = new Set([
  'entrance',
  'takaful',
]);

// Officer feedback: the entrance fee and the Takaful contribution are the
// Society's own charge, set by the fee schedule and not negotiable at the
// counter — an officer cannot record any other amount for them, and there is
// nothing to explain if they tried. Shares and the MSA deposit are the
// member's own money going into their own account: the schedule sets a
// floor, but paying more than it is always the payer's choice and needs no
// reason — only paying less is refused.
export const FIXED_FEE_COMPONENTS: ReadonlySet<FeeComponentCode> = new Set([
  'entrance',
  'takaful',
]);
export const FLOOR_FEE_COMPONENTS: ReadonlySet<FeeComponentCode> = new Set([
  'shares',
  'msa_deposit',
]);

// Officer feedback: a cash payment above a configurable threshold needs a
// source of fund on record, and the officer reminded to also complete the
// paper Source of Fund form — a form outside this application, so all this
// can do is say so. Shared between recordPayment and
// recordAccountOpeningPayment rather than written twice.
async function requireSourceOfFundIfCash(
  method: PaymentMethod,
  totalCents: number,
  sourceOfFund: string
): Promise<void> {
  if (method !== 'cash') return;
  const thresholdCents = toCents(await cashSourceOfFundThreshold());
  if (totalCents <= thresholdCents) return;
  if (sourceOfFund.trim() === '') {
    throw new PaymentError(
      `Cash payments over ${fromCents(thresholdCents)} need a source of ` +
        'fund note before a receipt can be issued. The officer must also ' +
        'complete the paper Source of Fund form.'
    );
  }
}

export interface PaymentLine {
  componentCode: FeeComponentCode;
  label: string;
  // What the schedule said when this was taken. Null on a refund line.
  scheduledAmount: string | null;
  amount: string;
}

// S-613, phase 6: a payment against an additional_account application has no
// fee schedule to itemise by component — each line is a selected account
// type, snapshotted (migration 0026) the same reason payment_line already
// keeps scheduledAmount: an account type renamed later must not rewrite what
// a receipt already printed.
export interface PaymentAccountLine {
  accountTypeId: string;
  accountTypeCode: string;
  label: string;
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
  // Null for a payment against an additional_account application (S-613) —
  // see accountLines instead, which is empty for every other payment.
  feeVersionId: string | null;
  method: PaymentMethod;
  methodReference: string;
  currency: string;
  totalAmount: string;
  varianceReason: string;
  sourceOfFund: string;
  receivedAt: Date;
  recordedByName: string;
  recordedByEmail: string;
  // The role(s) recordedByName held at the moment this was recorded,
  // comma-joined if more than one — snapshotted, so a later change to
  // their roles cannot rewrite what a printed receipt already said.
  recordedByRole: string;
  voidedAt: Date | null;
  voidedByName: string | null;
  voidReason: string | null;
  lines: PaymentLine[];
  accountLines: PaymentAccountLine[];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
const PAYMENT_SELECT = `
  select p.id, p.kind, p.refunds_id, p.application_id, p.member_id,
         p.fee_version_id, p.method, p.method_reference, p.currency,
         p.total_amount, p.variance_reason, p.source_of_fund, p.received_at,
         p.voided_at, p.void_reason,
         r.receipt_no, r.serial_no,
         orig.receipt_no as refunds_receipt_no,
         a.reference as application_reference,
         m.member_no,
         u.display_name as recorded_by_name, u.email as recorded_by_email,
         p.recorded_by_role,
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
  fee_version_id: string | null;
  method: PaymentMethod;
  method_reference: string;
  currency: string;
  total_amount: string;
  variance_reason: string;
  source_of_fund: string;
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
  recorded_by_role: string;
  voided_by_name: string | null;
}

interface LineRow {
  payment_id: string;
  component_code: FeeComponentCode;
  scheduled_amount: string | null;
  amount: string;
  sort_order: number;
}

interface AccountLineRow {
  payment_id: string;
  account_type_id: string;
  account_type_code: string;
  account_type_name: string;
  amount: string;
  sort_order: number;
}

function assemble(
  rows: PaymentRow[],
  lines: LineRow[],
  accountLines: AccountLineRow[]
): Payment[] {
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

  const byPaymentAccount = new Map<string, PaymentAccountLine[]>();
  for (const l of accountLines) {
    const list = byPaymentAccount.get(l.payment_id) ?? [];
    list.push({
      accountTypeId: l.account_type_id,
      accountTypeCode: l.account_type_code,
      label: l.account_type_name,
      amount: l.amount,
    });
    byPaymentAccount.set(l.payment_id, list);
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
    sourceOfFund: p.source_of_fund,
    receivedAt: p.received_at,
    recordedByName: p.recorded_by_name,
    recordedByEmail: p.recorded_by_email,
    recordedByRole: p.recorded_by_role,
    voidedAt: p.voided_at,
    voidedByName: p.voided_by_name,
    voidReason: p.void_reason,
    lines: byPayment.get(p.id) ?? [],
    accountLines: byPaymentAccount.get(p.id) ?? [],
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

async function accountLinesFor(
  paymentIds: string[]
): Promise<AccountLineRow[]> {
  if (paymentIds.length === 0) return [];
  const result = await query<AccountLineRow>(
    `select payment_id, account_type_id, account_type_code, account_type_name,
            amount, sort_order
       from payment_account_line
      where payment_id = any($1::uuid[])
      order by sort_order, account_type_code`,
    [paymentIds]
  );
  return result.rows;
}

export async function loadPayment(id: string): Promise<Payment | null> {
  const result = await query<PaymentRow>(`${PAYMENT_SELECT} where p.id = $1`, [
    id,
  ]);
  if (result.rows.length === 0) return null;
  const [lines, accountLines] = await Promise.all([
    linesFor([id]),
    accountLinesFor([id]),
  ]);
  return assemble(result.rows, lines, accountLines)[0];
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
  const ids = result.rows.map(r => r.id);
  const [lines, accountLines] = await Promise.all([
    linesFor(ids),
    accountLinesFor(ids),
  ]);
  return assemble(result.rows, lines, accountLines);
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
  const ids = result.rows.map(r => r.id);
  const [lines, accountLines] = await Promise.all([
    linesFor(ids),
    accountLinesFor(ids),
  ]);
  return assemble(result.rows, lines, accountLines);
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

// Officer feedback: what has actually moved through one account, credit and
// debit — the Members page's own read, ahead of a real transaction ledger
// ("later on we will have transaction where there will be deposit or
// withdrawal or transfer"). Not a running balance built from a ledger,
// because there is none yet: it is the opening payment, and any refund
// against it, which today are the only two things that can have happened to
// this account's money.
//
// Deliberately its own small queries rather than a reuse of
// paymentsForMember/paymentsForApplication above: those load and assemble
// every payment a member has, which is right for a page about the member —
// here the caller already knows the one account it is asking about.
export interface AccountTransaction {
  type: 'credit' | 'debit';
  amount: string;
  currency: string;
  occurredAt: Date;
  description: string;
}

export async function transactionsForAccount(
  accountId: string
): Promise<AccountTransaction[]> {
  const found = await query<{
    account_type_id: string;
    type_code: string;
    member_id: string | null;
    customer_id: string | null;
    is_membership_default: boolean;
  }>(
    `select a.account_type_id, t.code as type_code,
            a.member_id, a.customer_id, a.is_membership_default
       from account a
       join account_type t on t.id = a.account_type_id
      where a.id = $1`,
    [accountId]
  );
  if (found.rows.length === 0) return [];
  const account = found.rows[0];

  // Which application's payment funded this account — the only place a
  // transaction is recorded, since the account row itself keeps no link
  // back to it (S-612/S-614 opened neither account_no nor application_id
  // onto account for this).
  let applicationId: string | null = null;
  if (account.is_membership_default) {
    // Shares and the MSA open with the same founding application that made
    // the member (migration 0018) — there is only ever one.
    const member = await query<{ application_id: string | null }>(
      `select application_id from member where id = $1`,
      [account.member_id]
    );
    applicationId = member.rows[0]?.application_id ?? null;
  } else if (account.member_id) {
    // An existing member's HSA/Investment-style account (S-612): opened by
    // whichever additional_account application selected this type and was
    // approved. account_one_per_type_per_member_idx (migration 0018) means
    // there is at most one to find.
    const opened = await query<{ id: string }>(
      `select ma.id
         from membership_application ma
         join application_account_selection s on s.application_id = ma.id
        where ma.existing_member_id = $1
          and ma.application_kind = 'additional_account'
          and s.account_type_id = $2
        order by ma.decided_at desc nulls last
        limit 1`,
      [account.member_id, account.account_type_id]
    );
    applicationId = opened.rows[0]?.id ?? null;
  } else if (account.customer_id) {
    // A non-member's account (S-614): one application opened it, and only
    // it.
    const customer = await query<{ application_id: string }>(
      `select application_id from customer where id = $1`,
      [account.customer_id]
    );
    applicationId = customer.rows[0]?.application_id ?? null;
  }
  if (!applicationId) return [];

  // A refund inserts its own payment_line/payment_account_line row, on its
  // own `payment` (kind = 'refund') — so one query already carries both the
  // credit that opened the account and any debit paid back against it,
  // ordered as they happened. A voided payment's money never moved, so it
  // is excluded the same way it always has been.
  if (account.is_membership_default) {
    // The only two membership-default account types this schema seeds
    // (migrations 0010, 0018); an administrator-added default account has
    // no fee component to read a transaction from.
    const componentCode =
      account.type_code === 'shares'
        ? 'shares'
        : account.type_code === 'msa'
          ? 'msa_deposit'
          : null;
    if (!componentCode) return [];

    const rows = await query<{
      kind: 'payment' | 'refund';
      amount: string;
      currency: string;
      received_at: Date;
    }>(
      `select p.kind, pl.amount, p.currency, p.received_at
         from payment_line pl
         join payment p on p.id = pl.payment_id
        where p.application_id = $1
          and p.voided_at is null
          and pl.component_code = $2
        order by p.received_at`,
      [applicationId, componentCode]
    );
    return rows.rows.map(r => ({
      type: r.kind === 'refund' ? 'debit' : 'credit',
      amount: r.amount,
      currency: r.currency,
      occurredAt: r.received_at,
      description: r.kind === 'refund' ? 'Refund' : 'Opening deposit',
    }));
  }

  const rows = await query<{
    kind: 'payment' | 'refund';
    amount: string;
    currency: string;
    received_at: Date;
  }>(
    `select p.kind, pal.amount, p.currency, p.received_at
       from payment_account_line pal
       join payment p on p.id = pal.payment_id
      where p.application_id = $1
        and pal.account_type_id = $2
        and p.voided_at is null
      order by p.received_at`,
    [applicationId, account.account_type_id]
  );
  return rows.rows.map(r => ({
    type: r.kind === 'refund' ? 'debit' : 'credit',
    amount: r.amount,
    currency: r.currency,
    occurredAt: r.received_at,
    description: r.kind === 'refund' ? 'Refund' : 'Opening deposit',
  }));
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
    application_kind: string;
    membership_type_id: string;
    status: string;
  }>(
    `select application_kind, membership_type_id, status
       from membership_application where id = $1`,
    [applicationId]
  );
  if (application.rows.length === 0) {
    throw new PaymentError('That application no longer exists.', 'not_found');
  }
  // A customer_account application (S-614) also carries membership_type_id
  // — it reuses that type's field configuration to capture the applicant —
  // but is charged for the account(s) it opens, the same as an
  // additional_account application, via amountDueForAdditionalAccount, not
  // against that type's own fee schedule.
  if (application.rows[0].application_kind === 'customer_account') {
    throw new PaymentError(
      'This application opens an account, and is charged against what is ' +
        'due to open it instead.'
    );
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

// S-613, phase 6: what is due for an additional_account application — the
// selected account types' own minimum_opening_amount, not a fee schedule
// (officer direction: nothing new for an administrator to configure here).
// A separate type and function rather than folding into AmountDue/
// amountDueForApplication above: the caller already knows which kind of
// application it is holding (a membership-only page and an
// additional-account-only page, never both), so there is nothing for one
// function to dispatch on that the caller does not already know — and
// widening AmountDue into a union would ripple through every membership
// page that reads it today for no reader's benefit.
export interface AccountDueComponent {
  accountTypeId: string;
  code: string;
  label: string;
  amount: string;
}

export interface AccountAmountDue {
  components: AccountDueComponent[];
  // Every selected account type's opening amount is required — there is no
  // "optional" component here the way a membership fee schedule has one.
  expectedTotal: string;
}

export async function amountDueForAdditionalAccount(
  applicationId: string
): Promise<AccountAmountDue> {
  const application = await query<{ application_kind: string }>(
    `select application_kind from membership_application where id = $1`,
    [applicationId]
  );
  if (application.rows.length === 0) {
    throw new PaymentError('That application no longer exists.', 'not_found');
  }
  // Both additional_account (S-612) and customer_account (S-614) open the
  // account(s) selected against them, at the account type's own opening
  // amount — a customer_account row also carries membership_type_id (it
  // reuses that type's field configuration to capture the applicant), but
  // that is not a fee schedule to charge, only a form to render.
  if (
    application.rows[0].application_kind !== 'additional_account' &&
    application.rows[0].application_kind !== 'customer_account'
  ) {
    throw new PaymentError(
      'This application opens accounts for a membership, and is charged ' +
        'through the membership fee schedule instead.'
    );
  }

  const selected = await query<{
    account_type_id: string;
    code: string;
    name: string;
    minimum_opening_amount: string;
  }>(
    `select t.id as account_type_id, t.code, t.name, t.minimum_opening_amount
       from application_account_selection s
       join account_type t on t.id = s.account_type_id
      where s.application_id = $1
      order by t.sort_order, t.name`,
    [applicationId]
  );

  const components = selected.rows.map(r => ({
    accountTypeId: r.account_type_id,
    code: r.code,
    label: r.name,
    amount: r.minimum_opening_amount,
  }));

  return {
    components,
    expectedTotal: fromCents(
      components.reduce((total, c) => total + toCents(c.amount), 0)
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
  // Entrance and Takaful cannot differ from the schedule at all (fixed, no
  // reason can override it); Shares and the MSA deposit may exceed their
  // schedule minimum freely, no reason needed. This is required only if
  // some OTHER required component (in practice, none today) differs from
  // its schedule amount.
  varianceReason?: string;
  // Required only when method is 'cash' and the total is strictly above
  // config's payment.cash_source_of_fund_threshold.
  sourceOfFund?: string;
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

  let total = 0;
  // Variance-with-reason is now the fallback for a component that is
  // neither fixed nor floored (in practice, only the processing fee, which
  // FRD 7.9 leaves at zero / not applicable) — entrance, Takaful, Shares and
  // the MSA deposit are each governed by their own rule below instead, none
  // of which a reason can override.
  let otherVariance = 0;
  const varianceReason = (input.varianceReason ?? '').trim();
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

    const scheduledCents = toCents(component.amount);
    if (FIXED_FEE_COMPONENTS.has(component.code)) {
      if (cents !== scheduledCents) {
        throw new PaymentError(
          `${component.label} is fixed at ${component.amount} by the fee ` +
            'schedule and cannot be recorded as anything else.'
        );
      }
    } else if (FLOOR_FEE_COMPONENTS.has(component.code)) {
      // Optional and untouched (msa_deposit skipped entirely) stays at
      // zero, not "below the minimum" — the floor only binds once a payer
      // has chosen to pay it at all. A required floor component (shares)
      // has no such exemption: zero is still below the minimum.
      const skippedOptional =
        component.requirement === 'optional' && cents === 0;
      if (!skippedOptional && cents < scheduledCents) {
        throw new PaymentError(
          `${component.label} cannot be less than the ${component.amount} ` +
            'minimum set by the fee schedule.'
        );
      }
    } else if (component.requirement === 'required') {
      otherVariance += cents - scheduledCents;
    }

    total += cents;

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

  // S-501: a difference from the schedule is allowed, but never by accident
  // — for whatever is left that isn't already governed by a fixed or a
  // floor rule above.
  if (otherVariance !== 0 && varianceReason === '') {
    const word = otherVariance > 0 ? 'more' : 'less';
    throw new PaymentError(
      `That is ${fromCents(Math.abs(otherVariance))} ${word} than the fee ` +
        'schedule. Say why before recording it.'
    );
  }

  // Informational only from here on (nothing above still gates on it): what
  // the financial event and the audit trail record as the difference from
  // the schedule, over the payment as a whole.
  const variance = total - toCents(due.expectedTotal);

  const sourceOfFund = (input.sourceOfFund ?? '').trim();
  await requireSourceOfFundIfCash(input.method, total, sourceOfFund);

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
            method_reference, total_amount, variance_reason, source_of_fund,
            received_at, recorded_by, recorded_by_role)
         values ($1, 'payment', $2, $3, $4, $5, $6, $7, $8, coalesce($9, now()), $10, $11)
         returning id`,
        [
          allocation.id,
          input.applicationId,
          due.feeVersionId,
          input.method,
          (input.methodReference ?? '').trim(),
          fromCents(total),
          varianceReason,
          sourceOfFund,
          input.receivedAt ?? null,
          principal.userId,
          principal.roleNames.join(', '),
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

// S-613, phase 6: recording payment for an additional_account application.
// Deliberately a separate function from recordPayment above rather than a
// branch inside it — the input shape genuinely differs (amounts keyed by
// account_type_id, not FeeComponentCode), the same reason
// startAdditionalAccountApplication sits beside startApplication rather than
// inside it. What is shared (allocate the receipt, lock the application,
// refuse a second live payment, emit the audit trail and financial event) is
// still exactly the same sequence — it just writes payment_account_line
// instead of payment_line, and no fee_version_id.
export interface RecordAccountOpeningPaymentInput {
  applicationId: string;
  method: PaymentMethod;
  methodReference?: string;
  receivedAt?: Date;
  // Keyed by account_type_id — every selected account type needs an amount
  // entered, since none of them is optional the way a membership fee
  // schedule's own components can be. Each is a minimum
  // (account_type.minimum_opening_amount): less than it is refused
  // outright, with no reason able to override that; more than it needs no
  // reason either.
  amounts: Record<string, string>;
  // Optional free text an officer may still record; nothing here requires it.
  varianceReason?: string;
  // Required only when method is 'cash' and the total is strictly above
  // config's payment.cash_source_of_fund_threshold.
  sourceOfFund?: string;
}

export async function recordAccountOpeningPayment(
  input: RecordAccountOpeningPaymentInput,
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

  // Mirrors recordPayment's own status guard: a decided application is not
  // one to take money on.
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

  const due = await amountDueForAdditionalAccount(input.applicationId);
  if (due.components.length === 0) {
    throw new PaymentError('This application has no account type selected.');
  }
  const chargeable = new Map(due.components.map(c => [c.accountTypeId, c]));

  for (const accountTypeId of Object.keys(input.amounts)) {
    if (!chargeable.has(accountTypeId)) {
      throw new PaymentError(
        'That account type is not part of this application.'
      );
    }
  }

  let total = 0;
  const lines: Array<{
    accountTypeId: string;
    code: string;
    name: string;
    amount: string;
    sortOrder: number;
  }> = [];

  due.components.forEach((component, index) => {
    const raw = (input.amounts[component.accountTypeId] ?? '0').trim() || '0';
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
    if (cents <= 0) {
      // Not "the wrong amount" — that is the minimum check below. This is
      // "nothing was entered for an account being opened", which nothing
      // excuses, a reason least of all.
      throw new PaymentError(`Enter what was paid to open ${component.label}.`);
    }

    // Officer feedback: this amount IS a minimum (it is the account type's
    // own minimum_opening_amount) — paying more is always the payer's own
    // choice and needs no explanation; paying less is refused outright,
    // with no reason able to override it.
    const scheduledCents = toCents(component.amount);
    if (cents < scheduledCents) {
      throw new PaymentError(
        `${component.label} cannot be less than the ${component.amount} ` +
          'minimum to open it.'
      );
    }

    total += cents;
    lines.push({
      accountTypeId: component.accountTypeId,
      code: component.code,
      name: component.label,
      amount: fromCents(cents),
      sortOrder: index,
    });
  });

  // No longer required to justify paying more than the minimum (above) —
  // kept as a free-text field an officer may still fill in for their own
  // reasons, and stored the same way either way.
  const varianceReason = (input.varianceReason ?? '').trim();
  // Informational only: what the financial event and the audit trail record
  // as the difference from the total due — nothing above gates on it.
  const variance = total - toCents(due.expectedTotal);

  const sourceOfFund = (input.sourceOfFund ?? '').trim();
  await requireSourceOfFundIfCash(input.method, total, sourceOfFund);

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
            method_reference, total_amount, variance_reason, source_of_fund,
            received_at, recorded_by, recorded_by_role)
         values ($1, 'payment', $2, null, $3, $4, $5, $6, $7, coalesce($8, now()), $9, $10)
         returning id`,
        [
          allocation.id,
          input.applicationId,
          input.method,
          (input.methodReference ?? '').trim(),
          fromCents(total),
          varianceReason,
          sourceOfFund,
          input.receivedAt ?? null,
          principal.userId,
          principal.roleNames.join(', '),
        ]
      );
      const paymentId = inserted.rows[0].id;

      for (const line of lines) {
        await client.query(
          `insert into payment_account_line
             (payment_id, account_type_id, account_type_code, account_type_name,
              amount, sort_order)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            paymentId,
            line.accountTypeId,
            line.code,
            line.name,
            line.amount,
            line.sortOrder,
          ]
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
          currency: 'MUR',
          totalAmount: fromCents(total),
          method: input.method,
          accountTypes: lines.map(l => ({
            accountTypeId: l.accountTypeId,
            code: l.code,
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
  // S-613, phase 6: refunding an account-opening payment (no fee schedule,
  // itemised in payment_account_line instead) is its own increment, not yet
  // built — voidPayment (a full, whole-receipt reversal) already covers
  // "this was a mistake" for one in the meantime.
  if (!original.feeVersionId) {
    throw new PaymentError(
      'A partial refund is not yet available for this kind of payment. ' +
        'Void the receipt instead if it was taken in error.'
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
            variance_reason, recorded_by, recorded_by_role)
         values ($1, 'refund', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
          principal.roleNames.join(', '),
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
  // Null for a payment against an additional_account application (S-613),
  // which was never charged against a fee schedule to begin with.
  if (!payment.feeVersionId) return null;
  return feeVersionById(payment.feeVersionId);
}
