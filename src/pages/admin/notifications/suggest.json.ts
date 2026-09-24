// Suggestions for the notification log's search box (officer request: every
// search suggests as you type). Matches a recipient — an email address or a
// mobile number — against what has been typed, with what the message was
// about as its detail, and opens straight onto that recipient's messages
// (src/pages/admin/notifications.astro's own `search` parameter). Guarded by
// the route's own declared permission (notification.view, same as the page).
import type { APIRoute } from 'astro';
import { query } from '@lib/db/pool';
import {
  suggestQuery,
  suggestionResponse,
  SUGGESTION_LIMIT,
} from '@lib/search/suggest';

// The same labels as src/pages/admin/notifications.astro's own list and
// Configuration -> Notification wording
// (src/pages/admin/configuration/notification-templates.astro) — kept in
// step by hand, the way those two already are, rather than one importing
// another and turning a page's word choice into a shared dependency.
const EVENT_LABELS: Record<string, string> = {
  'application.submitted': 'Application received',
  'application.returned': 'Application returned for correction',
  'application.approved': 'Membership approved',
  'application.rejected': 'Application not approved',
  'account.submitted': 'Account application received',
  'account.returned': 'Account application returned for correction',
  'account.approved': 'Account opened',
  'account.rejected': 'Account application not approved',
  'receipt.issued': 'Receipt issued',
  'statement.issued': 'Statement',
  'closure.submitted': 'Account closure received',
  'closure.under_review': 'Account closure under review',
  'closure.approved': 'Account closed and paid out',
  'closure.rejected': 'Account closure not approved',
  'resignation.submitted': 'Resignation received',
  'resignation.under_review': 'Resignation under review',
  'resignation.approved': 'Resignation approved and paid out',
  'resignation.rejected': 'Resignation not approved',
  'demised.submitted': 'Demised claim received',
  'demised.under_review': 'Demised claim under review',
  'demised.approved': 'Demised claim paid out',
  'demised.rejected': 'Demised claim not approved',
  'deposit.posted': 'Deposit received',
  'withdrawal.submitted': 'Withdrawal received',
  'withdrawal.under_review': 'Withdrawal under review',
  'withdrawal.disbursed': 'Withdrawal paid out',
  'withdrawal.rejected': 'Withdrawal not approved',
  'transfer.posted': 'Transfer completed',
  'balance.near_floor': 'Balance near its minimum',
  'transaction.awaiting': 'Staff: transaction awaiting a step',
  'transaction.returned': 'Staff: transaction returned to its captor',
  'receipt.voided': 'Staff: receipt voided',
};

function describeEventCode(eventCode: string): string {
  const known = EVENT_LABELS[eventCode];
  if (known) return known;
  const words = eventCode.split('.').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const GET: APIRoute = async ({ url }) => {
  const typed = suggestQuery(url);
  if (!typed) return suggestionResponse([]);

  // One row per recipient — the most recent message to them — so a
  // recipient who has been sent several different things is one suggestion,
  // not one per message.
  const result = await query<{ recipient: string; event_code: string }>(
    `select distinct on (n.recipient) n.recipient, n.event_code
       from notification n
      where strpos(lower(n.recipient), lower($1::text)) > 0
      order by n.recipient, n.created_at desc
      limit $2::int`,
    [typed, SUGGESTION_LIMIT]
  );

  return suggestionResponse(
    result.rows.map(r => ({
      label: r.recipient,
      detail: describeEventCode(r.event_code),
      href: `/admin/notifications?search=${encodeURIComponent(r.recipient)}`,
    }))
  );
};
