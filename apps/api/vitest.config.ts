import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One worker: the e2e suite provisions a real database per file and the
    // dev PostgreSQL is a single small instance.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
