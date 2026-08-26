// The route-coverage check (see scripts/verify-routes.ts).
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  resolveRoute,
  routeForPageFile,
  type VercelRoute,
} from './verify-routes';

const j = (...parts: string[]) => parts.join(path.sep);

describe('working out which route a page file serves', () => {
  it('maps a page to its path', () => {
    expect(routeForPageFile(j('admin', 'roles.astro'))).toBe('/admin/roles');
    expect(routeForPageFile(j('api', 'v1', 'health.ts'))).toBe(
      '/api/v1/health'
    );
  });

  it('maps an index file to its directory, not to /index', () => {
    // This is the shape that broke: /admin/configuration is served by
    // admin/configuration/index.astro.
    expect(routeForPageFile(j('admin', 'configuration', 'index.astro'))).toBe(
      '/admin/configuration'
    );
    expect(routeForPageFile('index.astro')).toBe('/');
  });

  it('ignores what Astro ignores', () => {
    expect(routeForPageFile(j('_shared', 'thing.astro'))).toBeNull();
    expect(routeForPageFile('_draft.astro')).toBeNull();
    expect(routeForPageFile('README.md')).toBeNull();
  });
});

describe('resolving a path against a built routing table', () => {
  // The real shape the Vercel adapter emits, trimmed.
  const routes: VercelRoute[] = [
    { handle: 'filesystem' },
    { src: '^/_astro/(.*)$', headers: {}, continue: true } as VercelRoute,
    { src: '^/admin/roles/?$', dest: '_render' },
    { src: '^/dashboard/?$', dest: '_render' },
    { src: '^/.*$', dest: '_render', status: 404 },
  ];

  it('serves a path that is on the list', () => {
    expect(resolveRoute(routes, '/admin/roles')).toEqual({
      matched: true,
      status: 200,
    });
  });

  it('refuses a path that is not, even though the catch-all matches it', () => {
    // The catch-all matches every path. Treating "a route matched" as success
    // would make this check pass for every input and assert nothing at all —
    // it is the status 404 on that entry that carries the meaning.
    expect(resolveRoute(routes, '/admin/configuration')).toEqual({
      matched: false,
    });
  });

  it('passes over entries that do not terminate', () => {
    // `handle` and `continue: true` entries match but do not decide; if they
    // were treated as terminating, /_astro/x.css would read as served and any
    // path could be masked by a header rule above it.
    expect(resolveRoute(routes, '/_astro/app.css')).toEqual({ matched: false });
  });

  it('reproduces the deployment that shipped 2.1 without 2.2', () => {
    // The exact situation on the test site: /admin/roles served,
    // /admin/configuration 404, from a route list built before the pages
    // existed. This is what the check must catch.
    const built = routes;
    const pages = [
      j('admin', 'roles.astro'),
      j('admin', 'configuration', 'index.astro'),
      j('admin', 'configuration', 'fees.astro'),
    ];

    const unreachable = pages
      .map(routeForPageFile)
      .filter((r): r is string => r !== null)
      .filter(r => !resolveRoute(built, r).matched);

    expect(unreachable).toEqual([
      '/admin/configuration',
      '/admin/configuration/fees',
    ]);
  });
});
