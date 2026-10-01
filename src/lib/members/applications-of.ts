// Every application that is one person's (lifecycle test, LC-02).
//
// A person's history is spread over several applications: the one they
// joined or opened their first account on, any further account, a rejoin,
// the membership a non-member applied for. The member (or customer) row
// points at only one of them — the latest, after a rejoin — so reading
// payments or documents from that one alone lost the rest: a converted
// member's first receipt, a rejoined member's original membership receipt,
// every reopen. They all share one folder (folder_application_id names the
// first), which is what ties them together here, alongside the links each
// kind carries (rejoins_member_id, existing_member_id, existing_customer_id).
import { query } from '../db/pool';

export type Holder = { memberId: string } | { customerId: string };

export interface PersonApplication {
  id: string;
  reference: string;
  status: string;
  applicationKind: string;
  // The one the member or customer row points at: their founding
  // application, or the rejoin that re-admitted them.
  isCurrent: boolean;
}

// The ids, as SQL, for use inside a larger query. $1 is the holder's id.
export function personApplicationIdsSql(holder: Holder): string {
  const anchors =
    'memberId' in holder
      ? `select a.id from membership_application a
          where a.id = (select application_id from member where id = $1)
             or a.rejoins_member_id = $1 or a.existing_member_id = $1`
      : `select a.id from membership_application a
          where a.id = (select application_id from customer where id = $1)
             or a.existing_customer_id = $1`;
  return `select p.id from membership_application p
           where p.id in (${anchors})
              or coalesce(p.folder_application_id, p.id) in (
                   select coalesce(r.folder_application_id, r.id)
                     from membership_application r
                    where r.id in (${anchors}))`;
}

export async function applicationsOfPerson(
  holder: Holder
): Promise<PersonApplication[]> {
  const result = await query<{
    id: string;
    reference: string;
    status: string;
    application_kind: string;
    is_current: boolean;
  }>(
    `select a.id, a.reference, a.status, a.application_kind,
            a.id = (select ${'memberId' in holder ? 'application_id from member' : 'application_id from customer'}
                     where id = $1) as is_current
       from membership_application a
      where a.id in (${personApplicationIdsSql(holder)})
      order by a.created_at`,
    ['memberId' in holder ? holder.memberId : holder.customerId]
  );
  return result.rows.map(r => ({
    id: r.id,
    reference: r.reference,
    status: r.status,
    applicationKind: r.application_kind,
    isCurrent: r.is_current ?? false,
  }));
}
