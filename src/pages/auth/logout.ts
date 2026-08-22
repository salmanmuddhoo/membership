import type { APIRoute } from 'astro';
import { buildLogoutUrl } from '@lib/auth/providers/entra';
import { SESSION_COOKIE } from '@lib/auth/session';

export const prerender = false;

// Clears our session cookie and redirects to Entra's end-session endpoint,
// which returns the user to the post-logout URL (the login page).
export const GET: APIRoute = async ({ cookies, redirect }) => {
  cookies.delete(SESSION_COOKIE, { path: '/' });
  try {
    return redirect(await buildLogoutUrl());
  } catch (error) {
    console.error('[auth] logout redirect failed:', error);
    return redirect('/login');
  }
};
