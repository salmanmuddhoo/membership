// Suggestions for the Members search box (officer request: every search
// suggests as you type, without pressing Search). Matches the same two
// fields listMembers itself searches — the member's or customer's number
// (or held account numbers) and their name — kept cheap: no accounts, no
// balances, just enough to name the match and send you to it. Guarded by
// the middleware's member.view requirement on everything under /members/.
import type { APIRoute } from 'astro';
import { query } from '@lib/db/pool';
import { suggestQuery, suggestionResponse } from '@lib/search/suggest';
import { statusLabel } from '@lib/members/labels';
import { shownStatus } from '@lib/members/status';

export const GET: APIRoute = async ({ url }) => {
  const typed = suggestQuery(url);
  if (!typed) return suggestionResponse([]);

  const result = await query<{
    id: string;
    kind: 'member' | 'customer';
    identifier: string;
    status: string;
    name: string;
    non_member: boolean;
  }>(
    `with rows as (
       select m.id, 'member'::text as kind, m.member_no as identifier,
              m.status,
              trim(coalesce(p.values->>'name', '') || ' ' ||
                   coalesce(p.values->>'surname', '')) as name,
              exists (
                select 1 from account acc
                 where acc.member_id = m.id and acc.status <> 'closed'
              ) as has_open
         from member m
         left join membership_application a on a.id = m.application_id
         left join application_party p
           on p.application_id = m.application_id
          and p.subject = 'applicant' and p.ordinal = 1
       union all
       select c.id, 'customer'::text as kind,
              coalesce(
                (select string_agg(acc.account_no, ', '
                          order by act.sort_order, acc.account_no)
                   from account acc
                   join account_type act on act.id = acc.account_type_id
                  where acc.customer_id = c.id),
                ''
              ) as identifier,
              c.status,
              trim(coalesce(p.values->>'name', '') || ' ' ||
                   coalesce(p.values->>'surname', '')) as name,
              exists (
                select 1 from account acc
                 where acc.customer_id = c.id and acc.status <> 'closed'
              ) as has_open
         from customer c
         join membership_application capp on capp.id = c.application_id
         left join application_party p
           on p.application_id = c.application_id
          and p.subject = 'applicant' and p.ordinal = 1
        where c.status in ('active', 'closed')
     )
     select id, kind, identifier, status, name,
            ((kind = 'customer' or status = 'resigned') and has_open)
              as non_member
       from rows
      where strpos(lower(identifier), lower($1)) > 0
         or strpos(lower(name), lower($1)) > 0
      order by identifier
      limit 8`,
    [typed]
  );

  return suggestionResponse(
    result.rows.map(r => ({
      label: r.name || '(unnamed)',
      // A member's own number; a customer has none, so 'Non-member' stands
      // in for it, the same as the list's own badge does.
      detail: `${r.kind === 'member' ? r.identifier : 'Non-member'} · ${statusLabel(
        shownStatus(r.status, r.non_member)
      )}`,
      href: `/members/${r.id}`,
    }))
  );
};
