import { defineConfig } from '@playwright/test';

// Extension E2E: MV3 extensions require a persistent context launched with
// --load-extension, so tests run headed-in-a-headless-shell (new Chromium
// headless supports extensions). One worker — the extension has global state.
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  workers: 1,
  retries: 1,
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'retain-on-failure' }
});
