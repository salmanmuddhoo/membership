// Who each account goes to on a death, and the payout split by nominee
// (officer request, 26 November 2026).
//
// An account's nominee is the one named when it was opened: the nominee on
// the additional-account application that opened it, where a different one
// was named there (applications/account-nominee.ts), otherwise the nominee
// on the holder's founding application — the one their Shares and MSA go
// to. When a claim pays "the nominee" (claimants.ts), it pays each nominee
// what their accounts hold, one cheque each; the Takaful benefit, which is
// the membership's, goes with the founding nominee. A claim paid to someone
// else in full is not split.
import { query } from '../db/pool';
import { fromCents, toCents } from '../payments/money';
import { nomineeOnApplication } from './claimants';
import type { Claimant } from './review';

export interface PayoutAccount {
  id: string;
  accountNo: string;
  typeName: string;
  balance: string;
}

export interface NomineePayout {
  claimant: Claimant;
  accounts: PayoutAccount[];
  // Includes the Takaful benefit, on the founding nominee's payout.
  amount: string;
  takafulBenefit: string;
}

function keyOf(claimant: Claimant): string {
  return `${claimant.nic.trim().toUpperCase()}|${claimant.name.trim().toLowerCase()}`;
}

/**
 * The payouts a claim to the nominee makes for this holder: one per
 * distinct nominee, the founding nominee first. Every account not yet
 * closed counts, at what it holds now; an account whose own nominee is not
 * on file goes to the founding nominee. Empty when the founding nominee is
 * not on file (a claim to the nominee is refused then anyway).
 */
export async function nomineePayouts(
  holder: { memberId: string | null; customerId: string | null },
  takafulBenefit: string = '0'
): Promise<NomineePayout[]> {
  const founding = await query<{ application_id: string | null }>(
    holder.memberId
      ? `select application_id from member where id = $1`
      : `select application_id from customer where id = $1`,
    [holder.memberId ?? holder.customerId]
  );
  const foundingNominee = await nomineeOnApplication(
    founding.rows[0]?.application_id ?? null
  );
  if (!foundingNominee) return [];

  const accounts = await query<{
    id: string;
    account_no: string | null;
    type_name: string;
    balance: string;
    opened_by_application_id: string | null;
    opened_by_kind: string | null;
  }>(
    `select a.id, coalesce(a.account_no, m.member_no, '') as account_no,
            ty.name as type_name, coalesce(b.balance, 0)::text as balance,
            a.opened_by_application_id,
            app.application_kind as opened_by_kind
       from account a
       join account_type ty on ty.id = a.account_type_id
       left join member m on m.id = a.member_id
       left join account_balance b on b.account_id = a.id
       left join membership_application app on app.id = a.opened_by_application_id
      where ((a.member_id = $1::uuid) or (a.customer_id = $2::uuid))
        and a.status <> 'closed'
      order by ty.sort_order, a.opened_at`,
    [holder.memberId, holder.customerId]
  );

  const payouts = new Map<string, NomineePayout & { cents: number }>();
  const add = (claimant: Claimant) => {
    const key = keyOf(claimant);
    if (!payouts.has(key)) {
      payouts.set(key, {
        claimant,
        accounts: [],
        amount: '0.00',
        takafulBenefit: '0.00',
        cents: 0,
      });
    }
    return payouts.get(key)!;
  };
  const first = add(foundingNominee);
  first.cents += toCents(takafulBenefit);
  first.takafulBenefit = fromCents(toCents(takafulBenefit));

  for (const a of accounts.rows) {
    const own =
      a.opened_by_kind === 'additional_account'
        ? await nomineeOnApplication(a.opened_by_application_id)
        : null;
    const payout = add(own ?? foundingNominee);
    payout.accounts.push({
      id: a.id,
      accountNo: a.account_no ?? '',
      typeName: a.type_name,
      balance: fromCents(toCents(a.balance)),
    });
    payout.cents += toCents(a.balance);
  }

  return [...payouts.values()]
    .filter(p => p === first || p.accounts.length > 0)
    .map(({ cents, ...p }) => ({ ...p, amount: fromCents(cents) }));
}
