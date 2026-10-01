import { SignJWT, jwtVerify } from 'jose';
import { getEntraConfig } from '../config';
import type { AuthUser } from './types';

// Session is a short-lived JWT we sign ourselves (HS256) with AUTH_SESSION_SECRET
// and store in an httpOnly cookie. The middleware verifies it locally on every
// request — no network call and no third-party tokens at rest.
//
// It carries the sign-in's own id (sid) and when it was last used (seen), so
// the middleware can sign out a session left idle (session.idle_minutes) and
// the audit trail can pair a sign-in with how it ended. The 8 hours are an
// absolute cap from the sign-in, however active the session stays.
export const SESSION_COOKIE = 'ab_session';
const MAX_AGE_SECONDS = 60 * 60 * 8; // 8 hours

function key(): Uint8Array {
  return new TextEncoder().encode(getEntraConfig().sessionSecret);
}

export interface SessionCookie {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    secure: true;
    sameSite: 'lax';
    path: string;
    maxAge: number;
  };
}

export async function createSessionCookie(
  user: AuthUser,
  // Carried over when an existing session is renewed; new at sign-in.
  session: { sessionId: string; signedInAt: number } = {
    sessionId: crypto.randomUUID(),
    signedInAt: Math.floor(Date.now() / 1000),
  }
): Promise<SessionCookie> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = session.signedInAt + MAX_AGE_SECONDS;
  const token = await new SignJWT({
    email: user.email,
    name: user.name,
    roles: user.roles,
    sid: session.sessionId,
    seen: now,
    auth_time: session.signedInAt,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(key());

  return {
    name: SESSION_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.max(expiresAt - now, 0),
    },
  };
}

export async function readSession(token?: string): Promise<AuthUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    return {
      id: payload.sub ?? '',
      email: (payload.email as string | undefined) ?? null,
      name: (payload.name as string | undefined) ?? null,
      roles: (payload.roles as string[] | undefined) ?? [],
      sessionId: payload.sid as string | undefined,
      lastSeen: (payload.seen as number | undefined) ?? payload.iat,
      signedInAt: (payload.auth_time as number | undefined) ?? payload.iat,
    };
  } catch {
    return null;
  }
}
