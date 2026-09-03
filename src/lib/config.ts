// Central runtime configuration for the Azure-native backend.
// See docs/adr/0001-azure-native-backend.md.
//
// Server-side secrets are read at RUNTIME. On Vercel, non-PUBLIC env vars are
// available via process.env at request time (not inlined at build); in local
// dev Astro loads .env into import.meta.env. We check both so it works in both
// places.
//
// import.meta.env only EXISTS under Vite — the Astro app and the test runner.
// The job runner and the CLI scripts run under plain Node, where it is
// undefined and indexing it throws. So it is probed rather than assumed; every
// caller outside the web app depends on that.
export function readEnv(key: string): string | undefined {
  const viteEnv = (
    import.meta as unknown as { env?: Record<string, string | undefined> }
  ).env;
  const viteVal = viteEnv?.[key];
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

// TLS modes that actually verify the server's certificate chain. node-postgres
// currently treats all three as verify-full; libpq does not, and pg v9 will
// adopt libpq's weaker semantics, so they are normalised rather than trusted.
const VERIFYING_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

// Make the application's TLS decision authoritative.
//
// node-postgres gives the connection string's sslmode precedence over the
// explicit `ssl` option: given `?sslmode=disable`, a client constructed with
// `ssl: { rejectUnauthorized: true }` still connects in PLAINTEXT, silently.
// A deployment could therefore run unencrypted while this code believed it was
// verifying. So the mode is rewritten here to match the environment's policy
// instead of being left to whoever wrote the URL.
//
// Rewriting only ever strengthens: a mode that already verifies becomes the
// explicit `verify-full` (which is what node-postgres does today, so behaviour
// is unchanged and survives the pg v9 change), and a mode that would weaken TLS
// in a deployed environment is refused rather than quietly upgraded — asking
// for plaintext in production is a misconfiguration someone must see.
export function normaliseSslMode(
  connectionString: string,
  allowInsecure: boolean
): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // libpq key=value form ("host=... sslmode=..."). We cannot rewrite it
    // safely, so refuse it rather than let an unchecked sslmode through.
    if (/sslmode/i.test(connectionString)) {
      throw new Error(
        'DATABASE_URL must be a postgresql:// URL when it specifies sslmode, ' +
          'so the TLS mode can be verified (see docs/database.md).'
      );
    }
    return connectionString;
  }

  const requested = url.searchParams.get('sslmode')?.toLowerCase();

  if (allowInsecure) {
    // Local plaintext development. An explicit sslmode is meaningless here and
    // would fail against a cluster with no TLS, so it is replaced outright.
    url.searchParams.set('sslmode', 'disable');
    return url.toString();
  }

  if (requested && !VERIFYING_SSL_MODES.has(requested)) {
    throw new Error(
      `DATABASE_URL requests sslmode=${requested}, which does not verify the ` +
        'server certificate. A deployed environment must use ' +
        'sslmode=verify-full. Refusing to connect.'
    );
  }

  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

// Whether this deployment is production, on the one signal the app is given
// for it (PUBLIC_APP_ENV: unset on a developer's machine, "test" on the
// staging deployment, "production" in front of real members). Unset reads as
// production — the safe default for every caller that gates something
// dangerous on this, from a plaintext database connection to a full data
// wipe, is to refuse rather than to assume a value was simply forgotten.
export function isProductionEnvironment(): boolean {
  const appEnv = readEnv('PUBLIC_APP_ENV');
  return appEnv === undefined || appEnv === 'production';
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

  if (allowInsecure && isProductionEnvironment()) {
    throw new Error(
      'DATABASE_ALLOW_INSECURE must never be enabled outside local ' +
        'development. Unset it, or set PUBLIC_APP_ENV to a non-production value.'
    );
  }

  return {
    connectionString: normaliseSslMode(connectionString, allowInsecure),
    poolMax: readIntEnv('DATABASE_POOL_MAX', 3),
    idleTimeoutMillis: readIntEnv('DATABASE_IDLE_TIMEOUT_MS', 60_000),
    connectionTimeoutMillis: readIntEnv('DATABASE_CONNECT_TIMEOUT_MS', 10_000),
    sslMode: allowInsecure ? 'disable' : 'verify',
  };
}
