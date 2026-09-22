// The providers themselves (S-902 email, S-903 WhatsApp).
//
// This is the only file in the system that knows a provider exists. Above it,
// notify() has templates, an outbox and a Channel interface; below it there is
// a mailbox and a gateway. That boundary is decision 11's whole point: the
// Society will change provider, and changing it should be changing
// configuration.
//
// Every failure here throws. That is not a contradiction of "a notification
// never breaks the thing that caused it" — notify() catches, records the
// reason against the notification row and carries on. Throwing is how a
// failure reaches the delivery log (S-904) instead of being swallowed at the
// bottom of the stack where nobody will ever see it.
import {
  getNotificationConfig,
  NotificationConfigError,
  type ChannelDelivery,
  type NotificationConfig,
} from '../config';
import { getAccessToken, getGraphCredentials } from '../documents/graph';
import type { Attachment, Channel, OutgoingMessage } from './notify';
import type { NotificationChannel } from './templates';

export class NotificationSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationSendError';
  }
}

/**
 * Send through the Society's own Microsoft 365 mailbox.
 *
 * Reuses the GRAPH_* app registration the document library already uses —
 * same tenant, same client credentials, one more application permission
 * (`Mail.Send`) and a mailbox to send as. Sending as the application rather
 * than as the officer is the same bargain documents make: no officer needs a
 * licence, and who caused the send lives in our own outbox.
 */
/**
 * The attached document's bytes, fetched from its own signed link. Fetched
 * at send time rather than carried on the row: the link is what the row
 * stores, and a retry days later reads the same document the first attempt
 * would have. A document that cannot be fetched fails the send, visibly,
 * rather than going out without it.
 */
async function fetchAttachment(attachment: Attachment): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(attachment.url);
  } catch (error) {
    throw new NotificationSendError(
      'The attached document could not be fetched: ' +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }
  if (!response.ok) {
    throw new NotificationSendError(
      `The attached document could not be fetched (HTTP ${response.status}).`
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function sendThroughGraph(
  message: OutgoingMessage,
  from: string
): Promise<void> {
  const credentials = getGraphCredentials();
  const token = await getAccessToken(credentials);
  const attachments = message.attachment
    ? [
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: message.attachment.filename,
          contentType: message.attachment.contentType,
          contentBytes: Buffer.from(
            await fetchAttachment(message.attachment)
          ).toString('base64'),
        },
      ]
    : undefined;

  const response = await fetch(
    `${credentials.graphBaseUrl}/users/${encodeURIComponent(from)}/sendMail`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject: message.subject ?? '',
          // Text, never HTML. The body came from a template an administrator
          // wrote (see templates.ts): treating it as markup would make the
          // template editor a way to put markup in a member's inbox.
          body: { contentType: 'Text', content: message.body },
          toRecipients: [{ emailAddress: { address: message.recipient } }],
          ...(attachments ? { attachments } : {}),
        },
        // The Society's record of what it sent is this system's outbox, which
        // already holds the rendered text. A second copy in a mailbox nobody
        // reads is not worth the storage.
        saveToSentItems: false,
      }),
    }
  );

  if (!response.ok) {
    // Graph names the reason — a missing Mail.Send consent and a mailbox that
    // does not exist look identical without it. No member data is in it.
    const detail = await response.text().catch(() => '');
    throw new NotificationSendError(
      `Graph sendMail failed (${response.status}): ${detail.slice(0, 500)}`
    );
  }
}

/**
 * Send through Meta's WhatsApp Business Platform (the Cloud API).
 *
 * Business-initiated messages — which every notification here is, since
 * nobody messages the Society to ask whether their application was approved —
 * may only be sent as a template Meta approved in advance. So this does not
 * post the finished sentence: it names the approved template and supplies the
 * values for its positional {{1}}, {{2}} slots, in the order the placeholders
 * appear in our own body (migration 0057).
 *
 * The rendered text still travels on the outbox row. It is what the member
 * was told, and what the delivery log shows; it simply is not what goes on
 * the wire for this one provider.
 */
