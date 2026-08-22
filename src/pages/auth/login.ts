import type { APIRoute } from 'astro';
import { buildAuthRequest } from '@lib/auth/providers/entra';

export const prerender = false;

const TEMP_COOKIE = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 600,
} as const;

// Starts the Entra sign-in: builds the OIDC redirect and stashes the PKCE
// verifier, state and nonce in short-lived cookies for the callback to check.
export const GET: APIRoute = async ({ cookies, redirect }) => {
  try {
    const { url, verifier, state, nonce } = await buildAuthRequest();
    cookies.set('ab_pkce', verifier, TEMP_COOKIE);
    cookies.set('ab_state', state, TEMP_COOKIE);
    cookies.set('ab_nonce', nonce, TEMP_COOKIE);
    return redirect(url, 302);
  } catch (error) {
    console.error('[auth] login start failed:', error);
    return redirect('/login?error=config');
  }
};
