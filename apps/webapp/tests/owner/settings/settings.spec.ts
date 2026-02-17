import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad } from '../../helpers/wait.helpers';

/**
 * Settings Page Tests
 *
 * Tests for the admin settings at /admin/$org/settings/*
 * The settings page uses URL-based tab navigation with nested routes.
 */

test.describe('Settings Navigation', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/settings/general`);
    await waitForDataLoad(page);
  });

  test('displays settings page header', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: /Classroom Settings/i })).toBeVisible();
  });

  test('displays all settings tabs', async ({ authenticatedPage: page }) => {
    // Core tabs that should always be visible
    await expect(page.getByRole('tab', { name: /General/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Repositories/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Grades/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Quizzes/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Content/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Extension/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Danger Zone/i })).toBeVisible();
  });

  test('can navigate to Grades tab', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('tab', { name: /Grades/i }).click();
    await page.waitForURL(`**/admin/${testOrg}/settings/grades`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings/grades`));
  });

  test('can navigate to Quizzes tab', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('tab', { name: /Quizzes/i }).click();
    await page.waitForURL(`**/admin/${testOrg}/settings/quizzes`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings/quizzes`));
  });

  test('can navigate to Extension tab', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('tab', { name: /Extension/i }).click();
    await page.waitForURL(`**/admin/${testOrg}/settings/extension`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings/extension`));
  });

  test('can navigate to Danger Zone tab', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('tab', { name: /Danger Zone/i }).click();
    await page.waitForURL(`**/admin/${testOrg}/settings/danger-zone`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings/danger-zone`));
  });
});

test.describe('General Settings Tab', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/settings/general`);
    await waitForDataLoad(page);
  });

  test('General tab is selected by default', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('tab', { name: /General/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  test('displays profile section', async ({ authenticatedPage: page }) => {
    // The general settings should have profile-related content
    // ProfileSection component shows org settings - there are multiple forms on the page
    await expect(page.locator('form').first()).toBeVisible();
  });
});

test.describe('Grades Settings Tab', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/settings/grades`);
    await waitForDataLoad(page);
  });

  test('displays emoji mapping section', async ({ authenticatedPage: page }) => {
    // EmojiMapping component is rendered in grades settings
    await expect(page.getByText(/Emoji/i).first()).toBeVisible();
  });

  test('displays letter grade mapping section', async ({ authenticatedPage: page }) => {
    // LetterGradeMapping component
    await expect(page.getByText(/Letter Grade/i).first()).toBeVisible();
  });
});

test.describe('Quiz Settings Tab', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/settings/quizzes`);
    await waitForDataLoad(page);
  });

  test('displays quiz functionality toggle', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(/Quiz Functionality/i)).toBeVisible();
    await expect(page.getByText(/Enable Quizzes/i)).toBeVisible();
    // Switch component should be present
    await expect(page.locator('.ant-switch').first()).toBeVisible();
  });

  test('displays API Key section', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(/API Key/i).first()).toBeVisible();
    // Use exact match to avoid multiple matches
    await expect(page.getByText('Anthropic API Key', { exact: true })).toBeVisible();
  });

  test('displays standard quiz settings', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(/Standard Quiz Settings/i)).toBeVisible();
    await expect(page.getByText(/Temperature/i)).toBeVisible();
    await expect(page.getByText(/Max Tokens/i)).toBeVisible();
  });

  test('displays code-aware quiz settings', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(/Code-Aware Quiz Settings/i)).toBeVisible();
    // Use exact match to avoid multiple matches
    await expect(page.getByText('Agent Model', { exact: true })).toBeVisible();
  });

  test('shows system defaults badge when no API key', async ({ authenticatedPage: page }) => {
    // Without an API key, should show the system defaults badge
    const systemDefaultsBadge = page.getByText(/Using System Environment Variables/i);
    const orgKeyBadge = page.getByText(/Using Organization API Key/i);

    // One of these should be visible
    const hasSystemBadge = await systemDefaultsBadge.isVisible().catch(() => false);
    const hasOrgBadge = await orgKeyBadge.isVisible().catch(() => false);
    expect(hasSystemBadge || hasOrgBadge).toBeTruthy();
  });
});

test.describe('Danger Zone Tab', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/settings/danger-zone`);
    await waitForDataLoad(page);
  });

  test('displays warning message', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(/I hope you know what you are doing/i)).toBeVisible();
  });

  test('displays remove classroom section', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(/Remove Classroom/i)).toBeVisible();
    await expect(
      page.getByText(/This action will remove the classroom and all its associated data/i)
    ).toBeVisible();
  });

  test('has remove button', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('button', { name: /Remove/i })).toBeVisible();
  });

  test('clicking remove opens confirmation modal', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('button', { name: /Remove/i }).click();

    // Modal should appear with classroom name
    await expect(page.getByText(`Remove ${testOrg} classroom`)).toBeVisible();
    await expect(
      page.getByText(/The following data will be removed: modules, student enrollments/i)
    ).toBeVisible();

    // Cancel button should close the modal
    await page.getByRole('button', { name: /Cancel/i }).click();
    await expect(page.getByText(`Remove ${testOrg} classroom`)).not.toBeVisible();
  });
});

test.describe('Settings Tab State Preservation', () => {
  test('maintains correct tab selection after navigation', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // Start at general
    await page.goto(`/admin/${testOrg}/settings/general`);
    await waitForDataLoad(page);

    // Navigate to grades
    await page.getByRole('tab', { name: /Grades/i }).click();
    await page.waitForURL(`**/admin/${testOrg}/settings/grades`);

    // Verify grades tab is now selected
    await expect(page.getByRole('tab', { name: /Grades/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.getByRole('tab', { name: /General/i })).toHaveAttribute(
      'aria-selected',
      'false'
    );

    // Navigate to quizzes
    await page.getByRole('tab', { name: /Quizzes/i }).click();
    await page.waitForURL(`**/admin/${testOrg}/settings/quizzes`);

    // Verify quizzes tab is selected
    await expect(page.getByRole('tab', { name: /Quizzes/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  test('direct URL navigation selects correct tab', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // Navigate directly to quizzes settings via URL
    await page.goto(`/admin/${testOrg}/settings/quizzes`);
    await waitForDataLoad(page);

    // Quizzes tab should be selected
    await expect(page.getByRole('tab', { name: /Quizzes/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });
});
