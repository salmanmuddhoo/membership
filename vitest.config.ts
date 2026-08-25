import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Each file mutates process.env and the module registry, so they must not
    // share a worker.
    isolate: true,
  },
});
