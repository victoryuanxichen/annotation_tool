import { defineConfig } from '@playwright/test';

// Throwaway visual-review run for the UI kit showcase (not part of the e2e suite):
//   npx playwright test -c tests/harness/playwright.kit.config.ts
// Screenshots go to KIT_SHOTS_DIR (default tests/artifacts/kit-shots).
export default defineConfig({
  testDir: '.',
  testMatch: 'kit.shots.ts',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  outputDir: '../artifacts/kit-playwright',
  use: { channel: 'chrome', headless: true, baseURL: 'http://127.0.0.1:5173' },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
    cwd: '../..',
  },
});
