import { defineMiddleware } from 'astro:middleware';
import { createServerAuth } from '@lib/auth/server';
import { recordAuditQuietly } from '@lib/access/audit';
import { authorise } from '@lib/access/authorise';
import { resolvePrincipal, type Principal } from '@lib/access/principal';

const LOGIN_PATH = '/login';
const HOME_PATH = '/dashboard';
const DENIED_PATH = '/denied';

// Routes reachable without a session: the login page, the OIDC handshake
// endpoints (/auth/login, /auth/callback, /auth/logout), and the refusal page.
//
// /denied MUST be here. It is where every refusal redirects, so if it were
// itself subject to the checks below, a refused user would be redirected to it,
// refused again, and redirected again — an infinite loop instead of an
// explanation. It shows no data, only a message and a way to sign out.
function isPublic(pathname: string): boolean {
  return (
    pathname === LOGIN_PATH ||
    pathname === DENIED_PATH ||
    pathname.startsWith('/auth/')
  );
}

// The client's address, for the audit trail. Vercel sits behind a proxy, so
// the socket address is the proxy's; x-forwarded-for's first entry is the
// original client. It is attacker-supplied, so it is recorded as a claim about
// the request and never used to make a decision.
function clientAddress(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const first = forwarded.split(',')[0]?.trim();
  return first && first.length <= 45 ? first : null;
}

// Central authentication and authorisation guard. Runs for every page request:
//
//   1. resolve the session cookie to an Entra principal
//   2. resolve that principal to an application user, with its permissions
//   3. decide whether that user may reach this route — denying by default
//
// Steps 2 and 3 are what make authorisation uniform: a page cannot forget to
// check, because the check happens before the page runs.
export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  let user = null;
  try {
    user = await createServerAuth(context).getUser();
  } catch (error) {
    // A misconfiguration or transient error should not take the whole site
    // down with a 500 — treat the request as signed out and log it.
    console.error('[auth] Failed to resolve session:', error);
    user = null;
  }

  context.locals.user = user;
  context.locals.principal = null;

  if (pathname === '/') {
    return context.redirect(user ? HOME_PATH : LOGIN_PATH);
  }

  if (user && pathname === LOGIN_PATH) {
    return context.redirect(HOME_PATH);
  }

  if (isPublic(pathname)) {
    return next();
  }

  if (!user) {
    return context.redirect(LOGIN_PATH);
  }

  // The session is valid, but a valid session is not an account: the person
  // authenticated with Entra, and this system decides separately whether they
  // are known here and still active.
  let principal: Principal;
  try {
    const result = await resolvePrincipal(user);

    if (!result.ok) {
      const { rejection } = result;
      // A provisioning gap, not a broken session — worth seeing in the logs.
      console.warn(
        `[access] session rejected (${rejection.reason}) for subject ${user.id}`
      );
      await recordAuditQuietly({
        actorDescription: `entra:${user.id}`,
        action: 'access.session_rejected',
        entityType: 'session',
        entityId: user.id,
        newValue: { reason: rejection.reason, path: pathname },
        ipAddress: clientAddress(context.request.headers),
      });
      return context.redirect(DENIED_PATH);
    }

    principal = result.principal;
  } catch (error) {
    // The database is unreachable. Failing closed is the only safe option: we
    // cannot establish who this is or what they may do.
    console.error('[access] could not resolve principal:', error);
    return context.redirect(DENIED_PATH);
  }

  context.locals.principal = principal;

  const decision = authorise(principal, pathname);

  if (!decision.allowed) {
    console.warn(
      `[access] denied ${principal.email} -> ${pathname} (${decision.reason})`
    );
    await recordAuditQuietly({
      actorUserId: principal.userId,
      actorDescription: principal.email,
      action: 'access.denied',
      entityType: 'route',
      entityId: pathname,
      newValue: {
        reason: decision.reason,
        required: decision.required ?? null,
      },
      ipAddress: clientAddress(context.request.headers),
    });
    return context.redirect(DENIED_PATH);
  }

  return next();
});
