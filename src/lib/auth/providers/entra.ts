import type { APIContext } from 'astro';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getEntraConfig } from '@lib/config';
import type { AuthUser, ServerAuth } from '../types';
import { readSession, SESSION_COOKIE } from '../session';

// --- OIDC discovery (cached per server instance) --------------------------
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint: string;
}

let discoveryCache: Discovery | null = null;
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

async function getDiscovery(): Promise<Discovery> {
  if (discoveryCache) return discoveryCache;
  const { authority, tenantId } = getEntraConfig();
  const base = authority.replace(/\/+$/, '');
  const url = `${base}/${tenantId}/v2.0/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Entra OIDC discovery failed (${res.status}).`);
  }
  discoveryCache = (await res.json()) as Discovery;
  return discoveryCache;
}

async function getJwks() {
  if (!jwksCache) {
    const { jwks_uri } = await getDiscovery();
    jwksCache = createRemoteJWKSet(new URL(jwks_uri));
  }
  return jwksCache;
}

// --- PKCE + random helpers -------------------------------------------------
function base64url(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return base64url(new Uint8Array(digest));
}

// --- Login: build the authorization redirect ------------------------------
export interface AuthRequest {
  url: string;
  verifier: string;
  state: string;
  nonce: string;
}

export async function buildAuthRequest(): Promise<AuthRequest> {
  const cfg = getEntraConfig();
  const { authorization_endpoint } = await getDiscovery();

  const verifier = randomString();
  const state = randomString(16);
  const nonce = randomString(16);
  const challenge = await pkceChallenge(verifier);

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: cfg.redirectUri,
    response_mode: 'query',
    scope: cfg.scopes,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return {
    url: `${authorization_endpoint}?${params.toString()}`,
    verifier,
    state,
    nonce,
  };
}

// --- Callback: exchange code and validate the id_token --------------------
export async function completeLogin(
  code: string,
  verifier: string,
  nonce: string
): Promise<AuthUser> {
  const cfg = getEntraConfig();
  const { token_endpoint, issuer } = await getDiscovery();

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
    scope: cfg.scopes,
  });

  const res = await fetch(token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Entra token exchange failed (${res.status}).`);
  }
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error('Entra response missing id_token.');

  const { payload } = await jwtVerify(tokens.id_token, await getJwks(), {
    issuer,
    audience: cfg.clientId,
  });

  if (payload.nonce !== nonce) {
    throw new Error('Entra id_token nonce mismatch.');
  }

  const roleClaim = payload.roles as string[] | undefined;
  return {
    id: (payload.sub as string) ?? (payload.oid as string) ?? '',
    email:
      (payload.email as string | undefined) ??
      (payload.preferred_username as string | undefined) ??
      null,
    name: (payload.name as string | undefined) ?? null,
    roles: roleClaim ?? [],
  };
}

// --- Logout: end-session redirect -----------------------------------------
export async function buildLogoutUrl(): Promise<string> {
  const cfg = getEntraConfig();
  const { end_session_endpoint } = await getDiscovery();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    post_logout_redirect_uri: cfg.postLogoutRedirectUri,
  });
  return `${end_session_endpoint}?${params.toString()}`;
}

// --- Server auth surface (used by middleware) -----------------------------
export function createEntraServerAuth(context: APIContext): ServerAuth {
  return {
    async getUser() {
      return readSession(context.cookies.get(SESSION_COOKIE)?.value);
    },
  };
}
