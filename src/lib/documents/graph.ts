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

/**
 * A failure that came from SharePoint, or from not being able to reach it.
 *
 * Typed because these are not defects and must not be reported as one. An
 * operator who has not finished the Microsoft 365 setup, a secret that has
 * expired, a drive the application was never granted — each of those is a
 * configuration problem with an obvious owner, and an officer who is told only
 * "something went wrong" has no way to know that, nor to say anything useful
 * when they report it.
 */
export class GraphError extends Error {
  constructor(
    message: string,
    readonly reason: 'not_configured' | 'auth_failed' | 'request_failed',
    // The HTTP status Graph gave, when there was one.
    readonly status?: number
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

// What a caller may show the person on screen. Deliberately not the underlying
// detail: an AADSTS code or a Graph error body is for the log, where it is
// already recorded against the correlation id.
export function graphFailureMessage(error: GraphError): string {
  if (error.reason === 'not_configured') {
    return (
      'SharePoint is not configured for this environment, so documents ' +
      'cannot be filed yet. An administrator needs to set the GRAPH_* ' +
      'settings — see docs/documents.md.'
    );
  }
  if (error.reason === 'auth_failed') {
    return (
      'This application could not sign in to SharePoint. Its credentials are ' +
      'wrong or have expired, and an administrator needs to renew them.'
    );
  }
  return (
    'SharePoint refused the request' +
    (error.status ? ` (${error.status})` : '') +
    '. This is a problem with the document library rather than with what you ' +
    'were filing.'
  );
}

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
    throw new GraphError(
      'SharePoint is not configured. Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, ' +
        'GRAPH_CLIENT_SECRET and GRAPH_DRIVE_ID (see docs/documents.md).',
      'not_configured'
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
    throw new GraphError(
      `Graph token request failed (${response.status}): ${detail}`,
      'auth_failed',
      response.status
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

export interface GraphItem {
  id: string;
  name: string;
  size: number;
  webUrl: string;
  // A short-lived, pre-authenticated URL good for one anonymous GET (typically
  // ~1 hour). This is what makes a document viewable by an officer at all:
  // they have no SharePoint account (see the note on identity above), so
  // webUrl — which needs one — is not usable, but this needs no further
  // authentication. Absent only if Graph did not return one, which
  // getDocumentViewUrl treats as a refusal rather than guessing a URL.
  downloadUrl?: string;
}

/**
 * Confirm a file is actually in the drive, and describe it.
 *
 * This is what turns "the browser said it finished" into a fact. S-408 turns
 * on never trusting the client's word for a completed upload: the bytes go
 * from the device to Microsoft without passing through us, so the only honest
 * confirmation is asking Microsoft.
 */
export async function getItemByPath(
  itemPath: string,
  config: GraphConfig = getGraphConfig()
): Promise<GraphItem | null> {
  const token = await getAccessToken(config);
  const response = await fetch(
    `${config.graphBaseUrl}/drives/${config.driveId}/root:/${encodeURI(itemPath)}`,
    { headers: { authorization: `Bearer ${token}` } }
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new GraphError(
      `Graph item lookup failed (${response.status}): ${detail}`,
      'request_failed',
      response.status
    );
  }

  const item = (await response.json()) as Partial<GraphItem> & {
    file?: unknown;
    '@microsoft.graph.downloadUrl'?: string;
  };
  if (!item.id) return null;

  // A folder at that path is not the document. Recording it as one would make
  // the checklist claim a file exists that nobody can open.
  if (!item.file) return null;

  return {
    id: item.id,
    name: item.name ?? '',
    size: item.size ?? 0,
    webUrl: item.webUrl ?? '',
    downloadUrl: item['@microsoft.graph.downloadUrl'],
  };
}

/**
 * Create one folder, tolerating one that is already there (S-405).
 *
 * Graph has no "create if absent", so a conflictBehavior of `replace` would
 * destroy an existing folder's contents and `fail` would error on the second
 * call. `rename` would silently make "Member Documents 1". So the 409 is
 * caught explicitly and treated as success, which is the only behaviour that
 * makes creation idempotent — and a retry must not produce a second folder.
 */
export async function ensureFolder(
  parentPath: string,
  name: string,
  config: GraphConfig = getGraphConfig()
): Promise<void> {
  const token = await getAccessToken(config);
  const parent = parentPath === '' ? 'root' : `root:/${encodeURI(parentPath)}:`;

  const response = await fetch(
    `${config.graphBaseUrl}/drives/${config.driveId}/${parent}/children`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      }),
    }
  );

  if (response.ok) return;
  if (response.status === 409) return; // Already there, which is what we wanted.

  const detail = await response.text().catch(() => '');
  throw new GraphError(
    `Graph folder creation failed for ${parentPath}/${name} ` +
      `(${response.status}): ${detail}`,
    'request_failed',
    response.status
  );
}

/**
 * Remove a file from the drive.
 *
 * Used when a draft application is abandoned: the rows cascade away, and
 * leaving the scans behind would keep an applicant's identity documents in
 * SharePoint with nothing in this system explaining why they are there.
 *
 * A 404 is success — the file is gone, which is what was asked for, and a
 * retry after a partial failure must not be an error.
 */
export async function deleteItemByPath(
  itemPath: string,
  config: GraphConfig = getGraphConfig()
): Promise<void> {
  const token = await getAccessToken(config);
  const response = await fetch(
    `${config.graphBaseUrl}/drives/${config.driveId}/root:/${encodeURI(itemPath)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }
  );

  if (response.ok || response.status === 404) return;

  const detail = await response.text().catch(() => '');
  throw new GraphError(
    `Graph delete failed for ${itemPath} (${response.status}): ${detail}`,
    'request_failed',
    response.status
  );
}
