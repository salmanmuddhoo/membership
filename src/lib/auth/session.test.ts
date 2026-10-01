import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The staff session cookie (officer request: sign out after inactivity): it
// carries the sign-in's own id and when it was last used, a renewal keeps
// both the id and the sign-in time, and the 8 hours stay counted from the
// sign-in however often the session is renewed.
const saved = { ...process.env };

beforeEach(() => {
  process.env.ENTRA_METADATA_URL = 'https://login.example/.well-known';
  process.env.ENTRA_CLIENT_ID = 'client';
  process.env.ENTRA_CLIENT_SECRET = 'secret';
  process.env.ENTRA_REDIRECT_URI = 'https://app.example/auth/callback';
  // Made up per run: a literal here reads to the secrets scan as a leak.
  process.env.AUTH_SESSION_SECRET = randomBytes(32).toString('hex');
});

afterEach(() => {
  process.env = { ...saved };
  vi.useRealTimers();
});

const user = {
  id: 'entra-subject',
  email: 'officer@example.org',
  name: 'Officer',
  roles: [],
};

describe('the staff session cookie', () => {
  it('names its sign-in and when it was last used', async () => {
    const { createSessionCookie, readSession } = await import('./session');
    const cookie = await createSessionCookie(user);
    const session = await readSession(cookie.value);

    expect(session?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs(session!.lastSeen! - now)).toBeLessThanOrEqual(1);
    expect(session!.signedInAt).toBe(session!.lastSeen);
    expect(cookie.options.maxAge).toBe(8 * 60 * 60);
  });

  it('keeps its id and sign-in time when renewed, and ends 8 hours after the sign-in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T08:00:00Z'));
    const { createSessionCookie, readSession } = await import('./session');
    const first = await readSession((await createSessionCookie(user)).value);

    vi.setSystemTime(new Date('2026-09-24T14:00:00Z'));
    const renewedCookie = await createSessionCookie(user, {
      sessionId: first!.sessionId!,
      signedInAt: first!.signedInAt!,
    });
    const renewed = await readSession(renewedCookie.value);

    expect(renewed?.sessionId).toBe(first?.sessionId);
    expect(renewed?.signedInAt).toBe(first?.signedInAt);
    expect(renewed!.lastSeen! - first!.lastSeen!).toBe(6 * 60 * 60);
    // Six hours in, two are left of the eight.
    expect(renewedCookie.options.maxAge).toBe(2 * 60 * 60);
  });

  it('reads a token minted without them as active since it was issued', async () => {
    const { SignJWT } = await import('jose');
    const { readSession } = await import('./session');
    const token = await new SignJWT({ email: user.email })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.AUTH_SESSION_SECRET));
    const session = await readSession(token);

    expect(session?.sessionId).toBeUndefined();
    expect(session?.lastSeen).toBe(session?.signedInAt);
  });
});
