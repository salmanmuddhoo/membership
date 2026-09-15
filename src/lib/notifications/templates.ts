// Notification templates (S-901).
//
// A template is configuration: an administrator writes the wording, and the
// code only decides which event fired and what values it has. That split is
// what lets the Society change what a member is told without a release.
//
// Bodies are plain text, never HTML. A template is administrator-supplied
// text that ends up in someone's inbox, so treating it as markup would make
// the template editor an injection surface for anyone who can reach it.
// Plain text has no such edge, and none of the events here need markup.
import { cached } from '../config/cache';
import { query, withConfigurationActor } from '../db/pool';

export type NotificationChannel = 'email' | 'whatsapp';

export interface NotificationTemplate {
  id: string;
  eventCode: string;
  channel: NotificationChannel;
  // Null on every channel that has no subject line of its own.
  subject: string | null;
  body: string;
  isActive: boolean;
  description: string;
}

interface TemplateRow {
  id: string;
  event_code: string;
  channel: NotificationChannel;
  subject: string | null;
  body: string;
  is_active: boolean;
  description: string;
}

function toTemplate(row: TemplateRow): NotificationTemplate {
  return {
    id: row.id,
    eventCode: row.event_code,
    channel: row.channel,
    subject: row.subject,
    body: row.body,
    isActive: row.is_active,
    description: row.description,
  };
}

export async function listNotificationTemplates(): Promise<
  NotificationTemplate[]
> {
  return cached('notification_templates', async () => {
    const result = await query<TemplateRow>(
      `select id, event_code, channel, subject, body, is_active, description
         from notification_template
        order by event_code, channel`
    );
    return result.rows.map(toTemplate);
  });
}

// The template to use for one event on one channel, or null when the Society
// has not written one — which is a decision not to notify that way, not an
// error to raise at the member.
export async function templateFor(
  eventCode: string,
  channel: NotificationChannel
): Promise<NotificationTemplate | null> {
  const templates = await listNotificationTemplates();
  return (
    templates.find(
      t => t.eventCode === eventCode && t.channel === channel && t.isActive
    ) ?? null
  );
}

// Every channel a given event has an active template for.
export async function channelsFor(
  eventCode: string
): Promise<NotificationChannel[]> {
  const templates = await listNotificationTemplates();
  return templates
    .filter(t => t.eventCode === eventCode && t.isActive)
    .map(t => t.channel);
}

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/**
 * Fill `{{placeholder}}` slots from the event's own values.
 *
 * A placeholder with no value becomes an empty string rather than being left
 * on the page: a member reading "Dear {{applicant_name}}" is worse than one
 * reading "Dear ,", and both are the template author's to fix. Substitution
 * is one pass, so a value that itself contains braces is inserted as text
 * rather than being expanded again.
 */
export function render(
  template: string,
  values: Record<string, string | null | undefined>
): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = values[key.toLowerCase()];
    return value == null ? '' : String(value);
  });
}

// Which placeholders a body or subject actually uses — what the template
// editor shows an administrator so they can see what is available to them.
export function placeholdersIn(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    found.add(match[1].toLowerCase());
  }
  return [...found].sort();
}

export interface TemplateEdit {
  subject: string | null;
  body: string;
  isActive: boolean;
}

// Configuration write: goes through withConfigurationActor so the trigger
// from migration 0010 can name who changed the wording.
export async function updateNotificationTemplate(
  id: string,
  edit: TemplateEdit,
  actor: { userId: string; email: string }
): Promise<void> {
  await withConfigurationActor(
    { userId: actor.userId, description: actor.email },
    async client => {
      await client.query(
        `update notification_template
            set subject = $2, body = $3, is_active = $4
          where id = $1`,
        [id, edit.subject, edit.body, edit.isActive]
      );
    }
  );
}
