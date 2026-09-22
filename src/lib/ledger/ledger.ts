// The account ledger (S-1301, S-1302). Schema: migrations/0064_ledger.sql.
//
// A balance is the sum of an account's entries; account_balance is a cache of
// that sum, maintained by post_transaction() in the same database transaction
// as the entries. This module reads the cache, posts through the function, and
// gives the ledger-verify job what it needs to find and resolve any
// disagreement — always from the entries.
//
// Amounts cross this boundary as decimal strings, as every payment figure
// does (docs/payments.md): numeric(14, 2) through a JavaScript float is a
// rounding error waiting for a large enough figure.
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool';
import { recordAudit } from '../access/audit';
import { fromCents, toCents } from '../payments/money';

export interface LedgerActor {
  userId: string | null;
  description: string;
}

// A refusal the database itself raised — a transaction that is not in a
// postable state, an account that is closed, an unnamed actor. The message
// is PostgreSQL's own, because the function names what was wrong and there
// is nothing to add. Anything else that goes wrong is not a LedgerError and
// propagates as the driver raised it.
export class LedgerError extends Error {
  constructor(
    message: string,
    readonly reason: 'refused' | 'not_found'
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

const REFUSED = '23001'; // restrict_violation, raised by post_transaction()
const NOT_FOUND = 'P0002'; // no_data_found

function translate(err: unknown): never {
  const code = (err as { code?: string })?.code;
  const message = (err as { message?: string })?.message ?? 'ledger refused';
  if (code === REFUSED) throw new LedgerError(message, 'refused');
  if (code === NOT_FOUND) throw new LedgerError(message, 'not_found');
  throw err;
}

// pool.query() deliberately hides every driver error behind "the database is
// unavailable", which is right for a page and wrong here: the function's
// refusals are the caller's business. So the ledger's writes go through a
// client, whose errors arrive as PostgreSQL raised them.
async function onClient<T>(
  client: PoolClient | undefined,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  try {
    return client ? await fn(client) : await withTransaction(fn);
  } catch (err) {
    return translate(err);
  }
}

export interface AccountBalance {
  accountId: string;
  balance: string;
  entryCount: number;
  asOfSequenceNo: number | null;
  updatedAt: Date;
}

export interface AccountEntry {
  id: string;
  sequenceNo: number;
  transactionId: string;
  transactionReference: string;
  kind: string;
  direction: 'credit' | 'debit';
  amount: string;
  currency: string;
  // What the account stood at once this entry had posted.
  runningBalance: string;
  postedAt: Date;
  // When the money was taken — the transaction's capture time, which for an
  // entry carried from a Phase 1 receipt is that receipt's date (S-1303).
  occurredAt: Date;
  // What a statement line says (S-1309): "Opening deposit" for a carried
  // Phase 1 line, "Refund" for the reversal of one, "Deposit", or
  // "Reversal of TX-…".
  description: string;
  methodName: string;
  methodReference: string;
  reason: string;
  receiptNo: string | null;
  reversesReference: string | null;
  capturedByName: string;
}

export interface LedgerDrift {
  accountId: string;
  cached: string;
  computed: string;
  cachedEntries: number;
  actualEntries: number;
}

// Post a submitted or approved transaction. The caller has already decided it
// may — the account type's rules, the approval chain — and this is the one
// call that moves money. It runs inside the caller's transaction when one is
// given, so a service can post and do its own bookkeeping atomically.
export async function postTransaction(
  transactionId: string,
  actor: LedgerActor,
  client?: PoolClient
): Promise<void> {
  await onClient(client, async c => {
    await c.query('select post_transaction($1, $2, $3)', [
      transactionId,
      actor.userId,
      actor.description,
    ]);
  });
}

// The cached figure. Null for an account nothing has ever posted to — which
// is different from a balance of zero, and a caller may want to say so.
export async function accountBalance(
  accountId: string
): Promise<AccountBalance | null> {
  const result = await query<{
    account_id: string;
    balance: string;
    entry_count: string;
    as_of_sequence_no: string | null;
    updated_at: Date;
  }>(
    `select account_id, balance, entry_count, as_of_sequence_no, updated_at
       from account_balance
      where account_id = $1`,
    [accountId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    accountId: row.account_id,
    balance: row.balance,
    entryCount: Number(row.entry_count),
    asOfSequenceNo:
      row.as_of_sequence_no === null ? null : Number(row.as_of_sequence_no),
    updatedAt: row.updated_at,
  };
}

// Balances for every account a member holds, in one query, for the member
// page. An account with no entries reads as '0.00' here: on a list, a blank
// would look like a fault rather than a fact.
export async function memberBalances(
  memberId: string
): Promise<Map<string, string>> {
  const result = await query<{ account_id: string; balance: string | null }>(
    `select a.id as account_id, b.balance
       from account a
       left join account_balance b on b.account_id = a.id
      where a.member_id = $1`,
    [memberId]
  );
  return new Map(result.rows.map(r => [r.account_id, r.balance ?? '0.00']));
}

// Newest first, with the running balance computed from the entries themselves
// — not from the cache — so a statement built from this is exactly what the
// ledger says, whatever the cache does.
export async function accountEntries(
  accountId: string,
  options: { limit?: number; beforeSequenceNo?: number } = {}
): Promise<AccountEntry[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const result = await query<{
    id: string;
    sequence_no: string;
    transaction_id: string;
    reference: string;
    kind: string;
    direction: 'credit' | 'debit';
    amount: string;
    currency: string;
    running_balance: string;
    posted_at: Date;
    created_at: Date;
    carried: boolean;
    reverses_carried: boolean;
    method_name: string;
    method_reference: string;
    reason: string;
    receipt_no: string | null;
    reverses_reference: string | null;
    captured_by_name: string;
    counterpart: string | null;
  }>(
    `with running as (
       select e.id, e.sequence_no, e.transaction_id, e.direction, e.amount,
              e.posted_at,
              sum(case e.direction when 'credit' then e.amount else -e.amount end)
                over (order by e.sequence_no) as running_balance
         from account_entry e
        where e.account_id = $1
     )
     select r.id, r.sequence_no, r.transaction_id, t.reference, t.kind,
            r.direction, r.amount, t.currency, r.running_balance, r.posted_at,
            t.created_at,
            (t.payment_line_id is not null
             or t.payment_account_line_id is not null) as carried,
            (o.payment_line_id is not null
             or o.payment_account_line_id is not null) as reverses_carried,
            pm.name as method_name,
            coalesce(t.method_reference, '') as method_reference,
            coalesce(t.reason, '') as reason,
            rn.receipt_no,
            o.reference as reverses_reference,
            u.display_name as captured_by_name,
            coalesce(t.payee_name,
                     coalesce(la.account_no, lm.member_no) || ' · ' || lt.name)
              as counterpart
       from running r
       join transaction t on t.id = r.transaction_id
       join payment_method pm on pm.code = t.method
       join app_user u on u.id = t.captured_by
       left join transaction o on o.id = t.reverses_id
       left join receipt_number rn on rn.id = t.receipt_number_id
       left join transaction l
         on l.transfer_id = t.transfer_id and l.id <> t.id
       left join account la on la.id = l.account_id
       left join account_type lt on lt.id = la.account_type_id
       left join member lm on lm.id = la.member_id
      where ($2::bigint is null or r.sequence_no < $2)
      order by r.sequence_no desc
      limit $3`,
    [accountId, options.beforeSequenceNo ?? null, limit]
  );
  return result.rows.map(r => ({
    id: r.id,
    sequenceNo: Number(r.sequence_no),
    transactionId: r.transaction_id,
    transactionReference: r.reference,
    kind: r.kind,
    direction: r.direction,
    amount: r.amount,
    currency: r.currency,
    runningBalance: r.running_balance,
    postedAt: r.posted_at,
    occurredAt: r.created_at,
    description: describe(r),
    methodName: r.method_name,
    methodReference: r.method_reference,
    reason: r.reason,
    receiptNo: r.receipt_no,
    reversesReference: r.reverses_reference,
    capturedByName: r.captured_by_name,
  }));
}

function describe(r: {
  kind: string;
  direction: 'credit' | 'debit';
  carried: boolean;
  reverses_carried: boolean;
  reverses_reference: string | null;
  counterpart: string | null;
}): string {
  if (r.kind === 'deposit') return r.carried ? 'Opening deposit' : 'Deposit';
  if (r.kind === 'transfer_leg') {
    const other = r.counterpart ? ` ${r.counterpart}` : '';
    return r.direction === 'debit'
      ? `Transfer to${other}`
      : `Transfer from${other}`;
  }
  if (r.kind === 'reversal') {
    return r.reverses_carried && r.carried
      ? 'Refund'
      : `Reversal of ${r.reverses_reference ?? 'a transaction'}`;
  }
  return r.kind.charAt(0).toUpperCase() + r.kind.slice(1).replace(/_/g, ' ');
}

export async function ledgerDrift(): Promise<LedgerDrift[]> {
  const result = await query<{
    account_id: string;
    cached: string;
    computed: string;
    cached_entries: string;
    actual_entries: string;
  }>('select * from ledger_drift()');
  return result.rows.map(r => ({
    accountId: r.account_id,
    cached: r.cached,
    computed: r.computed,
    cachedEntries: Number(r.cached_entries),
    actualEntries: Number(r.actual_entries),
  }));
}

export async function rebuildAccountBalance(
  accountId: string,
  client?: PoolClient
): Promise<string> {
  return onClient(client, async c => {
    const r = await c.query<{ balance: string }>(
      'select rebuild_account_balance($1) as balance',
      [accountId]
    );
    return r.rows[0].balance;
  });
}

// Phase 1's money becomes an account's opening balance (S-1303). Carries
// every unvoided receipt against an application into the ledger — fee lines
// and account lines as deposits, refund lines as reversals — and returns how
// many it posted. Each line is carried once, by a unique constraint, so the
// call is free to repeat: whoever opens an account, records a migrated
// balance or a refund calls it, and the first caller with an account to land
// on does the work. Schema: migrations/0066_opening_balances.sql.
export async function postOpeningBalances(
  applicationId: string,
  actor: LedgerActor,
  client?: PoolClient
): Promise<number> {
  return onClient(client, async c => {
    const r = await c.query<{ n: number }>(
      'select post_opening_balances($1, $2, $3) as n',
      [applicationId, actor.userId, actor.description]
    );
    return r.rows[0].n;
  });
}

export interface VerificationOutcome {
  drifted: LedgerDrift[];
  repaired: number;
}

// What the ledger-verify job does. A disagreement between the cache and the
// entries is repaired from the entries and recorded — one audit row per
// account, naming both figures — because a cache that drifted once is a bug
// somewhere, and the trail is how it gets found.
export async function verifyLedger(
  actor: LedgerActor
): Promise<VerificationOutcome> {
  const drifted = await ledgerDrift();
  let repaired = 0;
  for (const drift of drifted) {
    await withTransaction(async client => {
      const balance = await rebuildAccountBalance(drift.accountId, client);
      await recordAudit(
        {
          actorUserId: actor.userId,
          actorDescription: actor.description,
          action: 'ledger.repaired',
          entityType: 'account',
          entityId: drift.accountId,
          previousValue: {
            balance: drift.cached,
            entry_count: drift.cachedEntries,
          },
          newValue: { balance, entry_count: drift.actualEntries },
        },
        client
      );
    });
    repaired += 1;
  }
  return { drifted, repaired };
}

// S-1502 · Available, not merely current: the balance less what is already
// on its way out — every withdrawal (and, from S-1504, transfer-out leg)
// on the account that is submitted, under review or approved. A query, not
// an entry, so a rejection releases it by doing nothing.
export interface AvailableBalance {
  balance: string;
  pendingDebits: string;
  available: string;
}

export async function availableBalance(
  accountId: string
): Promise<AvailableBalance> {
  const result = await query<{
    balance: string;
    pending: string;
    available: string;
  }>(
    `select coalesce(b.balance, 0)::numeric(14, 2)::text as balance,
            p.pending::numeric(14, 2)::text as pending,
            (coalesce(b.balance, 0) - p.pending)::numeric(14, 2)::text as available
       from (select coalesce(sum(amount), 0) as pending
               from transaction
              where account_id = $1
                and (kind in ('withdrawal', 'closure', 'resignation', 'demise')
                     or (kind = 'transfer_leg' and leg_direction = 'debit'))
                and status in ('submitted', 'under_review', 'approved')) p
       left join account_balance b on b.account_id = $1`,
    [accountId]
  );
  const r = result.rows[0];
  return {
    balance: r.balance,
    pendingDebits: r.pending,
    available: r.available,
  };
}

// S-1604 · The statement: an account's entries between two dates, with the
// balance it opened and closed the range at, from the entries themselves.
export interface StatementLine {
  sequenceNo: number;
  transactionId: string;
  reference: string;
  postedAt: Date;
  description: string;
  debit: string | null;
  credit: string | null;
  balance: string;
  receiptNo: string | null;
  methodName: string;
  methodReference: string;
  reason: string;
}

export interface Statement {
  accountId: string;
  accountNo: string;
  accountTypeName: string;
  holderId: string;
  holderKind: 'member' | 'customer';
  holderName: string;
  memberNo: string | null;
  // Calendar days, inclusive, as the officer chose them (YYYY-MM-DD).
  from: string;
  to: string;
  openingBalance: string;
  closingBalance: string;
  totalCredits: string;
  totalDebits: string;
  lines: StatementLine[];
}

export async function accountStatement(
  accountId: string,
  from: string,
  to: string
): Promise<Statement | null> {
  const account = await query<{
    account_no: string;
    type_name: string;
    holder_id: string;
    holder_kind: 'member' | 'customer';
    holder_name: string;
    member_no: string | null;
  }>(
    `select coalesce(a.account_no, m.member_no) as account_no,
            t.name as type_name,
            coalesce(a.member_id, a.customer_id) as holder_id,
            case when a.member_id is not null then 'member' else 'customer' end
              as holder_kind,
            trim(coalesce(p.values->>'name', '') || ' '
                 || coalesce(p.values->>'surname', '')) as holder_name,
            m.member_no
       from account a
       join account_type t on t.id = a.account_type_id
       left join member m on m.id = a.member_id
       left join customer c on c.id = a.customer_id
       left join application_party p
         on p.application_id = coalesce(m.application_id, c.application_id)
        and p.subject = 'applicant' and p.ordinal = 1
      where a.id = $1`,
    [accountId]
  );
  const header = account.rows[0];
  if (!header) return null;

  const opening = await query<{ balance: string }>(
    `select coalesce(sum(case direction when 'credit' then amount else -amount end), 0)
              ::numeric(14, 2)::text as balance
       from account_entry
      where account_id = $1 and posted_at < $2::date`,
    [accountId, from]
  );
  const rows = await query<{
    sequence_no: string;
    transaction_id: string;
    reference: string;
    kind: string;
    direction: 'credit' | 'debit';
    amount: string;
    posted_at: Date;
    running_balance: string;
    carried: boolean;
    reverses_carried: boolean;
    reverses_reference: string | null;
    receipt_no: string | null;
    method_name: string;
    method_reference: string;
    reason: string;
    counterpart: string | null;
  }>(
    `with running as (
       select e.id, e.sequence_no, e.transaction_id, e.direction, e.amount,
              e.posted_at,
              sum(case e.direction when 'credit' then e.amount else -e.amount end)
                over (order by e.sequence_no) as running_balance
         from account_entry e
        where e.account_id = $1
     )
     select r.sequence_no, r.transaction_id, t.reference, t.kind, r.direction,
            r.amount, r.posted_at, r.running_balance,
            (t.payment_line_id is not null
             or t.payment_account_line_id is not null) as carried,
            (o.payment_line_id is not null
             or o.payment_account_line_id is not null) as reverses_carried,
            o.reference as reverses_reference,
            rn.receipt_no,
            pm.name as method_name,
            coalesce(t.method_reference, '') as method_reference,
            coalesce(t.reason, '') as reason,
            coalesce(t.payee_name,
                     coalesce(la.account_no, lm.member_no) || ' · ' || lt.name)
              as counterpart
       from running r
       join transaction t on t.id = r.transaction_id
       join payment_method pm on pm.code = t.method
       left join transaction o on o.id = t.reverses_id
       left join receipt_number rn on rn.id = t.receipt_number_id
       left join transaction l
         on l.transfer_id = t.transfer_id and l.id <> t.id
       left join account la on la.id = l.account_id
       left join account_type lt on lt.id = la.account_type_id
       left join member lm on lm.id = la.member_id
      where r.posted_at >= $2::date and r.posted_at < $3::date + 1
      order by r.sequence_no`,
    [accountId, from, to]
  );
  let credits = 0;
  let debits = 0;
  const lines = rows.rows.map(r => {
    const cents = toCents(r.amount);
    if (r.direction === 'credit') credits += cents;
    else debits += cents;
    return {
      sequenceNo: Number(r.sequence_no),
      transactionId: r.transaction_id,
      reference: r.reference,
      postedAt: r.posted_at,
      description: describe(r),
      debit: r.direction === 'debit' ? r.amount : null,
      credit: r.direction === 'credit' ? r.amount : null,
      balance: r.running_balance,
      receiptNo: r.receipt_no,
      methodName: r.method_name,
      methodReference: r.method_reference,
      reason: r.reason,
    };
  });
  const openingBalance = opening.rows[0]?.balance ?? '0.00';
  const closingBalance =
    lines.length > 0 ? lines[lines.length - 1].balance : openingBalance;
  return {
    accountId,
    accountNo: header.account_no,
    accountTypeName: header.type_name,
    holderId: header.holder_id,
    holderKind: header.holder_kind,
    holderName: header.holder_name,
    memberNo: header.member_no,
    from,
    to,
    openingBalance,
    closingBalance,
    totalCredits: fromCents(credits),
    totalDebits: fromCents(debits),
    lines,
  };
}
