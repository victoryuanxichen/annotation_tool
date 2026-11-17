import { defineConfig } from '@playwright/test';

// E2E tests drive the installed Google Chrome (H.264 + WebCodecs + File System Access API).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list'], ['json', { outputFile: 'tests/artifacts/e2e-results.json' }]],
  outputDir: 'tests/artifacts/playwright',
  use: {
    channel: 'chrome',
    headless: process.env.HEADED ? false : true,
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
