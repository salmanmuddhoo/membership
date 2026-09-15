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
import { configuredChannels } from './channels';
import {
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

// Which provider carries a channel is read from configuration per send
// (channels.ts). An override registered here wins over it, which is how a
// test substitutes a channel it can inspect — and how anything that wants to
// send through something the environment cannot describe does so.
const overrides = new Map<NotificationChannel, Channel>();

export function registerChannel(channel: Channel): void {
  overrides.set(channel.name, channel);
}

// Tests only: forget every override, so one file's substitute channel is not
// still in place in the next.
export function resetChannels(): void {
  overrides.clear();
}

function recipientFor(
  channel: NotificationChannel,
  recipients: Recipients
): string | null {
  const value = channel === 'email' ? recipients.email : recipients.mobile;
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

async function record(
  template: NotificationTemplate,
  message: OutgoingMessage,
  request: NotifyRequest
): Promise<string> {
  const result = await query<{ id: string }>(
    `insert into notification
       (event_code, channel, template_id, recipient, subject, body,
        entity_type, entity_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
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

async function markFailed(id: string, error: unknown): Promise<void> {
  await query(
    `update notification
        set status = 'failed', attempts = attempts + 1, last_error = $2
      where id = $1`,
    [id, error instanceof Error ? error.message : 'Unknown error.']
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
  const configured = configuredChannels();

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
      };

      const id = await record(template, message, request);
      written.push(id);

      try {
        await (overrides.get(channel) ?? configured.get(channel)!).send(
          message
        );
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
