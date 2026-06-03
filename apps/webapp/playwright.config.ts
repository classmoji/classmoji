import { defineConfig, devices } from '@playwright/test';
import { getBaseUrl } from './tests/helpers/env.helpers';

/**
 * Playwright configuration for classmoji webapp E2E tests
 *
 * Base URL is read from .dev-context to adapt to any devport configuration.
 * Run `npm run dev` before running tests to ensure .dev-context exists.
 *
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests',
  // Webapp E2E specs share one database and a small pool of role identities.
  // Run them serially to prevent one spec's cleanup from deleting another spec's
  // seeded rows or notifications.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,

  reporter: [
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['list'],
    ...(process.env.CI ? [['github'] as const] : []),
  ],

  use: {
    baseURL: getBaseUrl(),
    trace: 'on',
    screenshot: 'on',
    video: 'retain-on-failure',
    // Default timeout for actions
    actionTimeout: 10000,
    // Default timeout for navigation
    navigationTimeout: 30000,
  },

  // Global timeout for each test
  timeout: 60000,

  // Expect timeout
  expect: {
    timeout: 10000,
  },

  projects: [
    // Auth setup project - runs first to create auth states
    {
      name: 'auth-setup',
      testMatch: /auth\.setup\.ts/,
    },

    // Owner/Admin tests
    {
      name: 'owner-tests',
      testDir: './tests/owner',
      dependencies: ['auth-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: './tests/.auth/owner.json',
      },
    },

    // Assistant tests
    {
      name: 'assistant-tests',
      testDir: './tests/assistant',
      dependencies: ['auth-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: './tests/.auth/assistant.json',
      },
    },

    // Student tests
    {
      name: 'student-tests',
      testDir: './tests/student',
      dependencies: ['auth-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: './tests/.auth/student.json',
      },
    },

    // Smoke tests - run with owner auth by default
    {
      name: 'smoke-tests',
      testDir: './tests/smoke',
      dependencies: ['auth-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: './tests/.auth/owner.json',
      },
    },

    // Auth flow tests - manage their own context; logged-in cases call /test-login
    {
      name: 'auth-tests',
      testDir: './tests/auth',
      dependencies: ['auth-setup'],
      use: {
        ...devices['Desktop Chrome'],
      },
    },

    // Access control tests - specs set storageState per describe; unauth uses clean context
    {
      name: 'access-control-tests',
      testDir: './tests/access-control',
      dependencies: ['auth-setup'],
      use: {
        ...devices['Desktop Chrome'],
      },
    },

    // Regression tests - owner auth by default; specs override per-test for other roles
    {
      name: 'regression-tests',
      testDir: './tests/regression',
      dependencies: ['auth-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: './tests/.auth/owner.json',
      },
    },

    // Mobile tests (optional)
    {
      name: 'mobile-tests',
      testDir: './tests/mobile',
      dependencies: ['auth-setup'],
      use: {
        ...devices['Pixel 5'],
        storageState: './tests/.auth/student.json',
      },
    },
  ],

  // Output directory for test artifacts
  outputDir: './test-results',

  // Note: We don't use webServer here because npm run dev should already be running
  // If you want auto-start, uncomment below:
  // webServer: {
  //   command: 'npm run web:dev',
  //   url: getBaseUrl(),
  //   reuseExistingServer: !process.env.CI,
  //   timeout: 120000,
  // },
});
