// Playwright configuration for the v1 e2e (P-5-07).
//
// Single project (chromium), single spec, no globalSetup/teardown.
// The spec spawns its own daemon via e2e/harness.ts so the binary path
// and stub-opencode wiring stay co-located with the test.

import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  // The happy-path spec walks through agent / workflow / launch / detail; the
  // task itself usually finishes in <5s with the stub, but xyflow loading and
  // i18n bootstrapping eat ~3-5s on cold start. 90s gives plenty of headroom
  // for CI runners.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    video: process.env.CI ? 'retain-on-failure' : 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
