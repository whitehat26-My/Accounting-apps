import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Source-level checks only. Anything needing a browser or a live API is a
    // Playwright journey (`pnpm --filter @emil/web test:e2e`), not a unit test.
    include: ['test/**/*.test.ts'],
  },
});
