// The cash drawer (S-2001, S-2002, FRD 14).
//
// A cashier opens their drawer with a float, and closes it against a
// count. What it should hold is never typed in: it is the float plus the
// cash movements the database attributed to the session while it was open
// (migration 0084 — a trigger on posting and on recording a fee receipt,
// so no path that moves cash has to remember to say so). The difference
// between the count and that figure is the over or short, fixed on the
// session at closing and never recomputed.
//
// A cashier has one drawer open at a time and closes only their own; a
// holder of cash.view reads every session. Opening and closing are audited
// like any act on money.
import { recordAudit } from '../access/audit';
import type { Principal } from '../access/principal';
import { query, withTransaction } from '../db/pool';
import { fromCents, MoneyError, toCents } from '../payments/money';

export const PERMISSION_SESSION = 'cash.session';
export const PERMISSION_VIEW = 'cash.view';

export class CashSessionError extends Error {
  constructor(
    message: string,
    readonly reason:
      'invalid' | 'forbidden' | 'conflict' | 'not_found' = 'invalid'
  ) {
    super(message);
    this.name = 'CashSessionError';
  }
}

export interface CashSession {
  id: string;
  cashierId: string;
  cashierName: string;
  openedAt: Date;
  openingFloat: string;
  closedAt: Date | null;
  closingCount: string | null;
  expectedAtClose: string | null;
  overShort: string | null;
  note: string;
}

// One cash movement attributed to a drawer: a transaction or a fee
// receipt, in or out, in the order it happened.
export interface CashMovement {
  kind: 'transaction' | 'payment';
  id: string;
  reference: string;
  what: string;
  direction: 'in' | 'out';
  amount: string;
  at: Date;
  receiptNo: string | null;
}

export interface DrawerFigures {
  openingFloat: string;
  cashIn: string;
  cashOut: string;
  expected: string;
  movements: CashMovement[];
}

interface SessionRow {
  id: string;
  cashier_user_id: string;
  cashier_name: string;
  opened_at: Date;
  opening_float: string;
  closed_at: Date | null;
  closing_count: string | null;
  expected_at_close: string | null;
  over_short: string | null;
  note: string;
}

const SELECT = `
  select s.id, s.cashier_user_id, u.display_name as cashier_name,
         s.opened_at, s.opening_float::text as opening_float, s.closed_at,
         s.closing_count::text as closing_count,
         s.expected_at_close::text as expected_at_close,
         s.over_short::text as over_short, s.note
    from cash_session s
    join app_user u on u.id = s.cashier_user_id
`;

function assemble(r: SessionRow): CashSession {
  return {
    id: r.id,
    cashierId: r.cashier_user_id,
    cashierName: r.cashier_name,
    openedAt: r.opened_at,
    openingFloat: r.opening_float,
    closedAt: r.closed_at,
    closingCount: r.closing_count,
    expectedAtClose: r.expected_at_close,
    overShort: r.over_short,
    note: r.note,
  };
}

function amountCents(value: string, what: string): number {
  try {
    return toCents(value);
  } catch (err) {
    if (err instanceof MoneyError) {
      throw new CashSessionError(
        `${value || 'That'} is not an amount for the ${what}.`
      );
    }
    throw err;
  }
}

/** The caller's own open drawer, or null. */
export async function openSessionFor(
  userId: string
): Promise<CashSession | null> {
  const result = await query<SessionRow>(
    `${SELECT} where s.cashier_user_id = $1 and s.closed_at is null`,
    [userId]
  );
  return result.rows[0] ? assemble(result.rows[0]) : null;
}

export async function sessionById(id: string): Promise<CashSession | null> {
  const result = await query<SessionRow>(`${SELECT} where s.id = $1`, [id]);
  return result.rows[0] ? assemble(result.rows[0]) : null;
}

/** Open the caller's drawer with a float. One at a time. */
export async function openSession(
  input: { openingFloat: string; note?: string },
  principal: Principal
): Promise<CashSession> {
  if (!principal.permissions.has(PERMISSION_SESSION)) {
    throw new CashSessionError(
      'You do not have permission to open a cash drawer.',
      'forbidden'
    );
  }
  const cents = amountCents(input.openingFloat, 'float');
  const already = await openSessionFor(principal.userId);
  if (already) {
    throw new CashSessionError('Your drawer is already open.', 'conflict');
  }
  const id = await withTransaction(async client => {
    const inserted = await client.query<{ id: string }>(
      `insert into cash_session (cashier_user_id, opening_float, note)
       values ($1, $2, $3) returning id`,
      [principal.userId, fromCents(cents), (input.note ?? '').trim()]
    );
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'cash.session.opened',
        entityType: 'cash_session',
        entityId: inserted.rows[0].id,
        newValue: { opening_float: fromCents(cents) },
      },
      client
    );
    return inserted.rows[0].id;
  });
  return (await sessionById(id))!;
}

/**
 * What a drawer should hold, from the movements attributed to it: the
 * float, plus cash the ledger credited to a member's account or a fee
 * receipt took, less cash the ledger debited or a refund gave back. A
 * voided fee receipt was never taken.
 */
