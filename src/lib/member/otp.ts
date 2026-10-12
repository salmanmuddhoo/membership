// One-time codes: how they are made, kept and sent (docs/member-app.md).
//
// A code is six digits from the platform's CSPRNG, stored only as a hash
// salted with the challenge's own id, and compared in constant time. What
// leaves the system is the message; what stays is nothing an attacker reading
// the table could use.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import {
  getMemberConfig,
  getNotificationConfig,
  MemberConfigError,
  type MemberConfig,
} from '../config';
import { channelFor } from '../notifications/channels';

export const CODE_LENGTH = 6;
export const CODE_TTL_SECONDS = 5 * 60;
export const MAX_ATTEMPTS = 5;

export function generateCode(config: MemberConfig = getMemberConfig()): string {
  if (config.otpFixedCode) return config.otpFixedCode;
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

export function hashCode(challengeId: string, code: string): string {
  return createHash('sha256').update(`${challengeId}:${code}`).digest('hex');
}

export function codeMatches(
  challengeId: string,
  code: string,
  storedHash: string
): boolean {
  const candidate = Buffer.from(hashCode(challengeId, code), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return (
    candidate.length === stored.length && timingSafeEqual(candidate, stored)
  );
}

// What the person sees. Deliberately plain: an SMS is read on a lock screen.
export function codeMessage(code: string): string {
  return `${code} is your Al Barakah code. It expires in 5 minutes. Never share it.`;
}

// +230 5*** *428 — enough to recognise a number as one's own, not enough to
// learn it. The country code, the first digit and the last three are what
// people remember. A number from elsewhere keeps its first four characters
// and its last three.
export function maskMobile(e164: string): string {
  const mauritian = /^\+230(\d)(\d{4})(\d{3})$/.exec(e164);
  if (mauritian) return `+230 ${mauritian[1]}*** *${mauritian[3]}`;
  if (e164.length <= 7) return e164;
  return `${e164.slice(0, 4)} ${'*'.repeat(e164.length - 7)}${e164.slice(-3)}`;
}

// s***o@gmail.com — the first and last letters before the @, and the
// domain, which says where to look without spelling out the address.
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const shown =
    local.length <= 2 ? `${local[0]}***` : `${local[0]}***${local.slice(-1)}`;
  return `${shown}${email.slice(at)}`;
}

// What the audit trail and the officers' screens call the person who signed
// in from the app: the masked mobile or email the code proved.
export function principalLabel(principal: {
  mobile: string | null;
  email: string | null;
}): string {
  return `member-app:${
    principal.mobile
      ? maskMobile(principal.mobile)
      : maskEmail(principal.email ?? '')
  }`;
}

export interface CodeDelivery {
  // The finished message, and the code inside it on its own: a gateway sends
  // the message, while WhatsApp fills its approved template with the code.
  send(to: string, message: string, code: string): Promise<void>;
}

// What the app tells the person to look in, for a code sent to a phone:
// WhatsApp or an SMS, as this site sends them. Decided by configuration.
export function phoneChannel(
  config: MemberConfig = getMemberConfig()
): 'sms' | 'whatsapp' {
  return config.otpDelivery === 'whatsapp' ? 'whatsapp' : 'sms';
}

export class CodeDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeDeliveryError';
  }
}

