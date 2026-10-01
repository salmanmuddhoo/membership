// Receipt numbers, and the evidence that none is missing (S-502, S-506).
//
// A receipt number is not a counter reading. It is a claim that money was
// taken, and the sequence of those claims is what an auditor checks. So the
// number is allocated as a COMMITTED ROW BEFORE the payment is attempted,
// on its own connection, deliberately outside the payment's transaction.
//
// The alternative — nextval() inside the payment transaction — looks simpler
// and cannot work. Sequences are non-transactional: a payment that rolls back
// still consumed the number, and nothing anywhere records that it did. The
// sequence would then have a hole that no query can explain, which is the
// exact failure S-502 exists to prevent. Here, a payment that fails leaves the
// allocation row behind in a non-issued state, and reconciliation reports it.
import type { PoolClient } from 'pg';
import { query } from '../db/pool';

export type ReceiptState = 'allocated' | 'issued' | 'abandoned' | 'void';

export interface ReceiptAllocation {
  id: string;
  receiptNo: string;
  serialNo: number;
}

// Take the next number. Committed on its own, so it survives whatever happens
// to the payment that asked for it.
export async function allocateReceiptNumber(
  userId: string
): Promise<ReceiptAllocation> {
  const result = await query<{
    id: string;
    receipt_no: string;
    serial_no: string;
  }>(
    `insert into receipt_number (allocated_by)
     values ($1)
     returning id, receipt_no, serial_no`,
    [userId]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    receiptNo: row.receipt_no,
    // bigint arrives as a string from the driver; the sequence will not reach
    // the point where this stops being exact.
    serialNo: Number(row.serial_no),
  };
}

// Mark the number spent. Runs inside the payment's transaction so that the
// receipt is issued if and only if the payment it belongs to committed.
export async function markReceiptIssued(
  receiptNumberId: string,
  client: PoolClient
): Promise<void> {
  await client.query(
    `update receipt_number
        set state = 'issued', settled_at = now()
      where id = $1 and state = 'allocated'`,
    [receiptNumberId]
  );
}

// Close off a number whose payment never happened.
//
// Best effort by design: it runs after a failure, on a connection that may
// itself be the thing that failed, and it must not replace the original error
// with its own. An allocation nobody managed to close stays 'allocated' and
// reconciliation reports it as unexplained, which is the honest outcome.
export async function abandonReceiptNumber(
  receiptNumberId: string,
  reason: string
): Promise<void> {
  try {
    await query(
      `update receipt_number
          set state = 'abandoned', settled_at = now(), reason = $2
        where id = $1 and state = 'allocated'`,
      [receiptNumberId, reason.slice(0, 500)]
    );
  } catch (error) {
    console.error(
      '[receipts] could not close allocation',
      receiptNumberId,
      error
    );
  }
}

// ---------------------------------------------------------------------------
// S-506 · Reconciliation
// ---------------------------------------------------------------------------
export type ExceptionKind = 'unissued' | 'void' | 'duplicate' | 'missing';

export interface ReceiptException {
  kind: ExceptionKind;
  receiptNo: string;
  serialNo: number;
  // The receipt behind the finding, where there is one. A void has a payment
  // or a transaction to open; an abandoned allocation never became either,
  // and reads as a dead end because that is what it is.
  paymentId: string | null;
  transactionId: string | null;
  // Why, where the system knows. Empty is itself a finding: a number that went
  // nowhere for no recorded reason is the one an auditor asks about.
  reason: string;
  at: Date | null;
  who: string | null;
}

export interface Reconciliation {
  from: Date;
  to: Date;
  // The unbroken run the period covers, so "17 receipts, 1 exception" can be
  // read against something.
  firstSerial: number | null;
  lastSerial: number | null;
  issuedCount: number;
  issuedTotal: string;
  exceptions: ReceiptException[];
}

interface ExceptionRow {
  kind: ExceptionKind;
  receipt_no: string;
  serial_no: string;
  reason: string | null;
  at: Date | null;
  who: string | null;
  payment_id: string | null;
  transaction_id: string | null;
}

