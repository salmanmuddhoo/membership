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
import { ConfigError } from '../config/reference';
import { query, withConfigurationActor } from '../db/pool';
import { placeholdersForEvent } from './event-codes';

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
  // What the same wording is called in the provider's own console, for a
  // channel that sends approved templates rather than finished text (S-903,
  // migration 0057). Null for email, and for a gateway that takes a finished
  // sentence.
  providerTemplateName: string | null;
  providerTemplateLanguage: string;
}

interface TemplateRow {
  id: string;
  event_code: string;
  channel: NotificationChannel;
  subject: string | null;
  body: string;
  is_active: boolean;
  description: string;
  provider_template_name: string | null;
  provider_template_language: string;
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
    providerTemplateName: row.provider_template_name,
    providerTemplateLanguage: row.provider_template_language,
  };
}

export async function listNotificationTemplates(): Promise<
  NotificationTemplate[]
> {
  return cached('notification_templates', async () => {
    const result = await query<TemplateRow>(
      `select id, event_code, channel, subject, body, is_active, description,
              provider_template_name, provider_template_language
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

/**
 * The placeholders a template uses, in the order they first appear.
 *
 * Distinct from placeholdersIn, which sorts: this order is not cosmetic. A
 * provider that sends approved templates (WhatsApp, S-903) takes POSITIONAL
 * parameters — {{1}}, {{2}} — so the Nth placeholder written here is the Nth
 * value sent. Sorting them would silently swap a member's name and their
 * member number.
 *
 * Deduplicated by first appearance: a value used twice in one body is still
 * one parameter, which is what the provider expects.
 */
export function placeholderSequence(template: string): string[] {
  const seen: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1].toLowerCase();
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

export interface TemplateEdit {
  subject: string | null;
  body: string;
  isActive: boolean;
  // Only meaningful on a channel that sends approved templates; ignored
  // elsewhere, so the editing screen need not know which is which.
  providerTemplateName?: string | null;
  providerTemplateLanguage?: string;
}

/**
 * Check an edit before it reaches the database.
 *
 * Two things the schema cannot say for itself, and both of which a member
 * would otherwise be the one to discover:
 *
 *   An email with no subject violates a check constraint (migration 0053),
 *   which would reach the administrator as a database error naming a
 *   constraint rather than as the empty field it actually is.
 *
 *   A placeholder the event does not fill renders as nothing at all — "Your
 *   member number is ." — and nothing anywhere would say why. Only checked
 *   for events this system actually raises; a code someone added by hand is
 *   not necessarily wrong.
 */
export function problemsWithEdit(
  template: NotificationTemplate,
  edit: TemplateEdit
): string[] {
  const problems: string[] = [];

  if (template.channel === 'email' && !edit.subject?.trim()) {
    problems.push('An email needs a subject.');
  }
  if (!edit.body.trim()) {
    problems.push('A message needs wording.');
  }

  const available = placeholdersForEvent(template.eventCode);
  if (available) {
    const used = new Set([
      ...placeholdersIn(edit.body),
      ...placeholdersIn(edit.subject ?? ''),
    ]);
    for (const name of [...used].sort()) {
      if (!available.includes(name)) {
        problems.push(
          `{{${name}}} is not available here. This event fills in ` +
            available.map(a => `{{${a}}}`).join(', ') +
            '.'
        );
      }
    }
  }

  return problems;
}

// Configuration write: goes through withConfigurationActor so the trigger
// from migration 0010 can name who changed the wording. Validated first, so a
// bad edit is refused by name rather than by constraint.
export async function updateNotificationTemplate(
  id: string,
  edit: TemplateEdit,
  actor: { userId: string; email: string }
): Promise<void> {
  const template = (await listNotificationTemplates()).find(t => t.id === id);
  if (!template) {
    throw new ConfigError('That template no longer exists.', 'not_found');
  }

  const problems = problemsWithEdit(template, edit);
  if (problems.length > 0) {
    throw new ConfigError(problems.join(' '), 'invalid');
  }

  await withConfigurationActor(
    { userId: actor.userId, description: actor.email },
    async client => {
      await client.query(
        `update notification_template
            set subject = $2, body = $3, is_active = $4,
                provider_template_name = $5,
                provider_template_language = coalesce($6, 'en')
          where id = $1`,
        [
          id,
          edit.subject,
          edit.body,
          edit.isActive,
          edit.providerTemplateName?.trim() || null,
          edit.providerTemplateLanguage?.trim() || null,
        ]
      );
    }
  );
}
