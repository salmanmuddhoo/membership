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
}

// One statement, three findings, so the period is read once and the results
// cannot disagree with each other.
//
// `missing` looks redundant — receipt_number has a unique serial and nothing
// may delete a row, so a hole in the run is impossible. That is exactly why it
// is checked: a control that only reports what the schema already guarantees
// is a control nobody has confirmed is running. If this ever returns a row,
// something happened outside this application.
const EXCEPTIONS = `
  with window_rows as (
    select r.*, u.display_name as allocated_by_name
      from receipt_number r
      join app_user u on u.id = r.allocated_by
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
           allocated_by_name as who
      from window_rows
     where state <> 'issued'
  ),
  duplicates as (
    select 'duplicate' as kind, receipt_no, min(serial_no) as serial_no,
           count(*)::text || ' rows share this number' as reason,
           min(allocated_at) as at, null::text as who
      from window_rows
     group by receipt_no
    having count(*) > 1
  ),
  missing as (
    select 'missing' as kind,
           'RCT-' || lpad(s::text, 6, '0') as receipt_no,
           s as serial_no,
           '' as reason, null::timestamptz as at, null::text as who
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
              -- Net, not gross: a refund is money that went back out, and a
              -- Treasurer reconciling a day's takings needs the figure the
              -- cash box should hold.
              sum(case when p.kind = 'refund' then -p.total_amount
                       else p.total_amount end)
                filter (where r.state = 'issued' and p.voided_at is null)
                as total
         from receipt_number r
         left join payment p on p.receipt_number_id = r.id
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
      reason: e.reason ?? '',
      at: e.at,
      who: e.who,
    })),
  };
}
