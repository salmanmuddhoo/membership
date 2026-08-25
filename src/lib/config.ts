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

export interface DatabaseConfig {
  connectionString: string;
  // Per-instance pool ceiling. Serverless scales by process, so the effective
  // connection count is this number times the number of warm instances — which
  // is why the default is deliberately tiny. See docs/database.md.
  poolMax: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  // 'verify' negotiates TLS and requires the server certificate to chain to a
  // trusted CA. 'disable' opens a plaintext connection and exists only for a
  // local development cluster, which has no TLS at all — note that these are
  // genuinely different things, and that an unverified TLS handshake is not
  // offered as an option.
  sslMode: 'verify' | 'disable';
}

function readIntEnv(key: string, fallback: number): number {
  const raw = readEnv(key);
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${key} must be a positive integer; received ${JSON.stringify(raw)}.`
    );
  }
  return parsed;
}

// PostgreSQL configuration. Throws with an actionable message when the
// database has not been configured, so a missing variable surfaces as a
// deployment problem rather than an obscure driver error (S-101).
export function getDatabaseConfig(): DatabaseConfig {
  const connectionString = readEnv('DATABASE_URL');

  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Provide the PostgreSQL connection string for ' +
        'this environment (see .env.example and docs/database.md).'
    );
  }

  // TLS is mandatory in a deployed environment. Local development against a
  // plaintext instance is the one exception, and it has to be asked for
  // explicitly rather than being inferred from the host name.
  const allowInsecure = readEnv('DATABASE_ALLOW_INSECURE') === 'true';
  const appEnv = readEnv('PUBLIC_APP_ENV');
  const isProduction = appEnv === undefined || appEnv === 'production';

  if (allowInsecure && isProduction) {
    throw new Error(
      'DATABASE_ALLOW_INSECURE must never be enabled outside local ' +
        'development. Unset it, or set PUBLIC_APP_ENV to a non-production value.'
    );
  }

  return {
    connectionString,
    poolMax: readIntEnv('DATABASE_POOL_MAX', 3),
    idleTimeoutMillis: readIntEnv('DATABASE_IDLE_TIMEOUT_MS', 10_000),
    connectionTimeoutMillis: readIntEnv('DATABASE_CONNECT_TIMEOUT_MS', 10_000),
    sslMode: allowInsecure ? 'disable' : 'verify',
  };
}
