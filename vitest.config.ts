import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Each file mutates process.env and the module registry, so they must not
    // share a worker.
    isolate: true,
    // The application keeps an idle connection for a minute
    // (docs/database.md), which suits an officer between clicks but not a
    // suite that builds a fresh pool per load(). Every load() calls
    // vi.resetModules() and re-imports src/lib/db/pool, so the pool it
    // replaces is abandoned rather than closed: nothing ends it, and its
    // connection sits idle until the timeout reaps it. Against a
    // 100-connection server those leftovers are what runs the budget out,
    // and the run that crosses the line fails in whichever test happens to
    // be next — typically nowhere near the change that pushed it over.
    //
    // DATABASE_POOL_MAX=1 caps what a live pool may hold at once. The
    // deployed default (3 per instance) assumes several warm serverless
    // instances sharing one database's budget; a test file's own pool is the
    // only thing touching this one, so it does not need that many. Slower
    // under concurrency — pg queues rather than opening a second connection
    // — never wrong.
    //
    // The cap alone leaves too little room, because the count that matters
    // is abandoned pools, not busy ones: measured over a full run, the suite
    // peaked at 71 connections of which 68 were idle and 3 were doing work.
    // Half a second is long enough that a live pool reuses its connection
    // across a test rather than reconnecting per query (reconnecting to a
    // local server costs a millisecond or two, and run time is unchanged at
    // ~17s), and short enough that an abandoned pool gives its connection
    // back almost at once: the same run peaks at 39.
    env: { DATABASE_IDLE_TIMEOUT_MS: '500', DATABASE_POOL_MAX: '1' },
  },
});
