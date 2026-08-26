// Microsoft Graph access for the document repository (S-112, FRD 8.3).
//
// SharePoint is the official repository; this application is the metadata
// system of record. Every call to SharePoint goes through this layer — no page
// and no browser talks to Graph on its own.
//
// IMPORTANT: this is a DIFFERENT tenant from sign-in. Staff authenticate against
// an Entra External ID (CIAM) tenant created for this application; SharePoint
// lives in Al Barakah's Microsoft 365 organisational tenant. They are separate
// directories, so this needs its own app registration and its own credentials —
// hence GRAPH_* rather than reusing ENTRA_*.
//
// The application authenticates as ITSELF (client credentials), not as the
// signed-in officer. That is deliberate: officers do not need SharePoint
// licences or per-user permissions, and the application can enforce its own
// rules about who may file what. The cost is that SharePoint sees one identity,
// so WHO did what lives in our audit trail rather than SharePoint's.

import { readEnv } from '../config';

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  // The drive (document library) documents are filed in.
  driveId: string;
  // Override for tests and for sovereign clouds.
  graphBaseUrl: string;
  loginBaseUrl: string;
}

export function getGraphConfig(): GraphConfig {
  const tenantId = readEnv('GRAPH_TENANT_ID');
  const clientId = readEnv('GRAPH_CLIENT_ID');
  const clientSecret = readEnv('GRAPH_CLIENT_SECRET');
  const driveId = readEnv('GRAPH_DRIVE_ID');

  if (!tenantId || !clientId || !clientSecret || !driveId) {
    throw new Error(
      'SharePoint is not configured. Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, ' +
        'GRAPH_CLIENT_SECRET and GRAPH_DRIVE_ID (see docs/documents.md).'
    );
  }

  return {
    tenantId,
    clientId,
    clientSecret,
    driveId,
    graphBaseUrl:
      readEnv('GRAPH_BASE_URL') ?? 'https://graph.microsoft.com/v1.0',
    loginBaseUrl:
      readEnv('GRAPH_LOGIN_URL') ?? 'https://login.microsoftonline.com',
  };
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Cached per warm instance. Graph tokens last an hour; fetching one per request
// would add a round trip to every document operation for no benefit.
let cached: CachedToken | undefined;

// Refresh a little before expiry so a request that starts just under the wire
// does not finish with a dead token.
const EXPIRY_MARGIN_MS = 60_000;

export async function getAccessToken(
  config: GraphConfig = getGraphConfig()
): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + EXPIRY_MARGIN_MS) {
    return cached.token;
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    // App-only: the whole application's permissions, not a user's.
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const response = await fetch(
    `${config.loginBaseUrl}/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }
  );

  if (!response.ok) {
    // The body names the AADSTS code, which is the only way to tell a wrong
    // secret from a missing consent. It contains no member data.
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Graph token request failed (${response.status}): ${detail}`
    );
  }

  const json = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  cached = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };

  return cached.token;
}

// Tests and long-running jobs need to clear the cache; request handlers do not.
export function resetTokenCache(): void {
  cached = undefined;
}
