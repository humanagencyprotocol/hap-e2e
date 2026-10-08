import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1, // Sequential — shared server state
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    // A person's browser: Playwright's default announces automation
    // (navigator.webdriver), which the gateway refuses at sign-in and
    // approval since 0.19.5 (defense in depth, by design).
    launchOptions: { args: ['--disable-blink-features=AutomationControlled'] },
  },
});
