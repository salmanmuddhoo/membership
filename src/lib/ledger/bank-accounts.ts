// What each of the Society's bank accounts stands at (S-1901, FRD 15):
// the opening balance the configuration records, carried forward by every
// posted transaction that names the account. Derived on request, never
// stored — the ledger is the one record of what moved, and a second figure
// kept beside it would be the thing that drifts.
//
// Direction comes from the posting itself (financial_event, the row
// post_transaction writes): money credited to a member's account came
// into the bank, money debited went out. A transfer between two accounts
// here moves nothing at the bank, so only a leg paid to a payee counts.
import {
  bankAccountById,
  listBankAccounts,
  type BankAccount,
} from '../config/reference';
import { query } from '../db/pool';

/**
 * The bank account a transaction names, checked to be one of the
 * Society's and active. Nothing named is nothing recorded — until S-1902
 * makes it mandatory wherever the method touches a bank. `fail` builds
 * the caller's own error, so a deposit refuses in a deposit's words.
 */
export async function resolveBankAccount(
  id: string | undefined,
  fail: (message: string) => Error
): Promise<string | null> {
  const trimmed = (id ?? '').trim();
  if (trimmed === '') return null;
  const account = await bankAccountById(trimmed);
  if (!account || !account.isActive) {
    throw fail("Choose one of the Society's bank accounts.");
  }
  return account.id;
}

/**
 * FRD 15's rule (S-1902): money that moves through a bank says which of
 * the Society's accounts it went through. Where the method touches a bank
 * and no account is named, refused in the caller's own words — beside
 * requireReference, which demands the reference the same way.
 */
export function requireBankAccount(
  method: { touchesBank: boolean; name: string },
  bankAccountId: string | null | undefined,
  fail: (message: string) => Error
): void {
  if (method.touchesBank && !bankAccountId) {
    throw fail(
      `Choose the Society's bank account the ${method.name.toLowerCase()} went through.`
    );
  }
}

export interface BankAccountBalance extends BankAccount {
  balance: string;
  // Posted transactions naming it, and the latest.
  movements: number;
  lastPostedAt: Date | null;
}

// A posted transaction that names a bank account, save the non-paying leg
// of an internal transfer (S-1901's own rule, shared with the report at
// src/lib/reports/definitions.ts so the two never drift apart).
const POSTED_BANK_MOVEMENT_WHERE = `
  t.status = 'posted'
  and t.bank_account_id is not null
  and (t.kind <> 'transfer_leg' or t.payee_name is not null)
`;

export async function bankAccountBalances(): Promise<BankAccountBalance[]> {
  const accounts = await listBankAccounts();
  if (accounts.length === 0) return [];
  const result = await query<{
    bank_account_id: string;
    moved: string;
    movements: string;
    last_posted_at: Date | null;
  }>(
    `select t.bank_account_id,
            coalesce(sum(case when fe.payload->>'direction' = 'credit'
                              then t.amount else -t.amount end), 0)::text as moved,
            count(*)::text as movements,
            max(t.posted_at) as last_posted_at
       from transaction t
       join financial_event fe
         on fe.transaction_id = t.id and fe.event_type = 'transaction.posted'
      where ${POSTED_BANK_MOVEMENT_WHERE}
      group by t.bank_account_id`
  );
  const moved = new Map(result.rows.map(r => [r.bank_account_id, r]));
  return accounts.map(account => {
    const m = moved.get(account.id);
    const cents =
      Math.round(Number(account.openingBalance) * 100) +
      Math.round(Number(m?.moved ?? '0') * 100);
    return {
      ...account,
      balance: (cents / 100).toFixed(2),
      movements: Number(m?.movements ?? 0),
      lastPostedAt: m?.last_posted_at ?? null,
    };
  });
}

// What each of the Society's bank accounts held, took in and paid out over
// a period (S-1901's own report). Reuses POSTED_BANK_MOVEMENT_WHERE, so
// this and bankAccountBalances never disagree about what a "movement" is.
// The period is the inclusive `from`..`to` every other report uses:
// `>= from` and `< to + 1`.
export interface BankAccountPeriod {
  account: BankAccount;
  // The balance at the start of the period: opening_balance plus every
  // movement before it. With no `from`, that is the opening_balance itself.
  opening: string;
  in: string;
  out: string;
  closing: string;
}

