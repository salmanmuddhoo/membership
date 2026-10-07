// Firebase Cloud Messaging, HTTP v1 (docs/notifications.md, "Push").
//
// Two calls and no SDK: a service-account JWT exchanged for a short-lived
// OAuth token, then one POST per device. The Firebase Admin SDK would do
// the same and bring a dependency tree the Security Audit would have to
// keep clearing; the two requests are small enough to own.
//
// The access token is held in memory until just before it expires. On a
// serverless instance that is "for as long as the instance is warm", which
// is exactly the lifetime a cached credential should have.
import { createSign } from 'node:crypto';
import type { FcmServiceAccount } from '../config';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
// Google issues an hour; renew a minute early so a send never starts with a
// token about to lapse.
const TOKEN_LIFETIME_SECONDS = 3600;
const RENEW_MARGIN_SECONDS = 60;

export class FcmError extends Error {
  constructor(
    message: string,
    // Google's own error code for the device, when the failure is about the
    // token rather than the request: 'UNREGISTERED' is a phone that has
    // uninstalled the app or had its token rotated, and is the one reason
    // to stop sending to it.
    public readonly errorCode: string | null = null,
    public readonly status: number | null = null
  ) {
    super(message);
    this.name = 'FcmError';
  }
}

export function isDeadToken(error: unknown): boolean {
  return (
    error instanceof FcmError &&
    (error.errorCode === 'UNREGISTERED' ||
      error.errorCode === 'INVALID_ARGUMENT' ||
      error.status === 404)
  );
}

const base64url = (input: string | Buffer): string =>
  Buffer.from(input).toString('base64url');

// The signed assertion Google exchanges for an access token: RS256 over the
// service account's claims, with its own private key.
export function serviceAccountAssertion(
  account: FcmServiceAccount,
  now = Math.floor(Date.now() / 1000),
  tokenUrl = TOKEN_URL
): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: SCOPE,
      aud: tokenUrl,
      iat: now,
      exp: now + TOKEN_LIFETIME_SECONDS,
    })
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(account.privateKey).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

interface CachedToken {
  clientEmail: string;
  token: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;

// Tests only.
export function forgetAccessToken(): void {
  cached = null;
}

export async function accessToken(
  account: FcmServiceAccount,
  options: { tokenUrl?: string } = {}
): Promise<string> {
  const tokenUrl = options.tokenUrl ?? TOKEN_URL;
  const now = Date.now();
  if (
    cached &&
    cached.clientEmail === account.clientEmail &&
    cached.expiresAt - RENEW_MARGIN_SECONDS * 1000 > now
  ) {
    return cached.token;
  }
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: serviceAccountAssertion(
      account,
      Math.floor(now / 1000),
      tokenUrl
    ),
  });
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (error) {
    throw new FcmError(
      'Google could not be reached for an access token: ' +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }
  if (!response.ok) {
    throw new FcmError(
      `Google refused the service account (HTTP ${response.status}). ` +
        'Check NOTIFY_PUSH_SERVICE_ACCOUNT.',
      null,
      response.status
    );
  }
  const json = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new FcmError('Google returned no access token.');
  }
  cached = {
    clientEmail: account.clientEmail,
    token: json.access_token,
    expiresAt: now + (json.expires_in ?? TOKEN_LIFETIME_SECONDS) * 1000,
  };
  return cached.token;
}

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  // Small strings the app reads to decide what to open; never anything a
  // member would mind another app on the phone seeing.
  data: Record<string, string>;
  // The Android channel the app registers (expo-notifications).
  channelId?: string;
}

/**
 * One notification to one phone. Throws FcmError: a dead token (see
 * isDeadToken) is the caller's cue to stop sending to it; anything else is
 * a failure to retry.
 */
export async function sendFcm(
  account: FcmServiceAccount,
  message: PushMessage,
  options: { baseUrl?: string; tokenUrl?: string } = {}
): Promise<void> {
  const token = await accessToken(account, { tokenUrl: options.tokenUrl });
  const base = (options.baseUrl ?? 'https://fcm.googleapis.com').replace(
    /\/$/,
    ''
  );
  let response: Response;
  try {
    response = await fetch(
      `${base}/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: message.token,
            notification: { title: message.title, body: message.body },
            data: message.data,
            android: {
              priority: 'high',
              notification: {
                channel_id: message.channelId ?? 'default',
                // The app's own icon and colour, set by its build.
                default_sound: true,
              },
            },
            apns: {
              payload: { aps: { sound: 'default' } },
            },
          },
        }),
      }
    );
  } catch (error) {
    throw new FcmError(
      'Firebase could not be reached: ' +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }
  if (response.ok) return;
  let errorCode: string | null = null;
  let detail = '';
  try {
    const json = (await response.json()) as {
      error?: {
        message?: string;
        details?: { errorCode?: string }[];
        status?: string;
      };
    };
    errorCode =
      json.error?.details?.find(d => typeof d.errorCode === 'string')
        ?.errorCode ??
      json.error?.status ??
      null;
    detail = json.error?.message ?? '';
  } catch {
    // Not JSON; the status is all there is.
  }
  throw new FcmError(
    `Firebase refused the send (HTTP ${response.status}` +
      (errorCode ? `, ${errorCode}` : '') +
      `)${detail ? `: ${detail}` : '.'}`,
    errorCode,
    response.status
  );
}
