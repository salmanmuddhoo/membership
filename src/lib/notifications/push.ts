// Push notifications to the member app (docs/notifications.md, "Push";
// migration 0118).
//
// The channel's recipient is not an address but who it is for —
// 'member:<id>', 'customer:<id>' or 'everyone' — and the phones behind
// that are member_device rows, read at send time. A phone registered after
// the row was written still hears a retry; a session revoked since does
// not. The provider (Firebase, a gateway, the log) is chosen the way every
// other channel's is: by configuration, in one place.
//
// A broadcast is one notification row and many sends. The row is 'sent'
// when every phone that could be reached was; a phone the provider says is
// gone is disabled and does not fail the row; a provider that cannot be
// reached at all fails it, for the retry job.
import type { ChannelDelivery } from '../config';
import { NotificationConfigError } from '../config';
import type pg from 'pg';
import { query } from '../db/pool';
import type { MemberPrincipal } from '../member/identity';
import { isDeadToken, sendFcm } from './fcm';
import type { Channel, OutgoingMessage } from './notify';

export const PUSH_EVERYONE = 'everyone';

export type HolderKind = 'member' | 'customer';

// How a member's own events name their phones.
export function pushRecipient(kind: HolderKind, id: string): string {
  return `${kind}:${id}`;
}

export function pushRecipientFor(principal: MemberPrincipal): string | null {
  if (principal.memberId) return pushRecipient('member', principal.memberId);
  if (principal.customerId) {
    return pushRecipient('customer', principal.customerId);
  }
  return null;
}

export class PushSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushSendError';
  }
}

// --- The phones --------------------------------------------------------------

export interface DeviceInput {
  token: string;
  platform: 'android' | 'ios';
  appBuild?: string | null;
}

export class DeviceError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, string[]>
  ) {
    super(message);
    this.name = 'DeviceError';
  }
}

/**
 * This phone, for this session. The same token again — every start of the
 * app registers — refreshes the row; a token that moves to another session
 * (the same phone linked again) moves with it, and one the provider had
 * disabled comes back, since the phone has just proved it is alive.
 */
export async function registerDevice(
  principal: MemberPrincipal,
  input: DeviceInput
): Promise<void> {
  const details: Record<string, string[]> = {};
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!token || token.length > 4096) {
    details.token = ['A device token is required.'];
  }
  if (input.platform !== 'android' && input.platform !== 'ios') {
    details.platform = ['android or ios.'];
  }
  if (Object.keys(details).length > 0) {
    throw new DeviceError('Check the details.', details);
  }
  const appBuild =
    typeof input.appBuild === 'string' && input.appBuild.trim()
      ? input.appBuild.trim().slice(0, 80)
      : null;
  await query(
    `insert into member_device
       (session_id, member_id, customer_id, platform, token, app_build)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (token) do update
       set session_id = excluded.session_id,
           member_id = excluded.member_id,
           customer_id = excluded.customer_id,
           platform = excluded.platform,
           app_build = excluded.app_build,
           last_seen_at = now(),
           disabled_at = null,
           disabled_reason = null`,
    [
      principal.sessionId,
      principal.memberId,
      principal.customerId,
      input.platform,
      token,
      appBuild,
    ]
  );
}

/** The member withdrew this phone (signing out). Only their own. */
export async function unregisterDevice(
  principal: MemberPrincipal,
  token: string
): Promise<void> {
  if (typeof token !== 'string' || !token.trim()) return;
  await query(
    `update member_device
        set disabled_at = now(), disabled_reason = 'withdrawn'
      where token = $1 and session_id = $2 and disabled_at is null`,
    [token.trim(), principal.sessionId]
  );
}

/**
 * Every phone of a session, silenced with it. Called wherever a session is
 * revoked, so a signed-out phone — or a lost one a branch revoked — hears
 * nothing more.
 */
export async function disableSessionDevices(
  sessionId: string,
  reason: string,
  client?: pg.PoolClient
): Promise<void> {
  const sql = `update member_device
      set disabled_at = now(), disabled_reason = $2
    where session_id = $1 and disabled_at is null`;
  if (client) await client.query(sql, [sessionId, reason]);
  else await query(sql, [sessionId, reason]);
}

async function disableToken(token: string, reason: string): Promise<void> {
  await query(
    `update member_device
        set disabled_at = now(), disabled_reason = $2
      where token = $1 and disabled_at is null`,
    [token, reason.slice(0, 200)]
  );
}

interface DeviceRow {
  token: string;
  platform: 'android' | 'ios';
}

