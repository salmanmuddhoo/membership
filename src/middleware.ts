import { defineMiddleware, sequence } from 'astro:middleware';
import { createServerAuth } from '@lib/auth/server';
import { recordAuditQuietly } from '@lib/access/audit';
import { authorise } from '@lib/access/authorise';
import { isInvalidReference } from '@lib/db/pool';
import { resolvePrincipal, type Principal } from '@lib/access/principal';
import { apiError, correlationIdFrom } from '@lib/api/envelope';
import { pendingActionCount } from '@lib/applications/workflow';
import { pendingTransactionCount } from '@lib/ledger/review';
import { createSessionCookie, SESSION_COOKIE } from '@lib/auth/session';
import { ACTION_TIMED_OUT, recordSessionEvent } from '@lib/auth/session-audit';
import { sessionIdleMinutes } from '@lib/config/reference';

const LOGIN_PATH = '/login';
const HOME_PATH = '/dashboard';
const DENIED_PATH = '/denied';
const NOT_FOUND_PATH = '/404';
const API_PREFIX = '/api/';
// The member app's surface. No staff cookie is ever presented here: a public
// endpoint has no caller to resolve, and a member endpoint resolves its own
// bearer token in defineMemberEndpoint (lib/member/endpoint.ts). Running the
// staff checks would refuse every request as unauthenticated before the
// endpoint saw it.
const MEMBER_API_PREFIX = '/api/v1/member/';

// The same reasoning for the machine-caller surface (S-908, S-909): a public
// endpoint resolves its own API credential in defineIntegrationEndpoint, and
// running the staff checks would refuse every request as unauthenticated
// before the endpoint saw one. A staff cookie is never resolved here, so a
// signed-in officer's browser cannot reach these endpoints as themselves.
const PUBLIC_API_PREFIX = '/api/v1/public/';
const SHARED_RECEIPT_PREFIX = '/receipts/shared/';
const SHARED_STATEMENT_PREFIX = '/statements/shared/';

// An API caller is not a browser: redirecting it to a sign-in page produces a
// 302 to some HTML, which a client parsing JSON cannot make sense of. API
// routes therefore refuse with the standard envelope and the right status.
function isApi(pathname: string): boolean {
  return pathname.startsWith(API_PREFIX);
}

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
    pathname.startsWith('/auth/') ||
    // A member's receipt, opened from the signed link the Society sent
    // them (S-1602). The token in the path is the credential, checked by
    // the page; nothing there is reachable without it.
    pathname.startsWith(SHARED_RECEIPT_PREFIX) ||
    // A member's statement, the same way: the signed link it was sent with.
    pathname.startsWith(SHARED_STATEMENT_PREFIX)
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

// A page that looked a record up and did not find it returns a bare
// `new Response('Not found', { status: 404 })` (about three dozen pages do
// this — members, transactions, applications, and the rest of the pages
// that open on an id). That is HTTP-correct but has none of the app's
// chrome: no menu, no way back, plain text in the browser's default font.
// Recognised by content-type rather than by pathname, so it catches every
// one of those pages without listing them, and never mistakes an actual
// rendered page — which answers text/html — for one of them. A Response
// built from a string body carries `text/plain;charset=UTF-8` unless the
// page set its own Content-Type, and nothing here does.
function isPlainTextNotFound(response: Response): boolean {
  if (response.status !== 404) return false;
  const contentType = response.headers.get('content-type');
  return contentType === null || contentType.startsWith('text/plain');
}

