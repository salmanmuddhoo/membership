// The delivery log (S-904).
//
// The story's whole point is that a silent failure must not be mistaken for a
// member ignoring us. So the questions this answers are the ones an officer
// actually has — did they get it, and if not why not — rather than a dump of
// the outbox.
//
// A failure stays visible until it succeeds or is abandoned, which is why
// 'abandoned' is a status and not a deletion: giving up on a message is
// itself something staff need to be able to see.
import { query } from '../db/pool';
import type { NotificationChannel } from './templates';

export const NOTIFICATION_PAGE_LIMIT = 50;

export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'abandoned';

export interface NotificationLogRow {
  id: string;
  eventCode: string;
  channel: NotificationChannel;
  recipient: string;
  subject: string | null;
  body: string;
  status: NotificationStatus;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
  nextAttemptAt: Date | null;
  // The application this was about, so a row can be opened rather than only
  // read. Null for anything not about an application.
  entityType: string | null;
  entityId: string | null;
  reference: string | null;
}

export interface NotificationFilters {
  status?: NotificationStatus;
  channel?: NotificationChannel;
  // Matched against the address and against the application reference, which
  // are the two things someone chasing a member actually has to hand.
  search?: string;
  // Rows to a page (officer request: 10, 25 or 50, the officer's choice —
  // src/lib/paging.ts). Defaults to NOTIFICATION_PAGE_LIMIT.
  limit?: number;
  offset?: number;
}

export async function listNotifications(
  filters: NotificationFilters = {}
): Promise<{ rows: NotificationLogRow[]; total: number }> {
  const search = filters.search?.trim() || null;
  const limit = Math.min(
    Math.max(filters.limit ?? NOTIFICATION_PAGE_LIMIT, 1),
    500
  );

  // Counted over the same predicate as the page, so "23 messages" and the
  // rows below it can never disagree.
  const where = `
    where ($1::text is null or n.status = $1::text)
      and ($2::text is null or n.channel = $2::text)
      and ($3::text is null
           or strpos(lower(n.recipient), lower($3::text)) > 0
           or strpos(lower(coalesce(a.reference, '')), lower($3::text)) > 0)`;

  // a.id::text, not n.entity_id::uuid: entity_id is text (0053, for the same
  // reason audit_event's is) and casting it the other way would throw on any
  // row whose entity_id is not a uuid — the planner is free to evaluate that
  // cast before the entity_type test that would have excluded it.
  const from = `
    from notification n
    left join membership_application a
      on n.entity_type = 'membership_application'
     and a.id::text = n.entity_id`;

  const [page, count] = await Promise.all([
    query<{
      id: string;
      event_code: string;
      channel: NotificationChannel;
      recipient: string;
      subject: string | null;
      body: string;
      status: NotificationStatus;
      attempts: number;
      last_error: string | null;
      created_at: Date;
      sent_at: Date | null;
      next_attempt_at: Date | null;
      entity_type: string | null;
      entity_id: string | null;
      reference: string | null;
    }>(
      `select n.id, n.event_code, n.channel, n.recipient, n.subject, n.body,
              n.status, n.attempts, n.last_error, n.created_at, n.sent_at,
              n.next_attempt_at, n.entity_type, n.entity_id, a.reference
       ${from}
       ${where}
       order by n.created_at desc
       limit $4::int offset $5::int`,
      [
        filters.status ?? null,
        filters.channel ?? null,
        search,
        limit,
        filters.offset ?? 0,
      ]
    ),
    query<{ n: string }>(`select count(*)::int as n ${from} ${where}`, [
      filters.status ?? null,
      filters.channel ?? null,
      search,
    ]),
  ]);

  return {
    rows: page.rows.map(r => ({
      id: r.id,
      eventCode: r.event_code,
      channel: r.channel,
      recipient: r.recipient,
      subject: r.subject,
      body: r.body,
      status: r.status,
      attempts: r.attempts,
      lastError: r.last_error,
      createdAt: r.created_at,
      sentAt: r.sent_at,
      nextAttemptAt: r.next_attempt_at,
      entityType: r.entity_type,
      entityId: r.entity_id,
      reference: r.reference,
    })),
    total: Number(count.rows[0].n),
  };
}

export interface NotificationCounts {
  waiting: number;
  failed: number;
  abandoned: number;
}

/**
 * What is not working, in three numbers.
 *
 * 'sent' is deliberately not among them. A count of successes is reassuring
 * and tells nobody what to do; these three are each something a person can
 * act on — one is still coming, one is being retried, one has been given up
 * on and needs a human.
 */
export async function notificationCounts(): Promise<NotificationCounts> {
  const result = await query<{
    waiting: string;
    failed: string;
    abandoned: string;
  }>(
    `select count(*) filter (where status = 'pending')::int   as waiting,
            count(*) filter (where status = 'failed')::int    as failed,
            count(*) filter (where status = 'abandoned')::int as abandoned
       from notification`
  );

  const row = result.rows[0];
  return {
    waiting: Number(row.waiting),
    failed: Number(row.failed),
    abandoned: Number(row.abandoned),
  };
}