export async function drawerFigures(sessionId: string): Promise<DrawerFigures> {
  const session = await sessionById(sessionId);
  if (!session) {
    throw new CashSessionError('That drawer no longer exists.', 'not_found');
  }
  const result = await query<{
    kind: 'transaction' | 'payment';
    id: string;
    reference: string;
    what: string;
    direction: 'in' | 'out';
    amount: string;
    at: Date;
    receipt_no: string | null;
  }>(
    `select 'transaction' as kind, t.id, t.reference,
            case t.kind when 'deposit' then 'Deposit'
                        when 'withdrawal' then 'Withdrawal'
                        when 'transfer_leg' then 'Transfer'
                        when 'reversal' then 'Reversal'
                        when 'closure' then 'Account closure'
                        when 'resignation' then 'Resignation'
                        else 'Demised claim' end as what,
            case when fe.payload->>'direction' = 'credit' then 'in' else 'out' end
              as direction,
            t.amount::text as amount, t.posted_at as at, rn.receipt_no
       from transaction t
       join financial_event fe
         on fe.transaction_id = t.id and fe.event_type = 'transaction.posted'
       left join receipt_number rn on rn.id = t.receipt_number_id
      where t.cash_session_id = $1 and t.status = 'posted'
     union all
     select 'payment', p.id, coalesce(a.reference, ''),
            case p.kind when 'refund' then 'Fee refund' else 'Fee receipt' end,
            case p.kind when 'refund' then 'out' else 'in' end,
            p.total_amount::text, p.received_at, rn.receipt_no
       from payment p
       left join membership_application a on a.id = p.application_id
       left join receipt_number rn on rn.id = p.receipt_number_id
      where p.cash_session_id = $1 and p.voided_at is null
     order by at`,
    [sessionId]
  );
  let cashIn = 0;
  let cashOut = 0;
  for (const row of result.rows) {
    const cents = toCents(row.amount);
    if (row.direction === 'in') cashIn += cents;
    else cashOut += cents;
  }
  const floatCents = toCents(session.openingFloat);
  return {
    openingFloat: session.openingFloat,
    cashIn: fromCents(cashIn),
    cashOut: fromCents(cashOut),
    expected: fromCents(floatCents + cashIn - cashOut),
    movements: result.rows.map(r => ({
      kind: r.kind,
      id: r.id,
      reference: r.reference,
      what: r.what,
      direction: r.direction,
      amount: r.amount,
      at: r.at,
      receiptNo: r.receipt_no,
    })),
  };
}

/**
 * Close the caller's drawer against a count. The expected figure is read
 * now and fixed on the session with the count and the difference.
 */
export async function closeSession(
  input: { closingCount: string; note?: string },
  principal: Principal
): Promise<CashSession> {
  if (!principal.permissions.has(PERMISSION_SESSION)) {
    throw new CashSessionError(
      'You do not have permission to close a cash drawer.',
      'forbidden'
    );
  }
  const counted = amountCents(input.closingCount, 'count');
  const session = await openSessionFor(principal.userId);
  if (!session) {
    throw new CashSessionError('You have no drawer open.', 'conflict');
  }
  const figures = await drawerFigures(session.id);
  const expected = toCents(figures.expected);
  const overShort = counted - expected;
  await withTransaction(async client => {
    const updated = await client.query(
      `update cash_session
          set closed_at = now(), closing_count = $2, expected_at_close = $3,
              over_short = $4,
              note = case when $5 = '' then note else $5 end
        where id = $1 and cashier_user_id = $6 and closed_at is null`,
      [
        session.id,
        fromCents(counted),
        fromCents(expected),
        fromCents(overShort),
        (input.note ?? '').trim(),
        principal.userId,
      ]
    );
    if (updated.rowCount === 0) {
      throw new CashSessionError('Your drawer is already closed.', 'conflict');
    }
    await recordAudit(
      {
        actorUserId: principal.userId,
        actorDescription: principal.email,
        action: 'cash.session.closed',
        entityType: 'cash_session',
        entityId: session.id,
        previousValue: { opening_float: session.openingFloat },
        newValue: {
          closing_count: fromCents(counted),
          expected: fromCents(expected),
          over_short: fromCents(overShort),
          cash_in: figures.cashIn,
          cash_out: figures.cashOut,
          movements: figures.movements.length,
        },
      },
      client
    );
  });
  return (await sessionById(session.id))!;
}

/** Every session in a period, newest first, for a holder of cash.view. */
export async function listSessions(filter: {
  from?: Date | null;
  to?: Date | null;
  cashierId?: string | null;
}): Promise<CashSession[]> {
  const result = await query<SessionRow>(
    `${SELECT}
      where ($1::timestamptz is null or s.opened_at >= $1)
        and ($2::timestamptz is null or s.opened_at < $2)
        and ($3::uuid is null or s.cashier_user_id = $3)
      order by s.opened_at desc`,
    [filter.from ?? null, filter.to ?? null, filter.cashierId ?? null]
  );
  return result.rows.map(assemble);
}
