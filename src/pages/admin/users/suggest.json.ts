// Suggestions for the staff accounts search box (officer request: every
// search suggests as you type). Matches a colleague's name or email against
// what has been typed, with their roles as the detail. There is no per-user
// page yet, so a pick lands on the staff list filtered to them
// (src/pages/admin/users.astro's own `q` parameter). Guarded by the route's
// own declared permission (user.view, same as the page).
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

  const result = await query<{
    display_name: string;
    email: string;
    roles: string[];
  }>(
    // The same role codes the staff list itself shows under each name
    // (src/pages/admin/users.astro), not the longer role name — so a
    // suggestion's detail reads the same as what is already on screen.
    `select u.display_name, u.email::text as email,
            coalesce(
              array_agg(distinct r.code order by r.code)
                filter (where r.code is not null), '{}'
            ) as roles
       from app_user u
       left join user_role ur on ur.user_id = u.id
       left join role r on r.id = ur.role_id
      where strpos(lower(u.display_name), lower($1::text)) > 0
         or strpos(lower(u.email::text), lower($1::text)) > 0
      group by u.id
      order by u.display_name
      limit $2::int`,
    [typed, SUGGESTION_LIMIT]
  );

  return suggestionResponse(
    result.rows.map(r => ({
      label: r.display_name,
      detail: r.roles.length > 0 ? r.roles.join(', ') : 'no roles',
      href: `/admin/users?q=${encodeURIComponent(r.email)}`,
    }))
  );
};
