import { defineConfig } from '@playwright/test';

/**
 * One browser, one worker, against the REAL stack: next start in front,
 * the NestJS API behind it, PostgreSQL under both. The servers are started
 * by the harness below so `pnpm test:e2e` is self-contained.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3000',
    launchOptions: { executablePath: process.env['PW_CHROMIUM'] ?? '/opt/pw-browsers/chromium' },
    // The journey clicks fast. Entrance animations are decoration, and a test
    // that waits for decoration is a test that flakes — every emil-* class
    // already honours this preference, so the suite exercises that path too.
    contextOptions: { reducedMotion: 'reduce' },
  },
  webServer: [
    {
      command:
        'cd ../api && DATABASE_URL=postgres://emil_app_login@127.0.0.1:55432/emil_web_e2e JWT_SECRET=any-32-character-string-for-local-dev PORT=3001 pnpm start',
      url: 'http://127.0.0.1:3001/openapi.json',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm start',
      url: 'http://127.0.0.1:3000/login',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
