import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Each file mutates process.env and the module registry, so they must not
    // share a worker.
    isolate: true,
    // The application keeps an idle connection for a minute (docs/database.md),
    // which suits an officer between clicks but not a suite that builds a
    // fresh pool per load(): with the deployed default the suite peaked at 79
    // connections against a 100-connection server, and a run that crossed the
    // line failed in whichever test happened to be next. Ten seconds here
    // keeps idle connections from stacking up between tests.
    //
    // That alone stopped being enough once this suite grew past ~530 tests:
    // the peak is a burst DURING a run, not idle leftovers between them, and
    // idleTimeout does nothing for a burst. The deployed default pool (3 per
    // instance) assumes several warm serverless instances sharing one
    // database's connection budget; a test file's own pool is the only thing
    // touching this one, so it does not need that many at once.
    // DATABASE_POOL_MAX=1 forces every query in a test file through a single
    // connection — slower under concurrency (pg queues rather than opening a
    // second one), never wrong, and keeps this suite's own burst well under
    // what a 100-connection server has left after Postgres reserves its own.
    env: { DATABASE_IDLE_TIMEOUT_MS: '10000', DATABASE_POOL_MAX: '1' },
  },
});
