// CLI entry point for the migration runner (S-102).
//
// Reads DATABASE_URL from the environment. Migrations connect as a role with
// DDL rights — that is NOT the role the application uses at runtime, so this
// deliberately reads DATABASE_MIGRATION_URL first and only falls back to
// DATABASE_URL for local development.
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { normaliseSslMode } from '../src/lib/config';
import { migrate, status } from './migrate';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, '..', 'migrations');

function connectionString(): string {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'DATABASE_MIGRATION_URL (or DATABASE_URL) must be set to run migrations.'
    );
    process.exit(1);
  }
  return url;
}

// Mirrors the rule in src/lib/config.ts: plaintext is local-only and must be
// asked for, never inferred.
function allowInsecure(): boolean {
  const allowed = process.env.DATABASE_ALLOW_INSECURE === 'true';
  const appEnv = process.env.PUBLIC_APP_ENV;
  const isProduction = appEnv === undefined || appEnv === 'production';

  if (allowed && isProduction) {
    console.error(
      'DATABASE_ALLOW_INSECURE must never be enabled outside local development.'
    );
    process.exit(1);
  }

  return allowed;
}

// node-postgres lets the connection string's sslmode override the explicit ssl
// option, so the URL is normalised first and the ssl option is then set to
// agree with it. See normaliseSslMode in src/lib/config.ts.
function sslOption(insecure: boolean) {
  return insecure ? false : { rejectUnauthorized: true };
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const insecure = allowInsecure();
  const url = normaliseSslMode(connectionString(), insecure);
  const ssl = sslOption(insecure);

  if (command === 'status') {
    const rows = await status(url, MIGRATIONS_DIR, { ssl });
    if (rows.length === 0) {
      console.log('No migrations found.');
      return;
    }
    for (const row of rows) {
      console.log(`${row.applied ? 'applied' : 'pending'}  ${row.name}`);
    }
    const pending = rows.filter(r => !r.applied).length;
    console.log(`\n${rows.length} migration(s), ${pending} pending.`);
    return;
  }

  if (command !== 'up') {
    console.error(`Unknown command: ${command}. Use "up" or "status".`);
    process.exit(1);
  }

  const result = await migrate(url, MIGRATIONS_DIR, {
    ssl,
    log: msg => console.log(msg),
  });

  if (result.applied.length === 0) {
    console.log(
      `Nothing to apply; ${result.skipped.length} migration(s) already applied.`
    );
    return;
  }

  console.log(
    `Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`
  );
}

main().catch(err => {
  // Loud failure: the pipeline step must go red, and the operator needs the
  // real reason, not a summary.
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
