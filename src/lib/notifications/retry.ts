// Trying again, and knowing when to stop (S-904).
//
// notify() writes the outbox row before it attempts the send, so a failure —
// or a process that died mid-send — always leaves something to come back to.
// This is what comes back to it.
//
// What is re-sent is the text STORED ON THE ROW, never a re-render of the
// template. Editing a template must not change what a member was already
// told, and a retry is another attempt at the same message, not a new one.
//
// Nothing here is on a request path. A relay that is down comes back minutes
// or hours later, and an officer's click is not the place to wait for it — so
// this is a job (scripts/run-job.ts, `notification-retry`), whose runner
// already guarantees one instance at a time.
import { query } from '../db/pool';
import { activeChannels } from './channels';
import type { Attachment } from './notify';
import type { NotificationChannel } from './templates';

/**
 * How long to wait after the attempt that just failed.
 *
 * Exponential, and deliberately coarse. A mail relay that refuses one message
 * is usually either busy for a moment or misconfigured for a day, and the
 * difference shows up within the first two steps; retrying a permanently bad
 * address every five minutes only buries the failures worth acting on.
 */
export function backoffMinutes(attempts: number): number {
  const schedule = [5, 15, 60, 6 * 60, 24 * 60];
  const step = Math.max(1, attempts) - 1;
  return schedule[Math.min(step, schedule.length - 1)];
}

/**
 * How many times a notification is attempted before it is given up on.
 *
 * Six attempts means five waits — 5m, 15m, 1h, 6h, 24h — which is a little
 * over thirty hours in total: an overnight outage with a working day either
 * side of it, so a relay that comes back the next morning still delivers.
 * Past that, an address that has never once accepted a message is not going
 * to start.
 */
export const MAX_ATTEMPTS = 6;

/**
 * How long a 'pending' row is left alone before it is treated as abandoned
 * mid-send.
 *
 * A row is written before the send is attempted, so one that is still
 * 'pending' is either in flight right now or was orphaned by a process that
 * died. Waiting a few minutes is what tells those apart without a lock: a
 * live send has long since finished, and a re-send of one that has not is the
 * cost of never losing a message.
 */
const PENDING_GRACE_MINUTES = 10;

export interface DueNotification {
  id: string;
  channel: NotificationChannel;
  recipient: string;
  subject: string | null;
  body: string;
  attempts: number;
  // The provider template this was sent as, and its positional values
  // (migration 0057). Read back from the row rather than resolved from the
  // template again: a retry sends what the first attempt would have sent.
  providerTemplateName: string | null;
  providerTemplateLanguage: string | null;
  providerParameters: string[] | null;
  // What the first attempt attached, if anything (migration 0089).
  attachment: Attachment | null;
}

/**
 * What is due to be attempted now, oldest first.
 *
 * Oldest first because a member waiting longest should hear first, and
 * because it makes a run that hits its limit resume in a predictable place
 * rather than starving the back of the queue.
 */
export async function dueNotifications(
  limit: number
): Promise<DueNotification[]> {
  const result = await query<{
    id: string;
    channel: NotificationChannel;
    recipient: string;
    subject: string | null;
    body: string;
    attempts: number;
    provider_template_name: string | null;
    provider_template_language: string | null;
    provider_parameters: string[] | null;
    attachment_url: string | null;
    attachment_name: string | null;
    attachment_type: string | null;
  }>(
    // The template is joined for its provider name and language only — a
    // template deleted since leaves those null, and the send then refuses
    // with a reason rather than guessing one.
    `select n.id, n.channel, n.recipient, n.subject, n.body, n.attempts,
            n.provider_parameters,
            n.attachment_url, n.attachment_name, n.attachment_type,
            t.provider_template_name, t.provider_template_language
       from notification n
       left join notification_template t on t.id = n.template_id
      where n.status in ('pending', 'failed')
        and n.attempts < $1
        and (
          n.next_attempt_at <= now()
          -- Never scheduled: a send that nothing lived long enough to mark
          -- either way. Picked up on age instead.
          or (n.next_attempt_at is null
              and n.created_at < now() - ($2 || ' minutes')::interval)
        )
      order by n.created_at
      limit $3`,
    [MAX_ATTEMPTS, PENDING_GRACE_MINUTES, limit]
  );

  return result.rows.map(r => ({
    id: r.id,
    channel: r.channel,
    recipient: r.recipient,
    subject: r.subject,
    body: r.body,
    attempts: r.attempts,
    providerTemplateName: r.provider_template_name,
    providerTemplateLanguage: r.provider_template_language,
    providerParameters: r.provider_parameters,
    attachment:
      r.attachment_url && r.attachment_name
        ? {
            url: r.attachment_url,
            filename: r.attachment_name,
            contentType: r.attachment_type ?? 'application/octet-stream',
          }
        : null,
  }));
}

async function markSent(id: string): Promise<void> {
  await query(
    `update notification
        set status = 'sent', attempts = attempts + 1, last_error = null,
            next_attempt_at = null, sent_at = now()
      where id = $1`,
    [id]
  );
}

/**
 * Record a failed attempt, and decide whether there will be another.
 *
 * The attempt count is incremented in SQL rather than from the value read
 * earlier, so a row that was also touched elsewhere cannot have an attempt
 * overwritten — and the ceiling is evaluated against the incremented value,
 * so the row that reaches it settles in the same statement rather than
 * needing another pass to notice.
 */
async function markFailed(
  id: string,
  attempts: number,
  error: unknown
): Promise<void> {
  const settled = attempts + 1 >= MAX_ATTEMPTS;
  await query(
    `update notification
        set status = $2,
            attempts = attempts + 1,
            last_error = $3,
            next_attempt_at = $4
      where id = $1`,
    [
      id,
      settled ? 'abandoned' : 'failed',
      error instanceof Error ? error.message : 'Unknown error.',
      settled
        ? null
        : new Date(Date.now() + backoffMinutes(attempts + 1) * 60_000),
    ]
  );
}

export interface RetryOutcome {
  attempted: number;
  sent: number;
  failed: number;
  abandoned: number;
}

/**
 * Attempt everything that is due.
 *
 * One failure never stops the run: the next notification in the queue may be
 * on a channel that is working perfectly, and a single bad address must not
 * hold up every other member's message.
 */
export async function retryDueNotifications(
  limit = 100
): Promise<RetryOutcome> {
  const due = await dueNotifications(limit);
  const channels = activeChannels();
  const outcome: RetryOutcome = {
    attempted: due.length,
    sent: 0,
    failed: 0,
    abandoned: 0,
  };

  for (const notification of due) {
    try {
      await channels.get(notification.channel)!.send({
        channel: notification.channel,
        recipient: notification.recipient,
        subject: notification.subject,
        body: notification.body,
        providerTemplateName: notification.providerTemplateName,
        providerTemplateLanguage:
          notification.providerTemplateLanguage ?? undefined,
        parameters: notification.providerParameters,
        attachment: notification.attachment,
      });
      await markSent(notification.id);
      outcome.sent += 1;
    } catch (error) {
      await markFailed(notification.id, notification.attempts, error);
      if (notification.attempts + 1 >= MAX_ATTEMPTS) outcome.abandoned += 1;
      else outcome.failed += 1;
    }
  }

  return outcome;
}
