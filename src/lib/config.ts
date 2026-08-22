// Central runtime configuration for the Azure-native backend.
// See docs/adr/0001-azure-native-backend.md.
//
// Server-side secrets are read at RUNTIME. On Vercel, non-PUBLIC env vars are
// available via process.env at request time (not inlined at build); in local
// dev Astro loads .env into import.meta.env. We check both so it works in both
// places.
function readEnv(key: string): string | undefined {
  const viteVal = (import.meta.env as Record<string, string | undefined>)[key];
  if (viteVal !== undefined && viteVal !== '') return viteVal;
  const proc = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process;
  return proc?.env?.[key];
}

export interface EntraConfig {
  // Either provide the exact OIDC metadata URL (copied from the app
  // registration's "Endpoints" panel), or the authority + tenant id, from
  // which the metadata URL is derived.
  metadataUrl?: string;
  authority?: string;
  tenantId?: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  scopes: string;
  sessionSecret: string;
}

// Microsoft Entra External ID (OIDC) configuration. Throws with a clear message
// when the backend has not been configured yet, so callers can degrade
// gracefully instead of crashing.
export function getEntraConfig(): EntraConfig {
  const metadataUrl = readEnv('ENTRA_METADATA_URL');
  const authority = readEnv('ENTRA_AUTHORITY');
  const tenantId = readEnv('ENTRA_TENANT_ID');
  const clientId = readEnv('ENTRA_CLIENT_ID');
  const clientSecret = readEnv('ENTRA_CLIENT_SECRET');
  const redirectUri = readEnv('ENTRA_REDIRECT_URI');
  const postLogoutRedirectUri =
    readEnv('ENTRA_POST_LOGOUT_REDIRECT_URI') ?? '/login';
  const scopes =
    readEnv('ENTRA_SCOPES') ?? 'openid profile email offline_access';
  const sessionSecret = readEnv('AUTH_SESSION_SECRET');

  // The OIDC endpoints come from either an explicit metadata URL or the
  // authority + tenant id pair.
  const hasEndpointSource = Boolean(metadataUrl || (authority && tenantId));

  if (
    !hasEndpointSource ||
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !sessionSecret
  ) {
    throw new Error(
      'Entra is not configured. Set ENTRA_METADATA_URL (or ENTRA_AUTHORITY + ' +
        'ENTRA_TENANT_ID), plus ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, ' +
        'ENTRA_REDIRECT_URI and AUTH_SESSION_SECRET (see .env.example).'
    );
  }

  return {
    metadataUrl,
    authority,
    tenantId,
    clientId,
    clientSecret,
    redirectUri,
    postLogoutRedirectUri,
    scopes,
    sessionSecret,
  };
}
