import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One file at a time, each in its OWN process.
    //
    // `maxForks: 1` keeps the concurrency at one, because the e2e suite
    // provisions a real database per file and the dev PostgreSQL is a single
    // small instance.
    //
    // What this must NOT be is `singleFork: true`, which reuses one process for
    // every file and therefore shares `process.env` between them. The harness
    // sets `DATABASE_URL` to the database it just created, so two files in one
    // process fight over it — and the file that loses connects to a database
    // the other one has already dropped. That failed as a suite-level
    // "database does not exist" with no test frame to point at, which is a
    // remarkably unhelpful way to be told the harness is not isolated.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 1, minForks: 1 } },
  },
});
