import { SignJWT, jwtVerify } from 'jose';
import { getEntraConfig } from '@lib/config';
import type { AuthUser } from './types';

// Session is a short-lived JWT we sign ourselves (HS256) with AUTH_SESSION_SECRET
// and store in an httpOnly cookie. The middleware verifies it locally on every
// request — no network call and no third-party tokens at rest.
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
  user: AuthUser
): Promise<SessionCookie> {
  const token = await new SignJWT({
    email: user.email,
    name: user.name,
    roles: user.roles,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(key());

  return {
    name: SESSION_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: MAX_AGE_SECONDS,
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
    };
  } catch {
    return null;
  }
}
