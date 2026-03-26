import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1, // Sequential — shared server state
  use: {
    headless: true,
    screenshot: 'only-on-failure',
  },
});
