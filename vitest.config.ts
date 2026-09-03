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
    // keeps the peak where the docs measured it (about 42).
    env: { DATABASE_IDLE_TIMEOUT_MS: '10000' },
  },
});
