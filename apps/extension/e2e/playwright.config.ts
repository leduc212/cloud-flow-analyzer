import { defineConfig } from '@playwright/test';

// Browser tests for the built extension (run `pnpm build` first). Each test starts its own
// Chromium with the extension loaded, so they run one at a time.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
});
