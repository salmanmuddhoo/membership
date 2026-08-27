// Refuse a change that edits a migration already applied somewhere (S-102).
//
// The runner records a checksum for every migration it applies and refuses to
// continue when a file no longer matches. That is the right behaviour — a
// silent divergence between a file and the database it supposedly describes is
// far worse — but it fails at deploy time, in a pipeline, after the change has
// been merged. Worse, it aborts before applying ANY migration, so every later
// one stops too and the database silently falls behind while the application
// moves on without it.
//
// This catches the same mistake in review, next to the diff that causes it.
//
//   pnpm verify:migrations              compares against origin/main
//   pnpm verify:migrations <base-ref>   compares against something else
import { execFileSync } from 'node:child_process';
import process from 'node:process';

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function main(): void {
  const base = process.argv[2] ?? 'origin/main';

  let mergeBase: string;
  try {
    mergeBase = git('merge-base', base, 'HEAD');
  } catch {
    // A shallow clone or a missing ref: report rather than pass silently,
    // because a check that quietly does nothing is worse than no check.
    console.error(
      `Cannot compare against ${base}: it is not in this checkout. ` +
        'Fetch it, or pass a ref that is.'
    );
    process.exit(1);
  }

  if (mergeBase === git('rev-parse', 'HEAD')) {
    console.log('No commits beyond the base; nothing to check.');
    return;
  }

  // --diff-filter excludes additions: a NEW migration is the whole point.
  const changed = git(
    'diff',
    '--name-status',
    '--diff-filter=MDR',
    `${mergeBase}..HEAD`,
    '--',
    'migrations/'
  );

  const offending = changed
    .split('\n')
    .filter(line => line.trim() !== '' && line.endsWith('.sql'))
    .map(line => {
      const [status, ...paths] = line.split('\t');
      return { status, path: paths[paths.length - 1] };
    });

  if (offending.length === 0) {
    console.log('No existing migration has been modified.');
    return;
  }

  const verb: Record<string, string> = {
    M: 'modified',
    D: 'deleted',
    R: 'renamed',
  };
  console.error(
    'Migrations are forward-only, and these already exist on the base branch:\n'
  );
  for (const { status, path } of offending) {
    console.error(`  ${verb[status[0]] ?? status}: ${path}`);
  }
  console.error(
    '\nAny environment that has already applied one of these records its old\n' +
      'checksum, so the runner will refuse it — and refuse every migration\n' +
      'after it, leaving that database behind the code with no other symptom.\n' +
      'Put the change in a NEW migration instead.'
  );
  process.exit(1);
}

main();