// One statement, three findings, so the period is read once and the results
// cannot disagree with each other.
//
// A new member's opening deposits are carried from their fee receipt under
// that receipt's own number (post_opening_balances, 0066) — one receipt,
// shown once. They are the receipt, not a second use of its number, so the
// joins leave them out; before they did, every approved member's fee
// receipt read as a duplicate and was counted once per account it opened
// (QA-03).
//
// `missing` looks redundant — receipt_number has a unique serial and nothing
// may delete a row, so a hole in the run is impossible. That is exactly why it
// is checked: a control that only reports what the schema already guarantees
// is a control nobody has confirmed is running. If this ever returns a row,
// something happened outside this application.
const EXCEPTIONS = `
  with window_rows as (
    select r.*, u.display_name as allocated_by_name, p.id as payment_id,
           t.id as transaction_id
      from receipt_number r
      join app_user u on u.id = r.allocated_by
      left join payment p on p.receipt_number_id = r.id
      left join transaction t
        on t.receipt_number_id = r.id
       and t.payment_line_id is null
       and t.payment_account_line_id is null
     where r.allocated_at >= $1 and r.allocated_at < $2
  ),
  bounds as (
    select min(serial_no) as lo, max(serial_no) as hi from window_rows
  ),
  unissued as (
    select case when state = 'void' then 'void' else 'unissued' end as kind,
           receipt_no, serial_no,
           coalesce(reason, '') as reason,
           coalesce(settled_at, allocated_at) as at,
           allocated_by_name as who,
           payment_id, transaction_id
      from window_rows
     where state <> 'issued'
  ),
  duplicates as (
    select 'duplicate' as kind, receipt_no, min(serial_no) as serial_no,
           count(*)::text || ' rows share this number' as reason,
           min(allocated_at) as at, null::text as who,
           min(payment_id::text)::uuid as payment_id,
           min(transaction_id::text)::uuid as transaction_id
      from window_rows
     group by receipt_no
    having count(*) > 1
  ),
  missing as (
    select 'missing' as kind,
           'RCT-' || lpad(s::text, 6, '0') as receipt_no,
           s as serial_no,
           '' as reason, null::timestamptz as at, null::text as who,
           null::uuid as payment_id, null::uuid as transaction_id
      from bounds, generate_series(bounds.lo, bounds.hi) as s
     where bounds.lo is not null
       and not exists (select 1 from receipt_number r where r.serial_no = s)
  )
  select * from unissued
  union all select * from duplicates
  union all select * from missing
  order by serial_no
`;

export async function reconcileReceipts(
  from: Date,
  to: Date
): Promise<Reconciliation> {
  const [summary, exceptions] = await Promise.all([
    query<{
      lo: string | null;
      hi: string | null;
      issued: string;
      total: string | null;
    }>(
      `select min(r.serial_no) as lo,
              max(r.serial_no) as hi,
              count(*) filter (where r.state = 'issued') as issued,
              -- Net, not gross: a refund or a withdrawal is money that went
              -- back out, and a Treasurer reconciling a day's takings needs
              -- the figure the cash box should hold. A transaction's receipt
              -- counts by the direction of its entry (S-1601); a leg between
              -- two accounts here moved nothing outside the Society.
              sum(case
                    when p.id is not null then
                      case when p.kind = 'refund' then -p.total_amount
                           else p.total_amount end
                    when t.method = 'internal_transfer' then 0
                    when e.direction = 'credit' then t.amount
                    else -t.amount
                  end)
                filter (where r.state = 'issued' and p.voided_at is null)
                as total
         from receipt_number r
         left join payment p on p.receipt_number_id = r.id
         left join transaction t
           on t.receipt_number_id = r.id
          and t.payment_line_id is null
          and t.payment_account_line_id is null
         -- One entry's direction, not a row per entry: a claim or a
         -- closure touching several accounts has an entry on each, and
         -- joining them all counted its receipt, and its amount, once per
         -- account.
         left join lateral (
           select direction from account_entry
            where transaction_id = t.id
            limit 1
         ) e on true
        where r.allocated_at >= $1 and r.allocated_at < $2`,
      [from, to]
    ),
    query<ExceptionRow>(EXCEPTIONS, [from, to]),
  ]);

  const row = summary.rows[0];

  return {
    from,
    to,
    firstSerial: row.lo === null ? null : Number(row.lo),
    lastSerial: row.hi === null ? null : Number(row.hi),
    issuedCount: Number(row.issued),
    issuedTotal: row.total ?? '0.00',
    exceptions: exceptions.rows.map(e => ({
      kind: e.kind,
      receiptNo: e.receipt_no,
      serialNo: Number(e.serial_no),
      paymentId: e.payment_id,
      transactionId: e.transaction_id,
      reason: e.reason ?? '',
      at: e.at,
      who: e.who,
    })),
  };
}

