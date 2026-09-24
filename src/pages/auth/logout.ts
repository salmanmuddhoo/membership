import type { APIRoute } from 'astro';
import { buildLogoutUrl } from '@lib/auth/providers/entra';
import { readSession, SESSION_COOKIE } from '@lib/auth/session';
import {
  ACTION_SIGNED_OUT,
  ACTION_TIMED_OUT,
  clientAddress,
  recordSessionEvent,
} from '@lib/auth/session-audit';

export const prerender = false;

// Clears our session cookie and redirects to Entra's end-session endpoint,
// which returns the user to the post-logout URL (the login page).
// ?reason=idle is the page's own idle timer signing the officer out
// (DashboardLayout): recorded as an idle sign-out, not a sign-out they chose.
export const GET: APIRoute = async ({ cookies, redirect, url, request }) => {
  const user = await readSession(cookies.get(SESSION_COOKIE)?.value);
  const idle = url.searchParams.get('reason') === 'idle';
  if (user) {
    await recordSessionEvent(
      user,
      idle ? ACTION_TIMED_OUT : ACTION_SIGNED_OUT,
      clientAddress(request.headers)
    );
  }
  cookies.delete(SESSION_COOKIE, { path: '/' });
  try {
    return redirect(await buildLogoutUrl());
  } catch (error) {
    console.error('[auth] logout redirect failed:', error);
    return redirect(idle ? '/login?reason=idle' : '/login');
  }
};
