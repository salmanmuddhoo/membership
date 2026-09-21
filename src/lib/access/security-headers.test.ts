import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The response headers this app sets, read out of the middleware source.
 *
 * Read as text rather than imported: middleware.ts imports `astro:middleware`,
 * which only resolves inside an Astro build. The point here is not to exercise
 * the wiring — that is verified against a running server — but to stop a
 * header quietly disappearing from the list, which is exactly the kind of
 * change that breaks nothing visible.
 *
 * They lived in vercel.json until Test and production stopped sharing a host.
 * A header set by the hosting platform is one the other platform does not
 * have, and nothing tells you: the app keeps working either way. In code they
 * apply wherever the app runs, and they are reviewable.
 */
const SOURCE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../middleware.ts'
);

const REQUIRED = [
  'Content-Security-Policy',
  'Permissions-Policy',
  'Referrer-Policy',
  'X-Content-Type-Options',
  'X-Frame-Options',
  'X-XSS-Protection',
  'Cache-Control',
  'X-Robots-Tag',
];

describe('the response headers every request carries', () => {
  it('still sets every one of them', async () => {
    const source = await readFile(SOURCE, 'utf8');
    for (const header of REQUIRED) {
      expect(source).toContain(`'${header}'`);
    }
  });

  it('keeps the directives that make the policy worth having', async () => {
    const source = await readFile(SOURCE, 'utf8');
    // Each of these has been relied on somewhere: default-src closes the
    // page, object-src kills plugins, frame-ancestors is the clickjacking
    // defence X-Frame-Options only half covers, and the SharePoint origins
    // are what lets a filed document render at all (docs/documents.md).
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      'https://*.sharepoint.com',
    ]) {
      expect(source).toContain(directive);
    }
  });

  it('sends HSTS only over HTTPS', async () => {
    const source = await readFile(SOURCE, 'utf8');
    // Sent unconditionally it would pin HTTPS for localhost, which has no
    // certificate — a development machine that then refuses to load.
    expect(source).toMatch(
      /protocol === 'https:'[\s\S]{0,200}Strict-Transport-Security/
    );
  });
});
