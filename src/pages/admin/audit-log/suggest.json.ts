// Suggestions for the audit log's Actor / Person box (officer request:
// every search suggests as you type). Matches a staff account's name or
// email, the same two things the log's own actor filter matches, and opens
// the log filtered to them on the tab the box was on. Guarded by
// audit.view, same as the log (src/lib/access/authorise.ts).
import type { APIRoute } from 'astro';
import { query } from '@lib/db/pool';
import {
  suggestQuery,
  suggestionResponse,
  SUGGESTION_LIMIT,
} from '@lib/search/suggest';

export const GET: APIRoute = async ({ url }) => {
  const typed = suggestQuery(url);
  if (!typed) return suggestionResponse([]);
  const signIns = url.searchParams.get('view') === 'signins';

  const result = await query<{ display_name: string; email: string }>(
    `select u.display_name, u.email::text as email
       from app_user u
      where strpos(lower(u.display_name), lower($1::text)) > 0
         or strpos(lower(u.email::text), lower($1::text)) > 0
      order by u.display_name
      limit $2::int`,
    [typed, SUGGESTION_LIMIT]
  );

  return suggestionResponse(
    result.rows.map(r => {
      const next = new URLSearchParams({ actor: r.email });
      if (signIns) next.set('view', 'signins');
      return {
        label: r.display_name,
        detail: r.email,
        href: `/admin/audit-log?${next}`,
      };
    })
  );
};