// Central authentication and authorisation guard. Runs for every page request:
//
//   1. resolve the session cookie to an Entra principal
//   2. resolve that principal to an application user, with its permissions
//   3. decide whether that user may reach this route — denying by default
//
// Steps 2 and 3 are what make authorisation uniform: a page cannot forget to
// check, because the check happens before the page runs.
const guard = defineMiddleware(async (context, next) => {
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

  const api = isApi(pathname);
  const refuse = (code: 'unauthenticated' | 'forbidden', to: string) =>
    api
      ? apiError(code, correlationIdFrom(context.request.headers))
      : context.redirect(to);

  if (pathname === '/') {
    return context.redirect(user ? HOME_PATH : LOGIN_PATH);
  }

  if (user && pathname === LOGIN_PATH) {
    return context.redirect(HOME_PATH);
  }

  if (isPublic(pathname)) {
    return next();
  }

  if (
    pathname.startsWith(MEMBER_API_PREFIX) ||
    pathname.startsWith(PUBLIC_API_PREFIX)
  ) {
    return next();
  }

  if (!user) {
    return refuse('unauthenticated', LOGIN_PATH);
  }

  // Sign-out after inactivity (session.idle_minutes; 0 turns it off). A
  // session whose last request is older than that is over: recorded, its
  // cookie cleared, and the person sent to sign in again. The page's own
  // timer (DashboardLayout) usually gets there first; this is what holds
  // when the tab was closed, asleep or had its script stopped. Otherwise
  // each request renews the session's last-seen time — at most once a
  // minute, so a page's burst of requests does not reissue the cookie each.
  let idleMinutes = 15;
  try {
    idleMinutes = await sessionIdleMinutes();
  } catch (error) {
    console.error('[auth] could not read session.idle_minutes:', error);
  }
  const now = Math.floor(Date.now() / 1000);
  const lastSeen = user.lastSeen ?? now;
  if (idleMinutes > 0 && now - lastSeen > idleMinutes * 60) {
    await recordSessionEvent(
      user,
      ACTION_TIMED_OUT,
      clientAddress(context.request.headers)
    );
    context.cookies.delete(SESSION_COOKIE, { path: '/' });
    return refuse('unauthenticated', `${LOGIN_PATH}?reason=idle`);
  }
  if (now - lastSeen >= 60) {
    const renewed = await createSessionCookie(user, {
      sessionId: user.sessionId ?? crypto.randomUUID(),
      signedInAt: user.signedInAt ?? now,
    });
    context.cookies.set(renewed.name, renewed.value, renewed.options);
  }

  // The session is valid, but a valid session is not an account: the person
  // authenticated with Entra, and this system decides separately whether they
  // are known here and still active.
  let principal: Principal;
  try {
    const result = await resolvePrincipal(user);

    if (!result.ok) {
      const { rejection } = result;
      if (rejection.reason === 'session-ended') {
        context.cookies.delete(SESSION_COOKIE, { path: '/' });
        return refuse('unauthenticated', LOGIN_PATH);
      }
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
      return refuse('forbidden', DENIED_PATH);
    }

    principal = result.principal;
  } catch (error) {
    // The database is unreachable. Failing closed is the only safe option: we
    // cannot establish who this is or what they may do.
    console.error('[access] could not resolve principal:', error);
    return refuse('forbidden', DENIED_PATH);
  }

  context.locals.principal = principal;

  // API endpoints declare their own permission in their descriptor and enforce
  // it in defineEndpoint(), which also produces the correct envelope. Applying
  // the page route map to them as well would deny every endpoint here, since
  // none of them appear in it.
  if (api) {
    return next();
  }

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

  // The "Applications" badge in DashboardLayout is a count with queries of
  // its own. Started here, before the page runs, so it overlaps the page's
  // own reads instead of queueing behind them; the layout awaits it. Never
  // allowed to reject — a badge is not worth a failed page.
  if (principal.permissions.has('application.view')) {
    context.locals.pendingActions = pendingActionCount(principal).catch(
      error => {
        console.error('[access] could not count pending actions:', error);
        return 0;
      }
    );
  }
  if (principal.permissions.has('transaction.view')) {
    context.locals.pendingTransactions = pendingTransactionCount(
      principal
    ).catch(error => {
      console.error('[access] could not count pending transactions:', error);
      return 0;
    });
  }

  // An id in the URL that is not one at all (/members/abc) fails in the
  // database as a malformed reference: that page does not exist, so it is
  // answered as not found rather than as a database outage.
  let response: Response;
  try {
    response = await next();
  } catch (error) {
    if (!isInvalidReference(error)) throw error;
    response = new Response('Not found', { status: 404 });
  }

  // Swap a bare "Not found" for the app's own not-found page, still at 404,
  // so the officer keeps the sidebar and a way back instead of monospace
  // text with neither. `context.rewrite` re-enters this same middleware
  // with pathname set to /404 (declared in OPEN_TO_ALL_USERS, so it is never
  // itself denied) and renders that page with `context.locals.principal`
  // already set above, which is how its layout still shows who is signed
  // in. The `pathname !== NOT_FOUND_PATH` guard, and the fact that the
  // rendered page answers text/html rather than text/plain, are what stop
  // that re-entry from rewriting again.
  if (pathname !== NOT_FOUND_PATH && isPlainTextNotFound(response)) {
    const notFoundPage = await context.rewrite(NOT_FOUND_PATH);
    // Rendering a page through `rewrite` resets the response status to 200
    // before the page's own frontmatter can set it back to 404 — set
    // explicitly here so a future edit to src/pages/404.astro can never
    // silently turn this into a 200.
    return new Response(notFoundPage.body, {
      status: 404,
      statusText: notFoundPage.statusText,
      headers: notFoundPage.headers,
    });
  }

  return response;
});

// Response headers, on every response this app produces.
//
// They used to live in vercel.json, which meant they were Vercel's to apply
// and nobody else's — with Test on Vercel and production on Azure, that
// would have protected the test site and left the real one bare, silently.
// Set here instead: middleware runs on both hosts, and the list stays in
// code review rather than in a hosting console nobody diffs.
//
// Applied around the guard rather than inside it, so a redirect to /login
// and an API refusal carry them too — both are responses the guard returns
// without ever reaching a page.
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'self' https://*.sharepoint.com",
    "frame-ancestors 'self'",
    // No unsafe-eval: nothing the app ships evaluates strings as code
    // (security review: the built scripts contain no eval or new Function),
    // so allowing it only helped an injected script. 'unsafe-inline' stays
    // while the pages carry inline scripts.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://images.unsplash.com https://*.sharepoint.com",
    "connect-src 'self' https://*.sharepoint.com",
    "object-src 'none'",
    'upgrade-insecure-requests',
    'block-all-mixed-content',
  ].join('; '),
  'Permissions-Policy': 'interest-cohort=()',
  // Another site is told which site a link came from, never the page:
  // app paths carry member and transaction ids (security review).
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '1; mode=block',
  // An officer's pages are personal and change as they work. Never held by
  // a shared cache, and revalidated every time.
  'Cache-Control': 'public, max-age=0, must-revalidate',
  // An internal tool has nothing to offer a search engine.
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
};

const securityHeaders = defineMiddleware(async (context, next) => {
  const response = await next();

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }

  // Only over HTTPS. A browser ignores HSTS on a plain connection anyway,
  // and sending it from `astro dev` on localhost is the one way this could
  // do harm — pinning HTTPS for a host that has no certificate.
  if (context.url.protocol === 'https:') {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload'
    );
  }

  return response;
});

export const onRequest = sequence(securityHeaders, guard);
