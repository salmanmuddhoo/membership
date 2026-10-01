// Suggestions for the applications search box (officer request: every
// search suggests as you type, with no need to click Search). Matches the
// same text listApplications' own search does — the applicant's name or the
// reference — under the same visibility rules the list itself applies, and
// links each suggestion exactly where the list's own row would.
//
// Guarded by the middleware's own '/applications/' rule (application.view).
import type { APIRoute } from 'astro';
import { suggestQuery, suggestionResponse } from '@lib/search/suggest';
import { listApplications } from '@lib/applications/capture';
import { APPLICATION_STATUS_LABELS as STATUS_LABELS } from '@lib/applications/status-labels';

export const GET: APIRoute = async ({ url, locals }) => {
  const search = suggestQuery(url);
  if (!search) return suggestionResponse([]);

  const principal = locals.principal!;
  const matches = await listApplications({
    search,
    viewerUserId: principal.userId,
    canHandleReceived: principal.permissions.has('application.submit_online'),
    limit: 8,
  });

  return suggestionResponse(
    matches.map(a => ({
      label: a.applicantName,
      detail: `${a.reference} · ${STATUS_LABELS[a.status] ?? a.status}`,
      href:
        a.applicationKind === 'membership'
          ? `/applications/${a.id}`
          : a.applicationKind === 'additional_account'
            ? `/applications/${a.id}/account`
            : `/applications/${a.id}/customer`,
    }))
  );
};
