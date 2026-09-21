// Finding the account a transaction is for, from what an officer has in
// front of them (officer feedback on the Transactions page): the account
// type and a number. For Shares and the MSA the number is the member's own
// (AB0001, migration 0018); for every other type it is the account's own
// (HSA0001, INV0001 — next_customer_account_number, 0027).
import { query } from '../db/pool';

export interface FoundAccount {
  accountId: string;
  accountNo: string;
  accountTypeName: string;
  status: string;
  // The person's own page, and the deposit form under it: a member or a
  // customer (0027), whichever holds the account.
  holderId: string;
  holderKind: 'member' | 'customer';
  holderName: string;
}

// Case and whitespace are the officer's, not the number's.
export function normaliseNumber(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

export async function findAccountByNumber(
  accountTypeId: string,
  number: string
): Promise<FoundAccount | null> {
  const wanted = normaliseNumber(number);
  if (!wanted) return null;
  const result = await query<{
    account_id: string;
    account_no: string;
    type_name: string;
    status: string;
    holder_id: string;
    holder_kind: 'member' | 'customer';
    holder_name: string;
  }>(
    `select a.id as account_id,
            coalesce(a.account_no, m.member_no) as account_no,
            t.name as type_name, a.status,
            coalesce(a.member_id, a.customer_id) as holder_id,
            case when a.member_id is not null then 'member' else 'customer' end
              as holder_kind,
            trim(coalesce(p.values->>'name', '') || ' '
                 || coalesce(p.values->>'surname', '')) as holder_name
       from account a
       join account_type t on t.id = a.account_type_id
       left join member m on m.id = a.member_id
       left join customer c on c.id = a.customer_id
       left join application_party p
         on p.application_id = coalesce(m.application_id, c.application_id)
        and p.subject = 'applicant' and p.ordinal = 1
      where a.account_type_id = $1
        and upper(coalesce(a.account_no, m.member_no)) = $2
      limit 1`,
    [accountTypeId, wanted]
  );
  const r = result.rows[0];
  if (!r) return null;
  return {
    accountId: r.account_id,
    accountNo: r.account_no,
    accountTypeName: r.type_name,
    status: r.status,
    holderId: r.holder_id,
    holderKind: r.holder_kind,
    holderName: r.holder_name,
  };
}