async function sendThroughCloudApi(
  message: OutgoingMessage,
  delivery: ChannelDelivery
): Promise<void> {
  if (!message.providerTemplateName) {
    throw new NotificationConfigError(
      'This message has no WhatsApp template name, and WhatsApp will not ' +
        'accept a business-initiated message without one. Set it on ' +
        'Configuration → Notification wording to match the template ' +
        'approved in the Meta console.'
    );
  }

  const base = delivery.baseUrl ?? 'https://graph.facebook.com';
  const version = delivery.apiVersion ?? 'v21.0';
  // Meta wants the number in international form without the leading '+'.
  const to = message.recipient.replace(/^\+/, '');

  // A document travels as the template's header (S-1602): Meta fetches it
  // from the link itself, so nothing is uploaded here. The template must
  // have been registered with a document header, which is why sending one
  // is the wording's own switch and not automatic.
  const components: unknown[] = [];
  if (message.attachment) {
    components.push({
      type: 'header',
      parameters: [
        {
          type: 'document',
          document: {
            link: message.attachment.url,
            filename: message.attachment.filename,
          },
        },
      ],
    });
  }
  if ((message.parameters ?? []).length > 0) {
    components.push({
      type: 'body',
      parameters: (message.parameters ?? []).map(text => ({
        type: 'text',
        text,
      })),
    });
  }

  let response: Response;
  try {
    response = await fetch(
      `${base}/${version}/${delivery.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${delivery.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: message.providerTemplateName,
            language: { code: message.providerTemplateLanguage ?? 'en' },
            // Omitted entirely for a template with no variables and no
            // document: Meta rejects an empty component list rather than
            // treating it as none.
            ...(components.length > 0 ? { components } : {}),
          },
        }),
      }
    );
  } catch (error) {
    throw new NotificationSendError(
      'WhatsApp could not be reached: ' +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }

  if (!response.ok) {
    // Meta's body names the actual reason — an unapproved template, a number
    // outside the allowed list on a trial account, an expired token — and
    // those are indistinguishable from the status alone. It carries no member
    // data beyond the number already on the row.
    const detail = await response.text().catch(() => '');
    throw new NotificationSendError(
      `WhatsApp refused the message (${response.status}): ` +
        detail.slice(0, 500)
    );
  }
}

/**
 * Post to whichever gateway the Society uses.
 *
 * The body is `{ channel, to, subject, message }` — a superset of the
 * `{ to, message }` the member app's one-time codes already post
 * (MEMBER_OTP_WEBHOOK_URL), so one gateway can carry both and tell them apart
 * by `channel`. `subject` is absent on a channel that has no such field.
 */
async function sendThroughGateway(
  message: OutgoingMessage,
  delivery: ChannelDelivery
): Promise<void> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (delivery.webhookToken) {
    headers.authorization = `Bearer ${delivery.webhookToken}`;
  }

  let response: Response;
  try {
    response = await fetch(delivery.webhookUrl!, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        channel: message.channel,
        to: message.recipient,
        ...(message.subject === null ? {} : { subject: message.subject }),
        message: message.body,
        // Where the gateway can fetch the document from, when there is one.
        ...(message.attachment ? { attachment: message.attachment } : {}),
      }),
    });
  } catch (error) {
    throw new NotificationSendError(
      `The ${message.channel} gateway could not be reached: ` +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }

  if (!response.ok) {
    throw new NotificationSendError(
      `The ${message.channel} gateway refused the message ` +
        `(HTTP ${response.status}).`
    );
  }
}

// Non-production only, enforced in getNotificationConfig. A working channel
// rather than a stub: the outbox, the templates and the rendering are all
// exercised, and a developer reads what a member would have been sent.
function logSend(message: OutgoingMessage): void {
  console.info(
    JSON.stringify({
      kind: 'notification',
      channel: message.channel,
      to: message.recipient,
      subject: message.subject,
      body: message.body,
      ...(message.attachment ? { attachment: message.attachment } : {}),
    })
  );
}

/**
 * The channel one kind of delivery makes.
 *
 * An unconfigured channel refuses rather than pretending. Silently succeeding
 * would put 'sent' against a notification nobody received, which is precisely
 * the silent failure S-904 exists to make impossible.
 */
export function channelFor(
  name: NotificationChannel,
  delivery: ChannelDelivery
): Channel {
  return {
    name,
    async send(message: OutgoingMessage): Promise<void> {
      switch (delivery.kind) {
        case 'graph':
          return sendThroughGraph(message, delivery.from!);
        case 'cloud_api':
          return sendThroughCloudApi(message, delivery);
        case 'http':
          return sendThroughGateway(message, delivery);
        case 'log':
          return logSend(message);
        default:
          throw new NotificationConfigError(
            `No ${name} provider is configured, so nothing was sent. Set ` +
              `NOTIFY_${name.toUpperCase()}_DELIVERY and its settings — ` +
              'see .env.example.'
          );
      }
    },
  };
}

/**
 * Every channel, as this environment has them configured.
 *
 * Read per send rather than once at startup: on Vercel the environment is
 * available at request time, and a serverless instance that started before a
 * setting was added would otherwise keep the old answer for as long as it
 * stays warm.
 */
export function configuredChannels(
  config: NotificationConfig = getNotificationConfig()
): Map<NotificationChannel, Channel> {
  return new Map<NotificationChannel, Channel>([
    ['email', channelFor('email', config.email)],
    ['whatsapp', channelFor('whatsapp', config.whatsapp)],
  ]);
}

// A channel registered here wins over whatever the environment describes.
// That is how a test substitutes a channel it can inspect, and how anything
// that must send through something configuration cannot express does so.
const overrides = new Map<NotificationChannel, Channel>();

export function registerChannel(channel: Channel): void {
  overrides.set(channel.name, channel);
}

// Tests only: forget every override, so one file's substitute channel is not
// still in place in the next.
export function resetChannels(): void {
  overrides.clear();
}

/**
 * The channels as this environment actually has them: what configuration
 * describes, with any override laid over the top.
 *
 * EVERY sender resolves through here — notify()'s first attempt and the retry
 * job alike. Resolving it in two places is exactly how the two came to
 * disagree about which provider carries a message: the retry job used to read
 * configuration directly and silently ignore a registered channel.
 */
export function activeChannels(): Map<NotificationChannel, Channel> {
  const channels = configuredChannels();
  for (const [name, channel] of overrides) channels.set(name, channel);
  return channels;
}