// The transport is chosen by configuration, never by the caller: a test
// environment logs the code, a deployed one posts it to whatever gateway the
// Society uses, and one with neither configured refuses rather than failing
// quietly after the challenge was already recorded.
export function codeDelivery(
  config: MemberConfig = getMemberConfig()
): CodeDelivery {
  switch (config.otpDelivery) {
    case 'log':
      return {
        async send(to, message) {
          // Non-production only, enforced in getMemberConfig. The log is how
          // a tester reads the code back.
          console.info(JSON.stringify({ kind: 'member-otp', to, message }));
        },
      };
    case 'http':
      return {
        async send(to, message) {
          const headers: Record<string, string> = {
            'content-type': 'application/json',
          };
          if (config.otpWebhookToken) {
            headers.authorization = `Bearer ${config.otpWebhookToken}`;
          }
          let response: Response;
          try {
            response = await fetch(config.otpWebhookUrl!, {
              method: 'POST',
              headers,
              body: JSON.stringify({ to, message }),
            });
          } catch (error) {
            console.error('[member-otp] gateway unreachable:', error);
            throw new CodeDeliveryError('The code could not be sent.');
          }
          if (!response.ok) {
            console.error(
              `[member-otp] gateway refused: HTTP ${response.status}`
            );
            throw new CodeDeliveryError('The code could not be sent.');
          }
        },
      };
    case 'whatsapp':
      return {
        async send(to, _message, code) {
          await sendThroughWhatsapp(to, code, config.otpWhatsapp!);
        },
      };
    default:
      throw new MemberConfigError(
        'No way to send one-time codes is configured. Set ' +
          'MEMBER_OTP_DELIVERY=http with MEMBER_OTP_WEBHOOK_URL, or ' +
          '=whatsapp with MEMBER_OTP_WHATSAPP_TEMPLATE and ' +
          'NOTIFY_WHATSAPP_PHONE_NUMBER_ID and NOTIFY_WHATSAPP_TOKEN (or =log ' +
          'on a non-production environment); see .env.example.'
      );
  }
}

export const EMAIL_SUBJECT = 'Your Al Barakah code';

/**
 * Codes by email go out the way the Society's other email does
 * (NOTIFY_EMAIL_*, docs/notifications.md): its Microsoft 365 mailbox, a
 * gateway, or the log on a non-production site. A site that cannot send
 * email says so, and the person can choose the phone instead.
 */
export function emailCodeDelivery(): CodeDelivery {
  return {
    async send(to, message) {
      try {
        await channelFor('email', getNotificationConfig().email).send({
          channel: 'email',
          recipient: to,
          subject: EMAIL_SUBJECT,
          body:
            `${message}\n\n` +
            'If you did not ask for this code, you can ignore this email.',
        });
      } catch (error) {
        console.error('[member-otp] email not sent:', error);
        throw new CodeDeliveryError(
          'The code could not be sent by email. Choose WhatsApp, or try ' +
            'again later.'
        );
      }
    },
  };
}

/**
 * Send a code through Meta's WhatsApp Business Platform (the Cloud API).
 *
 * A business may send a code only as an Authentication template Meta
 * approved in advance, whose wording is Meta's own ("123456 is your
 * verification code") and whose one variable is the code. Its copy-code
 * button carries the code too, as the button's own parameter, and Meta
 * refuses the message without it. So what goes on the wire is the template
 * and the code, never our finished sentence.
 */
async function sendThroughWhatsapp(
  to: string,
  code: string,
  whatsapp: NonNullable<MemberConfig['otpWhatsapp']>
): Promise<void> {
  const base = whatsapp.baseUrl ?? 'https://graph.facebook.com';
  const version = whatsapp.apiVersion ?? 'v21.0';
  let response: Response;
  try {
    response = await fetch(
      `${base}/${version}/${whatsapp.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${whatsapp.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          // Meta wants the number in international form without the '+'.
          to: to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: whatsapp.template,
            language: { code: whatsapp.language },
            components: [
              { type: 'body', parameters: [{ type: 'text', text: code }] },
              {
                type: 'button',
                sub_type: 'url',
                index: '0',
                parameters: [{ type: 'text', text: code }],
              },
            ],
          },
        }),
      }
    );
  } catch (error) {
    console.error('[member-otp] WhatsApp unreachable:', error);
    throw new CodeDeliveryError('The code could not be sent.');
  }
  if (!response.ok) {
    // Meta's body names the reason (an unapproved template, a wrong
    // language, an expired token) and the status alone does not. Whatever
    // it repeats, the code is void: a failed send takes its challenge with it.
    const detail = await response.text().catch(() => '');
    console.error(
      `[member-otp] WhatsApp refused: HTTP ${response.status} ` +
        detail.slice(0, 500)
    );
    throw new CodeDeliveryError('The code could not be sent.');
  }
}
