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
