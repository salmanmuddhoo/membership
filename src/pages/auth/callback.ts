import type { APIRoute } from 'astro';
import { completeLogin } from '@lib/auth/providers/entra';
import { createSessionCookie } from '@lib/auth/session';

export const prerender = false;

// Handles the redirect back from Entra: validates state, exchanges the code,
// verifies the id_token, and issues our own session cookie.
export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  const savedState = cookies.get('ab_state')?.value;
  const verifier = cookies.get('ab_pkce')?.value;
  const nonce = cookies.get('ab_nonce')?.value;

  for (const name of ['ab_state', 'ab_pkce', 'ab_nonce']) {
    cookies.delete(name, { path: '/' });
  }

  if (
    !code ||
    !state ||
    !savedState ||
    state !== savedState ||
    !verifier ||
    !nonce
  ) {
    return redirect('/login?error=auth');
  }

  try {
    const user = await completeLogin(code, verifier, nonce);
    const session = await createSessionCookie(user);
    cookies.set(session.name, session.value, session.options);
    return redirect('/dashboard');
  } catch (error) {
    console.error('[auth] callback failed:', error);
    return redirect('/login?error=auth');
  }
};
