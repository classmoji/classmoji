import { defineConfig, devices } from '@playwright/test';

/**
 * Live-editing acceptance suite (two signed-in browser contexts against the
 * running dev stack). Opt-in: every test skips unless COLLAB_E2E=1, so it
 * never runs as part of an app's normal `playwright test`.
 *
 *   COLLAB_E2E=1 npx dotenv -e .env -- ./scripts/devport.sh run \
 *     npx playwright test -c tests/collab
 *
 * URLs come from the devport env (WEBAPP_URL / PAGES_URL / SLIDES_URL, set by
 * `devport.sh run`); see helpers.ts.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // The checkpoint test waits out the debounced Trigger.dev push.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices['Desktop Chrome'],
    // COLLAB_E2E_CHANNEL=chrome runs against the installed Google Chrome
    // instead of Playwright's downloaded Chromium.
    ...(process.env.COLLAB_E2E_CHANNEL ? { channel: process.env.COLLAB_E2E_CHANNEL } : {}),
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: './test-results',
});
