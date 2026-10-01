// Suggestions for the document directory's search box (officer request:
// every search suggests as you type, with no need to click Search). Matches
// the same text the directory's own search does — a member or customer's
// number or name (listMembers, members/create.ts) — and links to their own
// folder, the same as the directory's own row does.
//
// Guarded by the middleware's own '/documents/' rule (document.view).
import type { APIRoute } from 'astro';
import { suggestQuery, suggestionResponse } from '@lib/search/suggest';
import { listMembers } from '@lib/members/create';

export const GET: APIRoute = async ({ url }) => {
  const search = suggestQuery(url);
  if (!search) return suggestionResponse([]);

  const { members } = await listMembers({ search, limit: 8 });

  return suggestionResponse(
    members.map(m => ({
      label: m.name,
      detail:
        (m.memberNo ? `${m.memberNo} · ` : '') +
        (m.kind === 'customer' ? 'Non-member' : m.membershipTypeName),
      href: `/documents/${m.id}`,
    }))
  );
};
