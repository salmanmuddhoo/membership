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

export interface BankAccountBalance extends BankAccount {
  balance: string;
  // Posted transactions naming it, and the latest.
  movements: number;
  lastPostedAt: Date | null;
}

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
      where t.status = 'posted'
        and t.bank_account_id is not null
        and (t.kind <> 'transfer_leg' or t.payee_name is not null)
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