export async function bankAccountPeriods(filters: {
  from?: string | null;
  to?: string | null;
}): Promise<BankAccountPeriod[]> {
  const accounts = await listBankAccounts();
  if (accounts.length === 0) return [];

  const before = filters.from
    ? await query<{ bank_account_id: string; moved: string }>(
        `select t.bank_account_id,
                coalesce(sum(case when fe.payload->>'direction' = 'credit'
                                  then t.amount else -t.amount end), 0)::text
                  as moved
           from transaction t
           join financial_event fe
             on fe.transaction_id = t.id and fe.event_type = 'transaction.posted'
          where ${POSTED_BANK_MOVEMENT_WHERE}
            and t.posted_at < $1::date
          group by t.bank_account_id`,
        [filters.from]
      )
    : null;

  const within = await query<{
    bank_account_id: string;
    moved_in: string;
    moved_out: string;
  }>(
    `select t.bank_account_id,
            coalesce(sum(case when fe.payload->>'direction' = 'credit'
                              then t.amount else 0 end), 0)::text as moved_in,
            coalesce(sum(case when fe.payload->>'direction' = 'credit'
                              then 0 else t.amount end), 0)::text as moved_out
       from transaction t
       join financial_event fe
         on fe.transaction_id = t.id and fe.event_type = 'transaction.posted'
      where ${POSTED_BANK_MOVEMENT_WHERE}
        and ($1::date is null or t.posted_at >= $1::date)
        and ($2::date is null or t.posted_at < $2::date + 1)
      group by t.bank_account_id`,
    [filters.from ?? null, filters.to ?? null]
  );

  const beforeMap = new Map(
    (before?.rows ?? []).map(r => [r.bank_account_id, r.moved])
  );
  const withinMap = new Map(within.rows.map(r => [r.bank_account_id, r]));

  return accounts.map(account => {
    const openingCents =
      Math.round(Number(account.openingBalance) * 100) +
      Math.round(Number(beforeMap.get(account.id) ?? '0') * 100);
    const w = withinMap.get(account.id);
    const inCents = Math.round(Number(w?.moved_in ?? '0') * 100);
    const outCents = Math.round(Number(w?.moved_out ?? '0') * 100);
    return {
      account,
      opening: (openingCents / 100).toFixed(2),
      in: (inCents / 100).toFixed(2),
      out: (outCents / 100).toFixed(2),
      closing: ((openingCents + inCents - outCents) / 100).toFixed(2),
    };
  });
}

// One bank account's movements in a period, oldest first — the statement
// line by line, for the report's per-account view.
export interface BankAccountMovement {
  id: string;
  date: string; // 'DD Mon YYYY', same as every other report
  reference: string; // the transfer's reference if a transfer leg, else the transaction's own
  kind: string; // the transaction's raw kind code — the report says it in words
  holder: string;
  paidToFrom: string;
  method: string;
  methodReference: string;
  direction: 'credit' | 'debit';
  amount: string;
}

export async function bankAccountMovements(filters: {
  bankAccountId: string;
  from?: string | null;
  to?: string | null;
}): Promise<BankAccountMovement[]> {
  const result = await query<{
    id: string;
    date: string;
    reference: string;
    kind: string;
    holder: string;
    paid_to_from: string;
    method: string;
    method_reference: string;
    direction: 'credit' | 'debit';
    amount: string;
  }>(
    `select t.id,
            to_char(t.posted_at, 'DD Mon YYYY') as date,
            coalesce(tr.reference, t.reference) as reference,
            t.kind as kind,
            trim(coalesce(p.values->>'name', '') || ' '
                 || coalesce(p.values->>'surname', '')) as holder,
            coalesce(t.payee_name, '') as paid_to_from,
            pm.name as method,
            coalesce(t.method_reference, '') as method_reference,
            fe.payload->>'direction' as direction,
            t.amount::text as amount
       from transaction t
       join financial_event fe
         on fe.transaction_id = t.id and fe.event_type = 'transaction.posted'
       left join transfer tr on tr.id = t.transfer_id
       join payment_method pm on pm.code = t.method
       left join member m on m.id = t.member_id
       left join customer c on c.id = t.customer_id
       left join application_party p
         on p.application_id = coalesce(m.application_id, c.application_id)
        and p.subject = 'applicant' and p.ordinal = 1
      where ${POSTED_BANK_MOVEMENT_WHERE}
        and t.bank_account_id = $1
        and ($2::date is null or t.posted_at >= $2::date)
        and ($3::date is null or t.posted_at < $3::date + 1)
      order by t.posted_at, t.serial_no`,
    [filters.bankAccountId, filters.from ?? null, filters.to ?? null]
  );
  return result.rows.map(r => ({
    id: r.id,
    date: r.date,
    reference: r.reference,
    kind: r.kind,
    holder: r.holder,
    paidToFrom: r.paid_to_from,
    method: r.method,
    methodReference: r.method_reference,
    direction: r.direction,
    amount: r.amount,
  }));
}
