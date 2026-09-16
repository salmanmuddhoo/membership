// Credentials for machine callers (S-909), against a real database.
//
// What matters here is what a copy of this table is worth to someone who
// takes it, and what a revoked credential can still do. Neither survives
// being mocked: the first is a question about what is actually stored, the
// second about what the next query returns.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../../scripts/migrate';

const ADMIN_URL = 'postgresql://postgres@127.0.0.1:5433/postgres';
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations'
);

const dbName = `credentials_test_${Date.now()}`;
const ownerUrl = `postgresql://postgres@127.0.0.1:5433/${dbName}`;
const appUrl = `postgresql://albarakah_app:devpassword@127.0.0.1:5433/${dbName}`;

async function run(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

process.env.DATABASE_URL = appUrl;
process.env.DATABASE_ALLOW_INSECURE = 'true';
process.env.PUBLIC_APP_ENV = 'test';

const credentials = await import('./credentials');
const pool = await import('../db/pool');

let actor: { userId: string; email: string };

beforeAll(async () => {
  await run(ADMIN_URL, `create database ${dbName}`);
  await run(ownerUrl, 'revoke all on schema public from public');
  await run(ownerUrl, `grant connect on database ${dbName} to albarakah_app`);
  await migrate(ownerUrl, MIGRATIONS_DIR);

  const user = await run(
    appUrl,
    `insert into app_user (entra_subject, email, display_name)
     values ('test-admin', 'admin@test', 'Admin') returning id`
  );
  actor = { userId: user.rows[0].id, email: 'admin@test' };
});

afterAll(async () => {
  await pool.closePool();
  await run(ADMIN_URL, `drop database if exists ${dbName} with (force)`);
});

beforeEach(async () => {
  await run(appUrl, 'delete from api_credential');
});

const ISSUE = {
  name: 'Albarakah.mu website',
  scopes: [credentials.SCOPE_APPLICATIONS_SUBMIT],
};

describe('issuing', () => {
  it('returns a token that works', async () => {
    const { token } = await credentials.issueCredential(ISSUE, actor);

    const resolved = await credentials.credentialForToken(token);
    expect(resolved?.name).toBe('Albarakah.mu website');
    expect(resolved?.scopes).toEqual(['applications.submit']);
  });

  // The whole point of storing a hash. If the secret were recoverable from
  // the table, a copy of the database would be a set of working credentials.
  it('stores nothing that can be replayed', async () => {
    const { token } = await credentials.issueCredential(ISSUE, actor);
    const secret = token.split('.')[1];

    const stored = await run(appUrl, 'select * from api_credential');
    const row = JSON.stringify(stored.rows[0]);

    expect(secret.length).toBeGreaterThan(20);
    expect(row).not.toContain(secret);
    expect(row).not.toContain(token);
  });

  // A leaked token should be recognisable for what it is, so a secret
  // scanner can find one in a repository before anyone else does.
  it('marks the token as belonging to this system', async () => {
    const { token } = await credentials.issueCredential(ISSUE, actor);
    expect(token.startsWith('ab_')).toBe(true);
  });

  it('gives each credential its own secret', async () => {
    const one = await credentials.issueCredential(ISSUE, actor);
    const two = await credentials.issueCredential(ISSUE, actor);

    expect(one.token).not.toBe(two.token);
    expect(one.credential.clientId).not.toBe(two.credential.clientId);
  });

  it('refuses one that may do nothing', async () => {
    await expect(
      credentials.issueCredential({ name: 'Empty', scopes: [] }, actor)
    ).rejects.toBeInstanceOf(credentials.CredentialError);
  });

  // An unrecognised scope must not be stored: it would read on the screen as
  // a permission the credential holds, and no endpoint would ever honour it.
  it('refuses a scope it does not know', async () => {
    await expect(
      credentials.issueCredential(
        { name: 'Odd', scopes: ['members.delete'] },
        actor
      )
    ).rejects.toBeInstanceOf(credentials.CredentialError);
  });

  it('refuses one with no name', async () => {
    await expect(
      credentials.issueCredential({ ...ISSUE, name: '  ' }, actor)
    ).rejects.toBeInstanceOf(credentials.CredentialError);
  });

  // The secret is what the hash exists to keep out of the database; putting
  // it in the audit trail would put it straight back in.
  // Scoped to this credential's own id: the audit trail is append-only, so
  // rows from earlier tests are still there and a bare count would be a
  // count of the suite rather than of this act.
  it('audits the issue without recording the secret', async () => {
    const { credential, token } = await credentials.issueCredential(
      ISSUE,
      actor
    );

    const events = await run(
      appUrl,
      `select new_value::text as v from audit_event
        where action = 'api_credential.issued' and entity_id = $1`,
      [credential.id]
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].v).not.toContain(token.split('.')[1]);
    expect(events.rows[0].v).toContain('Albarakah.mu website');
  });
});

