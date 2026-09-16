// Proving the delivery setup works, without waiting for a real member.
//
// Everything about notifications is configuration an administrator sets in
// two places at once — environment variables for the provider, template
// wording in the application — and until this, the only way to find out
// whether the two agreed was to approve somebody's application and see
// whether they heard anything. That is a poor way to discover an expired
// token.
//
// Deliberately NOT written to the outbox. A test is a diagnostic, answered on
// the screen of the person who asked: recording one would put a message no
// member was meant to receive into the record of what the Society told its
// members, and hand the retry job something to keep attempting for thirty
// hours after a failed experiment.
//
// It IS audited. A control that sends a message to an arbitrary number is one
// the Society should be able to see the use of.
import { recordAudit } from '../access/audit';
import { placeholdersForEvent } from './event-codes';
import { activeChannels } from './channels';
import type { OutgoingMessage } from './notify';
import {
  listNotificationTemplates,
  placeholderSequence,
  render,
  type NotificationChannel,
  type NotificationTemplate,
} from './templates';

export const TEST_AUDIT_ACTION = 'notification.test_sent';

/**
 * Stand-in values, so the test reads as a real message rather than as a page
 * of braces.
 *
 * Obviously fake on purpose: if one of these ever reaches a member, it should
 * be unmistakable that it was a test rather than a real approval with the
 * wrong name on it.
 */
const SAMPLES: Record<string, string> = {
  applicant_name: 'TEST — not a real applicant',
  reference: 'APP-TEST',
  member_no: 'AB-TEST',
  comment: 'This is a test message. No action is needed.',
};

export function sampleValues(eventCode: string): Record<string, string> {
  const names = placeholdersForEvent(eventCode) ?? [];
  return Object.fromEntries(names.map(n => [n, SAMPLES[n] ?? `TEST ${n}`]));
}

export interface TestSendRequest {
  templateId: string;
  // Where to send it: an address for email, an international-form number for
  // WhatsApp. Never a member's, in normal use — this is for the administrator
  // setting the channel up, sending to themselves.
  recipient: string;
}

export interface TestSendResult {
  channel: NotificationChannel;
  recipient: string;
  // What the recipient should be looking for.
  subject: string | null;
  body: string;
}

export class TestSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestSendError';
  }
}

function messageFor(
  template: NotificationTemplate,
  recipient: string
): OutgoingMessage {
  const values = sampleValues(template.eventCode);
  return {
    channel: template.channel,
    recipient,
    subject: template.subject ? render(template.subject, values) : null,
    body: render(template.body, values),
    providerTemplateName: template.providerTemplateName,
    providerTemplateLanguage: template.providerTemplateLanguage,
    // The same positional values a real send would supply, so a template the
    // provider has not approved fails HERE rather than on a real approval.
    parameters: template.providerTemplateName
      ? placeholderSequence(template.body).map(n => values[n] ?? '')
      : null,
  };
}

/**
 * Send one template to one address, and say what happened.
 *
 * Unlike notify(), this THROWS on failure. The whole value of a test is the
 * reason it did not work — an unapproved template name, an expired token, a
 * mailbox that does not exist — so the provider's own words are carried back
 * to the person who pressed the button rather than swallowed.
 */
export async function sendTestNotification(
  request: TestSendRequest,
  actor: { userId: string; email: string }
): Promise<TestSendResult> {
  const recipient = request.recipient.trim();
  if (recipient === '') {
    throw new TestSendError('Enter where the test should be sent.');
  }

  const template = (await listNotificationTemplates()).find(
    t => t.id === request.templateId
  );
  if (!template) {
    throw new TestSendError('That wording no longer exists.');
  }

  if (template.channel === 'email' && !recipient.includes('@')) {
    throw new TestSendError('Enter an email address.');
  }
  if (template.channel === 'whatsapp' && !/^\+\d{8,15}$/.test(recipient)) {
    throw new TestSendError(
      'Enter a number in international form, such as +23057891234.'
    );
  }

  const message = messageFor(template, recipient);

  // Audited before the attempt, not after: the fact that someone sent a
  // message to this number is worth recording whether or not it arrived.
  await recordAudit({
    actorUserId: actor.userId,
    actorDescription: actor.email,
    action: TEST_AUDIT_ACTION,
    entityType: 'notification_template',
    entityId: template.id,
    newValue: {
      channel: template.channel,
      eventCode: template.eventCode,
      recipient,
    },
  });

  await activeChannels().get(template.channel)!.send(message);

  return {
    channel: template.channel,
    recipient,
    subject: message.subject,
    body: message.body,
  };
}

export interface ChannelStatus {
  channel: NotificationChannel;
  // What is carrying this channel, in words rather than a config value.
  provider: string;
  configured: boolean;
}

const PROVIDER_NAMES: Record<string, string> = {
  graph: 'Microsoft 365 mailbox',
  cloud_api: 'WhatsApp Cloud API',
  http: 'Gateway',
  log: 'Server log (test environments only)',
  unconfigured: 'Not configured',
};

// What each channel is set up to use, for the page that has to tell an
// administrator why nothing is arriving.
export function channelStatuses(
  config: import('../config').NotificationConfig
): ChannelStatus[] {
  return (['email', 'whatsapp'] as const).map(channel => {
    const kind = config[channel].kind;
    return {
      channel,
      provider: PROVIDER_NAMES[kind] ?? kind,
      configured: kind !== 'unconfigured',
    };
  });
}
