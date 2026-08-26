// Assert that every page the source defines is reachable in the built output.
//
// Why this exists: the Vercel adapter emits a CLOSED ALLOW-LIST. Every valid
// path is enumerated in .vercel/output/config.json at build time, and the last
// entry is `^/.*$` with status 404 — so anything not on the list is refused
// before the application sees it. That list is frozen into the deployment.
//
// The failure mode this catches is nasty precisely because nothing looks
// broken: the source has the page, the tests pass, the build succeeds, and the
// deployed site answers 404. It cost us a long diagnosis once, on
// /admin/configuration; the point of this check is that the next one fails in
// CI, next to the build that caused it, rather than in someone's browser.
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES_DIR = path.join(ROOT, 'src', 'pages');
const OUTPUT_CONFIG = path.join(ROOT, '.vercel', 'output', 'config.json');

export interface VercelRoute {
  src?: string;
  dest?: string;
  status?: number;
  continue?: boolean;
  handle?: string;
}

// The path a page file serves. Mirrors Astro's file-based routing: an
// index file serves its directory, and the extension is dropped.
export function routeForPageFile(relativePath: string): string | null {
  const withoutExtension = relativePath.replace(/\.(astro|ts|js)$/, '');
  if (withoutExtension === relativePath) return null;

  const segments = withoutExtension.split(path.sep);
  const base = segments[segments.length - 1];

  // Astro ignores files and directories prefixed with an underscore.
  if (segments.some(s => s.startsWith('_'))) return null;

  if (base === 'index') segments.pop();
  const route = '/' + segments.join('/');
  return route === '/' ? '/' : route.replace(/\/$/, '');
}

/**
 * Decide what the built routing table would do with a path, following the same
 * order Vercel does: the first terminating entry whose pattern matches wins.
 * `continue: true` entries (header rules) and `handle` entries do not
 * terminate, so they are passed over.
 */
export function resolveRoute(
  routes: readonly VercelRoute[],
  pathname: string
): { matched: true; status: number } | { matched: false } {
  for (const route of routes) {
    if (route.handle !== undefined) continue;
    if (route.continue) continue;
    if (!route.src) continue;

    if (new RegExp(route.src).test(pathname)) {
      // The catch-all carries status 404: matching it means the path is NOT
      // served, however much it looks like a match.
      return route.status === 404
        ? { matched: false }
        : { matched: true, status: route.status ?? 200 };
    }
  }
  return { matched: false };
}

async function listPageFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(
        ...(await listPageFiles(path.join(dir, entry.name), relative))
      );
    } else {
      files.push(relative);
    }
  }
  return files;
}

async function main(): Promise<void> {
  let config: { routes?: VercelRoute[] };
  try {
    config = JSON.parse(readFileSync(OUTPUT_CONFIG, 'utf8'));
  } catch {
    console.error(
      `No build output at ${path.relative(ROOT, OUTPUT_CONFIG)}.\n` +
        'Run `pnpm build` first — this check reads what the build produced, ' +
        'not what the source says.'
    );
    process.exit(1);
    return;
  }

  const routes = config.routes ?? [];
  const files = await listPageFiles(PAGES_DIR);

  const missing: string[] = [];
  let checked = 0;

  for (const file of files) {
    const route = routeForPageFile(file);
    if (route === null) continue;

    // A dynamic segment has no single path to probe; the pattern is checked by
    // Astro's own routing, and getting one wrong shows up immediately in use.
    if (route.includes('[')) continue;

    checked += 1;
    if (!resolveRoute(routes, route).matched) {
      missing.push(`${route}  (src/pages/${file})`);
    }
  }

  if (missing.length > 0) {
    console.error(
      `${missing.length} page(s) exist in the source but would 404 in the ` +
        'deployed build:\n'
    );
    for (const entry of missing) console.error(`  ${entry}`);
    console.error(
      '\nThe built routing table is a closed allow-list. A page missing from ' +
        'it is unreachable no matter how the application is configured.'
    );
    process.exit(1);
  }

  console.log(
    `All ${checked} page route(s) are reachable in the build output.`
  );
}

// Only run when invoked directly, so the helpers above can be unit-tested.
if (
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]))
) {
  await main();
}
