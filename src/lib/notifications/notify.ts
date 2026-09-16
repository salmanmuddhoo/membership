// Sending a notification (S-901, decision 11).
//
// One interface, any number of providers. Nothing above this file knows
// whether an email leaves through a relay, an API or a log line, and nothing
// below it knows why the member is being written to. Changing provider is
// registering a different Channel — configuration and a deployment, not a
// rewrite.
//
// Two rules the rest of the system depends on:
//
//   A notification never breaks the thing that caused it. An approval that
//   succeeded must not be reported as failed because a mail relay was down,
//   so every failure here is recorded and swallowed, the same bargain
//   recordAuditQuietly makes with the audit trail.
//
//   The row is written before the send is attempted. A process that dies
//   mid-send leaves a 'pending' row rather than no evidence at all, which is
//   what lets S-904 retry it later rather than guess.
import { query } from '../db/pool';
import { activeChannels } from './channels';
import { backoffMinutes } from './retry';
import {
  placeholderSequence,
  render,
  templateFor,
  type NotificationChannel,
  type NotificationTemplate,
} from './templates';

export interface OutgoingMessage {
  channel: NotificationChannel;
  recipient: string;
  subject: string | null;
  body: string;
  // For a provider that sends approved templates rather than finished text
  // (WhatsApp, S-903): what the wording is called at the provider, and the
  // values for its positional slots. `body` is still the rendered text, which
  // is what the member reads and what the delivery log shows.
  providerTemplateName?: string | null;
  providerTemplateLanguage?: string;
  parameters?: string[] | null;
}

export interface Channel {
  readonly name: NotificationChannel;
  send(message: OutgoingMessage): Promise<void>;
}

// Where a notification for this event should go. Absent means the member has
// no address of that kind on file, and that channel is skipped.
export interface Recipients {
  email?: string | null;
  mobile?: string | null;
}

export interface NotifyRequest {
  eventCode: string;
  recipients: Recipients;
  values: Record<string, string | null | undefined>;
  // What this is about, so a member's record can show what they were told.
  entityType?: string;
  entityId?: string;
}

// Which provider carries a channel is channels.ts's question, for the first
// attempt and the retry job alike. Re-exported because this module is the
// surface the rest of the system already sends through.
export { registerChannel, resetChannels } from './channels';

function recipientFor(
  channel: NotificationChannel,
  recipients: Recipients
): string | null {
  const value = channel === 'email' ? recipients.email : recipients.mobile;
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The values a provider template's positional slots take.
 *
 * Only for a channel that names a provider template; everything else sends
 * finished text and has no use for them. An empty value is sent as an empty
 * string rather than skipped — dropping it would shift every later parameter
 * up one and put the member number where the name belongs.
 */
function parametersFor(
  template: NotificationTemplate,
  values: Record<string, string | null | undefined>
): string[] | null {
  if (!template.providerTemplateName) return null;
  return placeholderSequence(template.body).map(name => {
    const value = values[name];
    return value == null ? '' : String(value);
  });
}

async function record(
  template: NotificationTemplate,
  message: OutgoingMessage,
  request: NotifyRequest
): Promise<string> {
  const result = await query<{ id: string }>(
    `insert into notification
       (event_code, channel, template_id, recipient, subject, body,
        entity_type, entity_id, provider_parameters)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id`,
    [
      request.eventCode,
      template.channel,
      template.id,
      message.recipient,
      message.subject,
      message.body,
      request.entityType ?? null,
      request.entityId ?? null,
      // Stored rather than recomputed at retry time, for the same reason the
      // rendered body is: a second attempt sends what the first would have,
      // even if the wording has been edited since.
      message.parameters ? JSON.stringify(message.parameters) : null,
    ]
  );
  return result.rows[0].id;
}

async function markSent(id: string): Promise<void> {
  await query(
    `update notification
        set status = 'sent', attempts = attempts + 1,
            last_error = null, sent_at = now()
      where id = $1`,
    [id]
  );
}

// The first attempt's failure also schedules the second (S-904). Without a
// due time the row would still be found eventually — the retry job picks up
// anything unscheduled once it is old enough — but it would wait out that
// grace period instead of the backoff, which is longer than a transient relay
// failure deserves.
async function markFailed(id: string, error: unknown): Promise<void> {
  await query(
    `update notification
        set status = 'failed', attempts = attempts + 1, last_error = $2,
            next_attempt_at = $3
      where id = $1`,
    [
      id,
      error instanceof Error ? error.message : 'Unknown error.',
      new Date(Date.now() + backoffMinutes(1) * 60_000),
    ]
  );
}

/**
 * Send whatever this event has active templates for, on every channel the
 * recipient has an address for.
 *
 * Returns the notification ids written, which is what a caller that wants to
 * show "we told them" can hold on to. Never throws: a caller's own work has
 * already happened by the time this runs.
 */
export async function notify(request: NotifyRequest): Promise<string[]> {
  const written: string[] = [];
  const channels = activeChannels();

  for (const channel of ['email', 'whatsapp'] as const) {
    try {
      const template = await templateFor(request.eventCode, channel);
      if (!template) continue;

      const recipient = recipientFor(channel, request.recipients);
      if (!recipient) continue;

      const message: OutgoingMessage = {
        channel,
        recipient,
        subject: template.subject
          ? render(template.subject, request.values)
          : null,
        body: render(template.body, request.values),
        providerTemplateName: template.providerTemplateName,
        providerTemplateLanguage: template.providerTemplateLanguage,
        // The body's own placeholder order is the parameter order: the Nth
        // slot an administrator writes is the provider template's {{N}}.
        parameters: parametersFor(template, request.values),
      };

      const id = await record(template, message, request);
      written.push(id);

      try {
        await channels.get(channel)!.send(message);
        await markSent(id);
      } catch (error) {
        console.error(`[notify] ${channel} send failed:`, error);
        await markFailed(id, error);
      }
    } catch (error) {
      // Could not even record the intent — nothing to retry later, so the
      // log is the only trace. Still never rethrown.
      console.error(`[notify] ${request.eventCode} on ${channel}:`, error);
    }
  }

  return written;
}

export interface NotificationRecord {
  id: string;
  eventCode: string;
  channel: NotificationChannel;
  recipient: string;
  subject: string | null;
  status: 'pending' | 'sent' | 'failed' | 'abandoned';
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

// What was sent about one thing — an application, a member — most recent
// first.
export async function notificationsFor(
  entityType: string,
  entityId: string
): Promise<NotificationRecord[]> {
  const result = await query<{
    id: string;
    event_code: string;
    channel: NotificationChannel;
    recipient: string;
    subject: string | null;
    status: NotificationRecord['status'];
    attempts: number;
    last_error: string | null;
    created_at: Date;
    sent_at: Date | null;
  }>(
    `select id, event_code, channel, recipient, subject, status, attempts,
            last_error, created_at, sent_at
       from notification
      where entity_type = $1 and entity_id = $2
      order by created_at desc`,
    [entityType, entityId]
  );

  return result.rows.map(r => ({
    id: r.id,
    eventCode: r.event_code,
    channel: r.channel,
    recipient: r.recipient,
    subject: r.subject,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  }));
}
