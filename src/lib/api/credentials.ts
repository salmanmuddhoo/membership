// Credentials for machine callers (S-909).
//
// The secret is generated here, shown to the administrator once, and stored
// only as a hash. There is no "show me the secret again": a credential that
// could be recovered from the database is one a copy of the database hands
// over, and re-issuing is cheap.
//
// A token is `<client_id>.<secret>`. The client id is the lookup half and is
// not secret — it names the caller, it does not authenticate them. Splitting
// on the last separator means the row is found with one indexed read before
// any comparison, rather than hashing the candidate against every credential.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { recordAudit } from '../access/audit';
import { query } from '../db/pool';

// What a credential may do. One today; a set rather than a boolean because
// the second integration will not want the first one's reach.
export const SCOPE_APPLICATIONS_SUBMIT = 'applications.submit';

export const ALL_SCOPES = [SCOPE_APPLICATIONS_SUBMIT] as const;

export interface ApiCredential {
  id: string;
  name: string;
  clientId: string;
  scopes: string[];
  rateLimitPerMinute: number;
  isActive: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

interface CredentialRow {
  id: string;
  name: string;
  client_id: string;
  scopes: string[];
  rate_limit_per_minute: number;
  is_active: boolean;
  last_used_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

function toCredential(row: CredentialRow): ApiCredential {
  return {
    id: row.id,
    name: row.name,
    clientId: row.client_id,
    scopes: row.scopes,
    rateLimitPerMinute: row.rate_limit_per_minute,
    isActive: row.is_active,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

function hash(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/**
 * Split a presented token into its two halves.
 *
 * On the LAST separator, not the first: the client id is generated here and
 * contains none, but being strict about which half is which costs nothing and
 * means a malformed token is refused rather than silently truncated.
 */
export function splitToken(
  token: string
): { clientId: string; secret: string } | null {
  const trimmed = token.trim();
  const at = trimmed.lastIndexOf('.');
  if (at <= 0 || at === trimmed.length - 1) return null;
  return {
    clientId: trimmed.slice(0, at),
    secret: trimmed.slice(at + 1),
  };
}

export interface IssuedCredential {
  credential: ApiCredential;
  // Shown once. Not stored, and not recoverable.
  token: string;
}

/**
 * Issue a credential, and return the only copy of its secret there will be.
 *
 * `ab_` prefixes the client id so a leaked token is recognisable for what it
 * is — a secret scanner that knows the prefix can find one in a repository
 * before anybody else does.
 */
export async function issueCredential(
  input: { name: string; scopes: string[]; rateLimitPerMinute?: number },
  actor: { userId: string; email: string }
): Promise<IssuedCredential> {
  const name = input.name.trim();
  if (name === '') {
    throw new CredentialError('Give the credential a name.');
  }

  const scopes = input.scopes.filter(s =>
    (ALL_SCOPES as readonly string[]).includes(s)
  );
  if (scopes.length === 0) {
    throw new CredentialError('Choose at least one thing it may do.');
  }

  const rateLimit = input.rateLimitPerMinute ?? 60;
  if (!Number.isInteger(rateLimit) || rateLimit <= 0) {
    throw new CredentialError('The request ceiling must be a whole number.');
  }

  const clientId = `ab_${randomBytes(9).toString('base64url')}`;
  const secret = randomBytes(32).toString('base64url');

  const result = await query<CredentialRow>(
    `insert into api_credential
       (name, client_id, secret_hash, scopes, rate_limit_per_minute, created_by)
     values ($1, $2, $3, $4, $5, $6)
     returning id, name, client_id, scopes, rate_limit_per_minute, is_active,
               last_used_at, created_at, revoked_at`,
    [
      name,
      clientId,
      hash(secret).toString('hex'),
      scopes,
      rateLimit,
      actor.userId,
    ]
  );

  const credential = toCredential(result.rows[0]);

  // The secret is never audited — only that one was issued, to whom, and for
  // what. Recording the token would put in the audit trail exactly the thing
  // the hash exists to keep out of the database.
  await recordAudit({
    actorUserId: actor.userId,
    actorDescription: actor.email,
    action: 'api_credential.issued',
    entityType: 'api_credential',
    entityId: credential.id,
    newValue: { name, clientId, scopes, rateLimitPerMinute: rateLimit },
  });

  return { credential, token: `${clientId}.${secret}` };
}

export async function revokeCredential(
  id: string,
  actor: { userId: string; email: string }
): Promise<void> {
  const result = await query<{ name: string }>(
    `update api_credential
        set is_active = false, revoked_at = now(), revoked_by = $2
      where id = $1 and is_active
      returning name`,
    [id, actor.userId]
  );

  // Already revoked, or never existed. Either way there is nothing to do and
  // nothing to report as done.
  if (result.rowCount === 0) {
    throw new CredentialError('That credential is not active.');
  }

  await recordAudit({
    actorUserId: actor.userId,
    actorDescription: actor.email,
    action: 'api_credential.revoked',
    entityType: 'api_credential',
    entityId: id,
    newValue: { name: result.rows[0].name },
  });
}

export async function listCredentials(): Promise<ApiCredential[]> {
  const result = await query<CredentialRow>(
    `select id, name, client_id, scopes, rate_limit_per_minute, is_active,
            last_used_at, created_at, revoked_at
       from api_credential
      order by is_active desc, created_at desc`
  );
  return result.rows.map(toCredential);
}

/**
 * The credential a presented token belongs to, or null.
 *
 * Null for every way of being wrong — no such client id, wrong secret,
 * revoked — and deliberately so. Telling a caller which of those it was would
 * let someone with a list of client ids learn which are real.
 *
 * Not cached. A revoked credential must stop working on its very next
 * request, which is the same bargain resolvePrincipal makes for a member of
 * staff whose access was withdrawn.
 */
export async function credentialForToken(
  token: string
): Promise<ApiCredential | null> {
  const parts = splitToken(token);
  if (!parts) return null;

  const result = await query<CredentialRow & { secret_hash: string }>(
    `select id, name, client_id, secret_hash, scopes, rate_limit_per_minute,
            is_active, last_used_at, created_at, revoked_at
       from api_credential
      where client_id = $1 and is_active`,
    [parts.clientId]
  );

  const row = result.rows[0];
  if (!row) return null;

  const presented = hash(parts.secret);
  const stored = Buffer.from(row.secret_hash, 'hex');
  // Length is checked first because timingSafeEqual throws on a mismatch,
  // and a throw would be an answer of its own.
  if (
    presented.length !== stored.length ||
    !timingSafeEqual(presented, stored)
  ) {
    return null;
  }

  return toCredential(row);
}

// Best-effort: an administrator wants to know a credential is still in use,
// and that is not worth failing a request over.
export async function noteCredentialUsed(id: string): Promise<void> {
  try {
    await query(
      'update api_credential set last_used_at = now() where id = $1',
      [id]
    );
  } catch (error) {
    console.warn('[credentials] could not record use:', error);
  }
}
