import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end tests for the parent dashboard.
 *
 * Kept separate from `pnpm test:e2e` (which is the Vitest API suite) because
 * Playwright needs browser binaries installed first:
 *
 *   pnpm exec playwright install --with-deps
 *   pnpm test:e2e:web
 *
 * Splitting them means the default test command never fails on a machine that
 * has not downloaded ~400 MB of browsers.
 */
export default defineConfig({
  testDir: './tests/e2e-web',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // The launch market is Android-dominant, so a mobile viewport is a default
    // target rather than an afterthought.
    { name: 'mobile-android', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'pnpm --filter @kids/web run start',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
