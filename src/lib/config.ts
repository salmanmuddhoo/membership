// Central runtime configuration.
//
// The backend is chosen by PUBLIC_AUTH_PROVIDER so we can migrate from Supabase
// to Azure-native (Microsoft Entra External ID) without rewriting the app — see
// docs/adr/0001-azure-native-backend.md. Test/preview and production are
// separated purely by environment variables (scoped per environment in Vercel).

export type BackendProvider = 'supabase' | 'entra';

export function getBackendProvider(): BackendProvider {
  const value = (
    import.meta.env.PUBLIC_AUTH_PROVIDER ?? 'supabase'
  ).toLowerCase();

  if (value !== 'supabase' && value !== 'entra') {
    throw new Error(
      `Unknown PUBLIC_AUTH_PROVIDER "${value}". Expected "supabase" or "entra".`
    );
  }

  return value;
}

export function getSupabaseConfig(): { url: string; anonKey: string } {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Missing Supabase configuration. Set PUBLIC_SUPABASE_URL and ' +
        'PUBLIC_SUPABASE_ANON_KEY (see .env.example).'
    );
  }

  return { url, anonKey };
}

export interface EntraConfig {
  authority: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  scopes: string;
  sessionSecret: string;
}

// Microsoft Entra External ID (OIDC) configuration. Server-side only — none of
// these carry a PUBLIC_ prefix, so they are never exposed to the browser.
// Consumed by the Entra auth provider (added in a follow-up per the ADR).
export function getEntraConfig(): EntraConfig {
  const authority = import.meta.env.ENTRA_AUTHORITY;
  const tenantId = import.meta.env.ENTRA_TENANT_ID;
  const clientId = import.meta.env.ENTRA_CLIENT_ID;
  const clientSecret = import.meta.env.ENTRA_CLIENT_SECRET;
  const redirectUri = import.meta.env.ENTRA_REDIRECT_URI;
  const postLogoutRedirectUri =
    import.meta.env.ENTRA_POST_LOGOUT_REDIRECT_URI ?? '/login';
  const scopes =
    import.meta.env.ENTRA_SCOPES ?? 'openid profile email offline_access';
  const sessionSecret = import.meta.env.AUTH_SESSION_SECRET;

  if (
    !authority ||
    !tenantId ||
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !sessionSecret
  ) {
    throw new Error(
      'Missing Entra configuration. Set ENTRA_AUTHORITY, ENTRA_TENANT_ID, ' +
        'ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, ENTRA_REDIRECT_URI and ' +
        'AUTH_SESSION_SECRET (see .env.example).'
    );
  }

  return {
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
