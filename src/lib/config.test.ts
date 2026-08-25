import { afterEach, describe, expect, it, vi } from 'vitest';

// config.ts reads env at call time, so each test sets what it needs and the
// module is re-imported to clear any per-module caching.
async function loadConfig() {
  vi.resetModules();
  return import('./config');
}

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe('getDatabaseConfig', () => {
  it('fails with an actionable message when DATABASE_URL is absent', async () => {
    delete process.env.DATABASE_URL;
    const { getDatabaseConfig } = await loadConfig();

    // S-101: a missing variable must read as a configuration problem, not as
    // an obscure driver error.
    expect(() => getDatabaseConfig()).toThrowError(/DATABASE_URL is not set/);
  });

  it('defaults to a small pool and to verified TLS', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@example.invalid:5432/db';
    delete process.env.DATABASE_POOL_MAX;
    delete process.env.DATABASE_ALLOW_INSECURE;
    const { getDatabaseConfig } = await loadConfig();

    const config = getDatabaseConfig();
    expect(config.poolMax).toBe(3);
    expect(config.sslMode).toBe('verify');
  });

  it('rejects a non-numeric pool size rather than silently ignoring it', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@example.invalid:5432/db';
    process.env.DATABASE_POOL_MAX = 'lots';
    const { getDatabaseConfig } = await loadConfig();

    expect(() => getDatabaseConfig()).toThrowError(/positive integer/);
  });

  it('allows plaintext only when an environment asks for it explicitly', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5433/db';
    process.env.DATABASE_ALLOW_INSECURE = 'true';
    process.env.PUBLIC_APP_ENV = 'test';
    const { getDatabaseConfig } = await loadConfig();

    expect(getDatabaseConfig().sslMode).toBe('disable');
  });

  it('refuses to disable TLS verification in production', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@example.invalid:5432/db';
    process.env.DATABASE_ALLOW_INSECURE = 'true';
    process.env.PUBLIC_APP_ENV = 'production';
    const { getDatabaseConfig } = await loadConfig();

    expect(() => getDatabaseConfig()).toThrowError(/never be enabled/);
  });

  it('treats an unset PUBLIC_APP_ENV as production, not as permission', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@example.invalid:5432/db';
    process.env.DATABASE_ALLOW_INSECURE = 'true';
    delete process.env.PUBLIC_APP_ENV;
    const { getDatabaseConfig } = await loadConfig();

    expect(() => getDatabaseConfig()).toThrowError(/never be enabled/);
  });
});

describe('normaliseSslMode', () => {
  // node-postgres gives the connection string's sslmode precedence over the
  // explicit `ssl` option, so the URL — not the code's intent — decides whether
  // traffic is encrypted. These tests pin the code as the authority.
  it('upgrades a verifying mode to the explicit verify-full', async () => {
    const { normaliseSslMode } = await loadConfig();

    for (const mode of ['require', 'verify-ca', 'verify-full']) {
      const result = normaliseSslMode(
        `postgresql://u:p@h.example.com:5432/db?sslmode=${mode}`,
        false
      );
      expect(result).toContain('sslmode=verify-full');
    }
  });

  it('adds verify-full when the URL says nothing about TLS', async () => {
    const { normaliseSslMode } = await loadConfig();

    const result = normaliseSslMode(
      'postgresql://u:p@h.example.com:5432/db',
      false
    );
    expect(result).toContain('sslmode=verify-full');
  });

  it('refuses a mode that would not verify the certificate', async () => {
    const { normaliseSslMode } = await loadConfig();

    // The case that matters: with sslmode=disable in the URL, node-postgres
    // ignores ssl:{rejectUnauthorized:true} and connects in plaintext. A
    // deployed environment must never reach that state silently.
    for (const mode of ['disable', 'allow', 'prefer']) {
      expect(() =>
        normaliseSslMode(
          `postgresql://u:p@h.example.com:5432/db?sslmode=${mode}`,
          false
        )
      ).toThrowError(/does not verify the server certificate/);
    }
  });

  it('forces plaintext off the URL when local development asks for it', async () => {
    const { normaliseSslMode } = await loadConfig();

    // A local cluster has no TLS at all; an inherited sslmode would break it.
    const result = normaliseSslMode(
      'postgresql://u:p@127.0.0.1:5433/db?sslmode=require',
      true
    );
    expect(result).toContain('sslmode=disable');
  });

  it('preserves the rest of the connection string', async () => {
    const { normaliseSslMode } = await loadConfig();

    const result = normaliseSslMode(
      'postgresql://user:pass@h.example.com:5432/albarakah?application_name=ab',
      false
    );
    expect(result).toContain('user:pass@h.example.com:5432/albarakah');
    expect(result).toContain('application_name=ab');
  });

  it('refuses a key=value string that carries an unverifiable sslmode', async () => {
    const { normaliseSslMode } = await loadConfig();

    // Not a URL, so it cannot be rewritten safely — refuse rather than let an
    // unchecked sslmode through.
    expect(() =>
      normaliseSslMode('host=h.example.com sslmode=disable', false)
    ).toThrowError(/must be a postgresql:\/\/ URL/);
  });
});

describe('getDatabaseConfig TLS enforcement', () => {
  it('rejects a production DATABASE_URL that disables TLS', async () => {
    process.env.DATABASE_URL =
      'postgresql://u:p@h.example.com:5432/db?sslmode=disable';
    process.env.PUBLIC_APP_ENV = 'production';
    delete process.env.DATABASE_ALLOW_INSECURE;
    const { getDatabaseConfig } = await loadConfig();

    expect(() => getDatabaseConfig()).toThrowError(
      /does not verify the server certificate/
    );
  });

  it('hands back a connection string the driver cannot silently weaken', async () => {
    process.env.DATABASE_URL =
      'postgresql://u:p@h.example.com:5432/db?sslmode=require';
    process.env.PUBLIC_APP_ENV = 'test';
    delete process.env.DATABASE_ALLOW_INSECURE;
    const { getDatabaseConfig } = await loadConfig();

    const config = getDatabaseConfig();
    expect(config.connectionString).toContain('sslmode=verify-full');
    expect(config.sslMode).toBe('verify');
  });
});