describe('presenting a token', () => {
  it('refuses a wrong secret against a real client id', async () => {
    const { credential } = await credentials.issueCredential(ISSUE, actor);

    expect(
      await credentials.credentialForToken(`${credential.clientId}.wrong`)
    ).toBeNull();
  });

  it('refuses a client id that does not exist', async () => {
    expect(await credentials.credentialForToken('ab_nobody.secret')).toBeNull();
  });

  // Every way of being wrong returns the same null, so a caller cannot learn
  // which client ids are real by comparing the answers.
  it.each([
    ['empty', ''],
    ['no separator', 'abcdef'],
    ['nothing before the dot', '.secret'],
    ['nothing after the dot', 'ab_client.'],
    ['only a dot', '.'],
  ])('refuses a malformed token (%s)', async (_label, token) => {
    expect(await credentials.credentialForToken(token)).toBeNull();
  });

  // A revoked credential has to stop on its NEXT call, not when some cache
  // expires — which is why nothing here is cached.
  it('refuses one that has been revoked', async () => {
    const { credential, token } = await credentials.issueCredential(
      ISSUE,
      actor
    );
    expect(await credentials.credentialForToken(token)).not.toBeNull();

    await credentials.revokeCredential(credential.id, actor);

    expect(await credentials.credentialForToken(token)).toBeNull();
  });

  it('refuses a second revoke rather than reporting one that did nothing', async () => {
    const { credential } = await credentials.issueCredential(ISSUE, actor);
    await credentials.revokeCredential(credential.id, actor);

    await expect(
      credentials.revokeCredential(credential.id, actor)
    ).rejects.toBeInstanceOf(credentials.CredentialError);
  });

  it('audits a revoke', async () => {
    const { credential } = await credentials.issueCredential(ISSUE, actor);
    await credentials.revokeCredential(credential.id, actor);

    const events = await run(
      appUrl,
      `select 1 from audit_event
        where action = 'api_credential.revoked' and entity_id = $1`,
      [credential.id]
    );
    expect(events.rowCount).toBe(1);
  });
});

describe('splitToken', () => {
  it('splits on the last separator', () => {
    expect(credentials.splitToken('ab_abc.sec.ret')).toEqual({
      clientId: 'ab_abc.sec',
      secret: 'ret',
    });
  });

  it('rejects what is not a token', () => {
    expect(credentials.splitToken('nodot')).toBeNull();
    expect(credentials.splitToken('.leading')).toBeNull();
    expect(credentials.splitToken('trailing.')).toBeNull();
  });
});

describe('listing', () => {
  it('shows revoked ones too, so a revoke is visible as having happened', async () => {
    const { credential } = await credentials.issueCredential(ISSUE, actor);
    await credentials.revokeCredential(credential.id, actor);

    const all = await credentials.listCredentials();
    expect(all).toHaveLength(1);
    expect(all[0].isActive).toBe(false);
    expect(all[0].revokedAt).not.toBeNull();
  });

  it('never returns a secret hash to a caller', async () => {
    await credentials.issueCredential(ISSUE, actor);
    const all = await credentials.listCredentials();
    expect(JSON.stringify(all)).not.toContain('secret');
  });
});
