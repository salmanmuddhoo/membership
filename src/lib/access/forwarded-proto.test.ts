import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Azure App Service terminates TLS and hands the Node server plain HTTP, so
 * Astro rebuilds each request URL as `http://…`. Its cross-origin check then
 * compares that against the browser's `https://…` Origin header, finds them
 * different, and refuses every form POST — sign-in included, which took
 * production down once already. Astro will honour `X-Forwarded-Proto` and
 * rebuild the URL as `https://…`, but only when `security.allowedDomains`
 * pins a real hostname; deleting that block, or widening it to admit any
 * host, breaks nothing any other test would catch and shows up only when
 * someone submits a form in production.
 */

const importConfig = async (siteUrl: string | undefined) => {
  vi.stubEnv('PUBLIC_SITE_URL', siteUrl ?? '');
  vi.resetModules();
  const mod = await import('../../../astro.config.mjs');
  return mod.default;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the pinned host that lets Astro trust X-Forwarded-Proto', () => {
  it('pins exactly the configured site as an https origin', async () => {
    const config = await importConfig('https://members.example.org');
    expect(config.security?.allowedDomains).toEqual([
      { hostname: 'members.example.org', protocol: 'https' },
    ]);
  });

  it('pins nothing when no site URL is configured', async () => {
    const config = await importConfig(undefined);
    expect(config.security?.allowedDomains).toEqual([]);
  });
});
