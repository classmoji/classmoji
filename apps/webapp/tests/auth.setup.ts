import { test as setup, expect } from '@playwright/test';
import { TEST_USERS } from './helpers/auth.helpers';
import { TEST_CLASSROOM, TestRole } from './helpers/env.helpers';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ESM compatibility for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure .auth directory exists
const authDir = join(__dirname, '.auth');
if (!existsSync(authDir)) {
  mkdirSync(authDir, { recursive: true });
}

// Cache validity duration (1 hour)
const CACHE_VALIDITY_MS = 60 * 60 * 1000;

/**
 * Check if a storage state file is valid (exists, is recent, and has real auth)
 */
function isStorageStateValid(stateFile: string): boolean {
  if (!existsSync(stateFile)) {
    return false;
  }

  try {
    const stats = statSync(stateFile);
    const ageMs = Date.now() - stats.mtimeMs;

    // Check if file is recent enough
    if (ageMs >= CACHE_VALIDITY_MS) {
      return false;
    }

    // Check if file has valid content (not a failure marker)
    const content = require('fs').readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(content);

    // Reject if this is a failed auth marker
    if (parsed._authFailed) {
      return false;
    }

    // Valid storage state has cookies array with at least one cookie
    return Array.isArray(parsed.cookies) && parsed.cookies.length > 0;
  } catch {
    return false;
  }
}

// Run auth setup tests sequentially to avoid race conditions
setup.describe.configure({ mode: 'serial' });

/**
 * Map role names to test-login query param values
 */
const ROLE_TO_LOGIN_PARAM: Record<TestRole, string> = {
  owner: 'admin',
  assistant: 'ta',
  student: 'student',
};

/**
 * Auth setup - creates storage states for each role
 *
 * Uses /test-login?role=X route to bypass GitHub OAuth and authenticate
 * using role-specific tokens (GITHUB_PROF_TOKEN, GITHUB_TA_TOKEN, GITHUB_STUDENT_TOKEN).
 *
 * Each role logs in with a different GitHub user token, then selects their role
 * from the organization selection page.
 *
 * Storage states saved:
 * - owner.json: Admin/owner role
 * - assistant.json: Teaching assistant role
 * - student.json: Student role
 */

// Create storage states for each role
for (const [role, user] of Object.entries(TEST_USERS) as [TestRole, typeof TEST_USERS[TestRole]][]) {
  setup(`setup ${role} state`, async ({ page }) => {
    const stateFile = join(authDir, `${role}.json`);

    // Skip if storage state already exists and is recent (within last hour)
    if (isStorageStateValid(stateFile)) {
      console.log(`⏭️ Skipping ${role} setup - valid cached state exists`);
      return;
    }

    const loginParam = ROLE_TO_LOGIN_PARAM[role];

    try {
      // Use role-specific test login route
      // The test-login route now redirects directly to the dashboard, bypassing /select-organization
      // This avoids GitHub API rate limiting issues
      console.log(`🔐 Logging in as ${role} via /test-login?role=${loginParam}`);

      const dashboardUrlPattern = new RegExp(`/(admin|assistant|student)/${TEST_CLASSROOM}`);

      // Navigate and wait for redirect to complete
      await page.goto(`/test-login?role=${loginParam}`, { timeout: 30000 });

      // Wait for the dashboard URL (test-login now redirects directly there)
      await page.waitForURL(dashboardUrlPattern, { timeout: 15000 });

      console.log(`✅ ${role} login successful`);

      // Save storage state for this role
      await page.context().storageState({ path: stateFile });

      console.log(`✅ ${role} state saved`);
    } catch (error) {
      // Log the error but don't fail the entire auth setup
      console.error(`❌ ${role} auth setup failed:`, (error as Error).message);

      // If we don't have a valid state file, tests for this role will be skipped
      // Create a marker file so we don't retry immediately
      if (!existsSync(stateFile)) {
        console.log(`⚠️ Creating empty state for ${role} - tests requiring this role will be skipped`);
        writeFileSync(stateFile, JSON.stringify({ cookies: [], origins: [], _authFailed: true }));
      }

      // Re-throw so this specific setup is marked as failed
      throw error;
    }
  });
}
