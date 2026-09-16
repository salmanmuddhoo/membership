// Control figures for a restore drill (S-1002).
//
// The story's acceptance criterion is that a recovered system is "verified
// against known figures". This produces those figures, and checks a restore
// against them:
//
//   pnpm figures:capture > figures.json     against the live database
//   pnpm figures:verify figures.json        against the restored one
//
// Verify exits non-zero on any difference, so a drill produces a pass or a
// fail rather than somebody's impression that it looked about right.
//
// What it counts is chosen to fail LOUDLY on a partial restore. A count of
// members alone would pass a restore that lost every payment; the sums and the
// high-water marks are what catch a database recovered to the wrong point in
// time, which is the failure a drill is actually looking for.
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import pg from 'pg';
import { normaliseSslMode } from '../src/lib/config';

const { Client } = pg;

interface Figure {
  label: string;
  sql: string;
}

// Each is one row, one column named `value`, always a string so a count and a
// money total compare the same way and no float rounding enters the picture.
const FIGURES: Figure[] = [
  {
    label: 'migrations applied',
    sql: 'select count(*)::text as value from schema_migrations',
  },
  {
    label: 'latest migration',
    sql: "select coalesce(max(name), '-') as value from schema_migrations",
  },
  {
    label: 'staff accounts',
    sql: 'select count(*)::text as value from app_user',
  },
  { label: 'members', sql: 'select count(*)::text as value from member' },
  {
    label: 'members active',
    sql: "select count(*)::text as value from member where status = 'active'",
  },
  {
    label: 'highest member number',
    sql: "select coalesce(max(member_no), '-') as value from member",
  },
  {
    label: 'applications',
    sql: 'select count(*)::text as value from membership_application',
  },
  {
    label: 'applications approved',
    sql: `select count(*)::text as value from membership_application
           where status = 'approved'`,
  },
  {
    label: 'highest application reference',
    sql: "select coalesce(max(reference), '-') as value from membership_application",
  },
  { label: 'accounts', sql: 'select count(*)::text as value from account' },
  { label: 'documents', sql: 'select count(*)::text as value from document' },
  {
    label: 'payments',
    sql: 'select count(*)::text as value from payment',
  },
  {
    // The figure the Treasurer would notice. A restore that lost a day's
    // takings passes every count above and fails here.
    label: 'payments total (not voided)',
    sql: `select coalesce(sum(total_amount), 0)::text as value
            from payment where voided_at is null`,
  },
  {
    label: 'receipt numbers allocated',
    sql: 'select count(*)::text as value from receipt_number',
  },
  {
    // The sequence must not go backwards on a restore, or the next receipt
    // reuses a number already issued — which S-502 exists to prevent.
    label: 'highest receipt serial',
    sql: 'select coalesce(max(serial_no), 0)::text as value from receipt_number',
  },
  {
    label: 'financial events',
    sql: 'select count(*)::text as value from financial_event',
  },
  {
    label: 'highest financial event sequence',
    sql: 'select coalesce(max(sequence_no), 0)::text as value from financial_event',
  },
  {
    label: 'audit events',
    sql: 'select count(*)::text as value from audit_event',
  },
  {
    // How far the restore actually reaches in time. Compared as a string, so
    // any difference at all is reported rather than silently tolerated.
    label: 'latest audit event',
    sql: `select coalesce(max(occurred_at)::text, '-') as value
            from audit_event`,
  },
  {
    label: 'notifications',
    sql: 'select count(*)::text as value from notification',
  },
];

interface Capture {
  capturedAt: string;
  figures: Record<string, string>;
}

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL must be set.');
    process.exit(1);
  }
  const allowInsecure = process.env.DATABASE_ALLOW_INSECURE === 'true';
  return normaliseSslMode(url, allowInsecure);
}

async function readFigures(): Promise<Capture> {
  const allowInsecure = process.env.DATABASE_ALLOW_INSECURE === 'true';
  const client = new Client({
    connectionString: connectionString(),
    ssl: allowInsecure ? false : { rejectUnauthorized: true },
  });
  await client.connect();

  try {
    const figures: Record<string, string> = {};
    for (const figure of FIGURES) {
      const result = await client.query<{ value: string }>(figure.sql);
      figures[figure.label] = String(result.rows[0]?.value ?? '-');
    }
    return { capturedAt: new Date().toISOString(), figures };
  } finally {
    await client.end();
  }
}

async function capture(): Promise<void> {
  // To stdout, so it can be redirected to a file and kept with the drill
  // record. Everything else this script says goes to stderr.
  const result = await readFigures();
  console.error(`Captured ${FIGURES.length} figures.`);
  console.log(JSON.stringify(result, null, 2));
}

async function verify(file: string): Promise<void> {
  const expected = JSON.parse(await readFile(file, 'utf8')) as Capture;
  const started = Date.now();
  const actual = await readFigures();

  const differences: string[] = [];
  const width = Math.max(...FIGURES.map(f => f.label.length));

  for (const { label } of FIGURES) {
    const before = expected.figures[label];
    const after = actual.figures[label];

    if (before === undefined) {
      // A figure this build knows about that the capture predates. Reported
      // rather than ignored: a baseline taken by an older version is not a
      // baseline for this one.
      differences.push(`${label.padEnd(width)}  not in the baseline`);
      continue;
    }
    if (before !== after) {
      differences.push(`${label.padEnd(width)}  ${before} -> ${after}`);
    }
  }

  console.error(`Baseline captured ${expected.capturedAt}`);
  console.error(`Verified against the restore in ${Date.now() - started}ms\n`);

  if (differences.length === 0) {
    console.error(`All ${FIGURES.length} figures match. Restore verified.`);
    return;
  }

  console.error(`${differences.length} figure(s) differ:\n`);
  for (const line of differences) console.error(`  ${line}`);
  console.error(
    '\nA restore to a point in time BEFORE the baseline is expected to ' +
      'differ — record how far back it reaches. Anything else means the ' +
      'restore is not what it claims to be.'
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === 'capture') return capture();
  if (command === 'verify') {
    const file = process.argv[3];
    if (!file) {
      console.error('Usage: control-figures verify <baseline.json>');
      process.exit(2);
    }
    return verify(file);
  }

  console.error(
    'Usage:\n' +
      '  control-figures capture > baseline.json\n' +
      '  control-figures verify baseline.json'
  );
  process.exit(2);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
