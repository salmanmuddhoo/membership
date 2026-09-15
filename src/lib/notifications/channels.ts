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
import type { Channel, OutgoingMessage } from './notify';
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
async function sendThroughGraph(
  message: OutgoingMessage,
  from: string
): Promise<void> {
  const credentials = getGraphCredentials();
  const token = await getAccessToken(credentials);

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
