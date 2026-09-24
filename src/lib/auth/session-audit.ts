// Who was signed in, and when (officer request): every sign-in, sign-out and
// idle sign-out is written to the audit trail under the session's own id
// (the `sid` the session cookie carries), so the audit log can pair each
// sign-in with how and when it ended.
import { recordAuditQuietly } from '../access/audit';
import { query } from '../db/pool';
import type { AuthUser } from './types';

export const ACTION_SIGNED_IN = 'auth.signed_in';
export const ACTION_SIGNED_OUT = 'auth.signed_out';
export const ACTION_TIMED_OUT = 'auth.timed_out';
export const SESSION_ENTITY = 'auth_session';

export type SessionAction =
  typeof ACTION_SIGNED_IN | typeof ACTION_SIGNED_OUT | typeof ACTION_TIMED_OUT;

// The staff account behind an Entra subject, when there is one. A sign-in by
// someone not (or no longer) provisioned is still recorded, by email.
async function appUserFor(subject: string): Promise<string | null> {
  if (!subject) return null;
  const result = await query<{ id: string }>(
    `select id from app_user where entra_subject = $1`,
    [subject]
  );
  return result.rows[0]?.id ?? null;
}

// Never throws: the trail having a hole is logged loudly, but signing in or
// out must not fail because of it.
export async function recordSessionEvent(
  user: AuthUser,
  action: SessionAction,
  ipAddress: string | null
): Promise<void> {
  if (!user.sessionId) return;
  let actorUserId: string | null = null;
  try {
    actorUserId = await appUserFor(user.id);
  } catch (error) {
    console.error('[auth] could not resolve the account signing in:', error);
  }
  await recordAuditQuietly({
    actorUserId,
    actorDescription: user.email ?? `entra:${user.id}`,
    action,
    entityType: SESSION_ENTITY,
    entityId: user.sessionId,
    newValue: {
      name: user.name,
      signedInAt: user.signedInAt
        ? new Date(user.signedInAt * 1000).toISOString()
        : undefined,
      lastSeen: user.lastSeen
        ? new Date(user.lastSeen * 1000).toISOString()
        : undefined,
    },
    ipAddress,
  });
}

export function clientAddress(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const first = forwarded.split(',')[0]?.trim();
  return first && first.length <= 45 ? first : null;
}
