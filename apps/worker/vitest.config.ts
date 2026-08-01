import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Same reasoning as apps/api: a real database per file, one at a time, and
    // never `singleFork` — which would share `process.env` between files.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 1, minForks: 1 } },
  },
});
