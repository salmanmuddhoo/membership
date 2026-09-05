// One-time codes: how they are made, kept and sent (docs/member-app.md).
//
// A code is six digits from the platform's CSPRNG, stored only as a hash
// salted with the challenge's own id, and compared in constant time. What
// leaves the system is the SMS; what stays is nothing an attacker reading
// the table could use.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import {
  getMemberConfig,
  MemberConfigError,
  type MemberConfig,
} from '../config';

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

// +2305xxx234 — enough to recognise a number as one's own, not enough to
// learn it. The country code and the last three digits are what people
// remember.
export function maskMobile(e164: string): string {
  if (e164.length <= 6) return e164;
  return `${e164.slice(0, 5)}xxx${e164.slice(-3)}`;
}

export interface CodeDelivery {
  send(to: string, message: string): Promise<void>;
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
    default:
      throw new MemberConfigError(
        'No way to send one-time codes is configured. Set ' +
          'MEMBER_OTP_DELIVERY=http with MEMBER_OTP_WEBHOOK_URL (or =log on ' +
          'a non-production environment); see .env.example.'
      );
  }
}