// The live phones behind a recipient: registered, not disabled, and on a
// session that still stands.
export async function devicesFor(recipient: string): Promise<DeviceRow[]> {
  const live = `d.disabled_at is null
       and s.revoked_at is null and s.expires_at > now()`;
  if (recipient === PUSH_EVERYONE) {
    const result = await query<DeviceRow>(
      `select d.token, d.platform
         from member_device d
         join member_session s on s.id = d.session_id
        where ${live}
        order by d.registered_at`
    );
    return result.rows;
  }
  const match = /^(member|customer):([0-9a-f-]{36})$/.exec(recipient);
  if (!match) return [];
  const column = match[1] === 'member' ? 'd.member_id' : 'd.customer_id';
  const result = await query<DeviceRow>(
    `select d.token, d.platform
       from member_device d
       join member_session s on s.id = d.session_id
      where ${column} = $1 and ${live}
      order by d.registered_at`,
    [match[2]]
  );
  return result.rows;
}

/** Whether anyone would hear: what notify() asks before writing a row. */
export async function hasDevices(recipient: string): Promise<boolean> {
  return (await devicesFor(recipient)).length > 0;
}

// --- The send ----------------------------------------------------------------

// Phones are written to a few at a time rather than all at once: a
// broadcast to the whole membership is thousands of requests, and a
// serverless function has a ceiling, so the batch keeps each one short
// without serialising the lot.
const CONCURRENCY = 20;

type Sender = (device: DeviceRow) => Promise<void>;

async function sendToAll(
  devices: DeviceRow[],
  send: Sender
): Promise<{ delivered: number; dead: number; failures: string[] }> {
  let delivered = 0;
  let dead = 0;
  const failures: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < devices.length) {
      const device = devices[next++];
      try {
        await send(device);
        delivered += 1;
      } catch (error) {
        if (isDeadToken(error)) {
          dead += 1;
          await disableToken(
            device.token,
            error instanceof Error ? error.message : 'refused'
          );
        } else {
          failures.push(
            error instanceof Error ? error.message : 'unknown error'
          );
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, devices.length) }, worker)
  );
  return { delivered, dead, failures };
}

function senderFor(
  delivery: ChannelDelivery,
  message: OutgoingMessage
): Sender {
  const title = message.subject ?? 'Al Barakah';
  const data = message.data ?? {};
  switch (delivery.kind) {
    case 'fcm':
      return device =>
        sendFcm(
          delivery.serviceAccount!,
          { token: device.token, title, body: message.body, data },
          { baseUrl: delivery.baseUrl }
        );
    case 'http':
      return async device => {
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
              channel: 'push',
              to: device.token,
              platform: device.platform,
              subject: title,
              message: message.body,
              data,
            }),
          });
        } catch (error) {
          throw new PushSendError(
            'The gateway could not be reached: ' +
              (error instanceof Error ? error.message : 'unknown error')
          );
        }
        if (!response.ok) {
          throw new PushSendError(
            `The gateway refused the send (HTTP ${response.status}).`
          );
        }
      };
    case 'log':
      return async device => {
        console.info(
          JSON.stringify({
            kind: 'notification',
            channel: 'push',
            to: device.token,
            subject: title,
            body: message.body,
            data,
          })
        );
      };
    default:
      throw new NotificationConfigError(
        'No push provider is configured, so nothing was sent. Set ' +
          'NOTIFY_PUSH_DELIVERY=fcm with NOTIFY_PUSH_SERVICE_ACCOUNT — see ' +
          '.env.example and docs/notifications.md.'
      );
  }
}

/**
 * The push channel. Resolves the phones behind the recipient and writes to
 * each; a dead token is disabled, a provider failure on every phone fails
 * the send (so the retry job comes back to it), and a recipient with no
 * live phone is simply nobody to tell.
 */
export function pushChannel(delivery: ChannelDelivery): Channel {
  return {
    name: 'push',
    async send(message: OutgoingMessage): Promise<void> {
      const send = senderFor(delivery, message);
      const devices = await devicesFor(message.recipient);
      if (devices.length === 0) return;
      const outcome = await sendToAll(devices, send);
      if (outcome.delivered === 0 && outcome.failures.length > 0) {
        throw new PushSendError(outcome.failures[0]);
      }
      if (outcome.failures.length > 0) {
        // Some phones heard, some did not: the row stands as sent — a
        // retry would tell the first lot twice — and the shortfall is in
        // the log.
        console.warn(
          `[push] ${outcome.failures.length} of ${devices.length} phones ` +
            `not reached: ${outcome.failures[0]}`
        );
      }
    },
  };
}