// ---------------------------------------------------------------------------
// Every receipt in a period (officer request): the fee receipts and every
// transaction's — deposit, withdrawal, transfer, closure, resignation,
// demised claim — in one list, each opening its sheet by number
// (/receipts/RCT-…, which finds the payment or the transaction behind it).
// ---------------------------------------------------------------------------
export type ReceiptKind =
  | 'payment'
  | 'refund'
  | 'deposit'
  | 'withdrawal'
  | 'transfer_leg'
  | 'closure'
  | 'resignation'
  | 'demise'
  | 'reversal';

export const RECEIPT_KIND_LABELS: Record<ReceiptKind, string> = {
  payment: 'Application payment',
  refund: 'Refund',
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  transfer_leg: 'Transfer',
  closure: 'Account closure',
  resignation: 'Resignation',
  demise: 'Demised claim',
  reversal: 'Reversal',
};

export interface ReceiptListRow {
  receiptNo: string;
  serialNo: number;
  state: ReceiptState;
  at: Date;
  kind: ReceiptKind;
  amount: string;
  // How the money moved: Cash, Cheque, Bank transfer, …
  methodName: string;
  holderName: string;
  memberNo: string | null;
}

export interface ReceiptListFilter {
  from: Date;
  to: Date;
  kind?: ReceiptKind;
  // A receipt number, a name or a member number, in part.
  search?: string;
  limit: number;
  offset: number;
}

// One row per number that became a receipt. The joins are the ones
// reconciliation uses: a new member's opening deposits carry their fee
// receipt's number and are that receipt, not another (QA-03), so they are
// left out; a transfer's receipt is on its debit leg. A number that never
// became a receipt has nothing to open and is reported under Exceptions.
const RECEIPT_ROWS = `
  select distinct on (r.id)
         r.receipt_no, r.serial_no, r.state,
         coalesce(p.received_at, t.posted_at, r.settled_at, r.allocated_at)
           as at,
         case when p.id is not null
              then case when p.kind = 'refund' then 'refund' else 'payment' end
              else t.kind end as kind,
         coalesce(p.total_amount, t.amount) as amount,
         coalesce(pm.name, '') as method_name,
         trim(coalesce(ap.values->>'name', '') || ' '
              || coalesce(ap.values->>'surname', '')) as holder_name,
         coalesce(m.member_no, am.member_no) as member_no
    from receipt_number r
    left join payment p on p.receipt_number_id = r.id
    left join transaction t
      on t.receipt_number_id = r.id
     and t.payment_line_id is null
     and t.payment_account_line_id is null
    left join payment_method pm on pm.code = coalesce(p.method, t.method)
    left join member m on m.id = coalesce(p.member_id, t.member_id)
    left join member am on am.application_id = p.application_id
    left join customer c on c.id = t.customer_id
    left join application_party ap
      on ap.application_id
           = coalesce(p.application_id, m.application_id, c.application_id)
     and ap.subject = 'applicant' and ap.ordinal = 1
   where r.allocated_at >= $1 and r.allocated_at < $2
     and (p.id is not null or t.id is not null)
   order by r.id, t.created_at nulls first
`;

export async function listReceipts(
  filter: ReceiptListFilter
): Promise<{ rows: ReceiptListRow[]; total: number }> {
  const params: unknown[] = [filter.from, filter.to];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (filter.kind) where.push(`kind = ${add(filter.kind)}`);
  const search = filter.search?.trim();
  if (search) {
    const like = add(`%${search.replace(/[\\%_]/g, c => `\\${c}`)}%`);
    where.push(
      `(receipt_no ilike ${like} or holder_name ilike ${like}
        or member_no ilike ${like})`
    );
  }
  const clause = where.length ? `where ${where.join(' and ')}` : '';
  const counted = await query<{ n: number }>(
    `select count(*)::int as n from (${RECEIPT_ROWS}) rows ${clause}`,
    params
  );
  const rows = await query<{
    receipt_no: string;
    serial_no: string;
    state: ReceiptState;
    at: Date;
    kind: ReceiptKind;
    amount: string;
    method_name: string;
    holder_name: string;
    member_no: string | null;
  }>(
    `select * from (${RECEIPT_ROWS}) rows ${clause}
      order by serial_no desc
      limit ${add(filter.limit)} offset ${add(filter.offset)}`,
    params
  );
  return {
    total: counted.rows[0]?.n ?? 0,
    rows: rows.rows.map(r => ({
      receiptNo: r.receipt_no,
      serialNo: Number(r.serial_no),
      state: r.state,
      at: r.at,
      kind: r.kind,
      amount: r.amount,
      methodName: r.method_name,
      holderName: r.holder_name,
      memberNo: r.member_no,
    })),
  };
}
