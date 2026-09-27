import { test, expect } from '../../fixtures/auth.fixture';
import { waitForDataLoad } from '../../helpers/wait.helpers';

/**
 * Settings page tests.
 *
 * The settings page renders tabs as plain <button> controls (not role="tab", no
 * aria-selected), so selection is asserted via the URL rather than aria state.
 */

const tab = (page: import('@playwright/test').Page, name: RegExp) =>
  page.getByRole('button', { name });

test.describe('Settings Navigation', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/settings/general`);
    await waitForDataLoad(page);
  });

  test('displays settings page header', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: /^Settings$/i })).toBeVisible();
  });

  test('displays all settings tabs', async ({ authenticatedPage: page }) => {
    await expect(tab(page, /^General$/)).toBeVisible();
    await expect(tab(page, /^Repositories$/)).toBeVisible();
    await expect(tab(page, /^Grades$/)).toBeVisible();
    await expect(tab(page, /^AI$/)).toBeVisible();
    await expect(tab(page, /^Content$/)).toBeVisible();
    await expect(tab(page, /^Team$/)).toBeVisible();
    await expect(tab(page, /^Extension$/)).toBeVisible();
    await expect(tab(page, /^Danger Zone$/)).toBeVisible();
  });

  test('can navigate to Grades tab', async ({ authenticatedPage: page, testOrg }) => {
    await tab(page, /^Grades$/).click();
    await page.waitForURL(`**/admin/${testOrg}/settings/grades`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings/grades`));
  });

  test('can navigate to AI tab', async ({ authenticatedPage: page, testOrg }) => {
    await tab(page, /^AI$/).click();
    await page.waitForURL(`**/admin/${testOrg}/settings/ai`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings/ai`));
  });

  test('can navigate to Extension tab', async ({ authenticatedPage: page, testOrg }) => {
    await tab(page, /^Extension$/).click();
    await page.waitForURL(`**/admin/${testOrg}/settings/extension`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings/extension`));
  });

  test('can navigate to Danger Zone tab', async ({ authenticatedPage: page, testOrg }) => {
    await tab(page, /^Danger Zone$/).click();
    await page.waitForURL(`**/admin/${testOrg}/settings/danger-zone`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings/danger-zone`));
  });
});

test.describe('General Settings Tab', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/settings/general`);
    await waitForDataLoad(page);
  });

  test('General tab is the active tab on the general URL', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings/general`));
    await expect(tab(page, /^General$/)).toBeVisible();
  });

  test('displays profile section', async ({ authenticatedPage: page }) => {
    await expect(page.locator('form').first()).toBeVisible();
  });
});

test.describe('Grades Settings Tab', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/settings/grades`);
    await waitForDataLoad(page);
  });

  test('displays emoji mapping section', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(/Emoji/i).first()).toBeVisible();
  });

  test('displays letter grade mapping section', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(/Letter Grade/i).first()).toBeVisible();
  });
});

test.describe('AI Settings Tab', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/settings/ai`);
    await waitForDataLoad(page);
  });

  test('displays the quiz and Ask Moji toggles', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('AI Quizzes', { exact: true })).toBeVisible();
    await expect(page.getByText('Enable quizzes', { exact: true })).toBeVisible();
    await expect(page.getByText('Enable Ask Moji', { exact: true })).toBeVisible();
    await expect(page.locator('.ant-switch').first()).toBeVisible();
  });

  test('displays API Key section', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(/API Key/i).first()).toBeVisible();
    await expect(page.getByText('Anthropic API key', { exact: true })).toBeVisible();
  });

  test('displays the quiz model and effort selects', async ({ authenticatedPage: page }) => {
    await expect(page.getByText('Standard quizzes', { exact: true })).toBeVisible();
    await expect(page.getByText('Code-aware quizzes', { exact: true })).toBeVisible();
    await expect(page.getByText('Questions', { exact: true })).toBeVisible();
    await expect(page.getByText('Grading', { exact: true })).toBeVisible();
  });

  test('shows api-key status badge', async ({ authenticatedPage: page }) => {
    // Exactly one badge always renders (system defaults vs classroom key). Poll
    // with a single .or() locator instead of an instant isVisible() so a
    // late-rendering badge doesn't flake the assertion.
    const badge = page
      .getByText(/Using system defaults/i)
      .or(page.getByText(/Using classroom key/i));
    await expect(badge.first()).toBeVisible();
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
    await expect(page.getByRole('button', { name: /^Remove$/i })).toBeVisible();
  });

  test('clicking remove opens confirmation modal', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('button', { name: /^Remove$/i }).click();

    // Modal title is `Remove <classSlug> classroom`; testOrg === classSlug.
    const modal = page.locator('.ant-modal-content');
    await expect(modal.getByText(`Remove ${testOrg} classroom`)).toBeVisible();
    await expect(
      modal.getByText(/The following data will be removed: repositories, student enrollments/i)
    ).toBeVisible();

    await modal.getByRole('button', { name: /Cancel/i }).click();
    await expect(page.getByText(`Remove ${testOrg} classroom`)).not.toBeVisible();
  });
});

// Persistence (profile writes, classroom removal) is covered by the
// classroom-lifecycle spec with DB assertions; these specs check render + routing only.
test.describe('Settings Tab Routing (render + URL only)', () => {
  test('navigating between tabs updates the URL', async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/admin/${testOrg}/settings/general`);
    await waitForDataLoad(page);

    await tab(page, /^Grades$/).click();
    await page.waitForURL(`**/admin/${testOrg}/settings/grades`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings/grades`));

    await tab(page, /^AI$/).click();
    await page.waitForURL(`**/admin/${testOrg}/settings/ai`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings/ai`));
  });

  test('direct URL navigation lands on the requested tab', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(`/admin/${testOrg}/settings/ai`);
    await waitForDataLoad(page);

    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings/ai`));
    await expect(page.getByText('AI Quizzes', { exact: true })).toBeVisible();
  });

  test('the old Quizzes tab URL redirects to the AI tab', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    await page.goto(`/admin/${testOrg}/settings/quizzes`);
    await page.waitForURL(`**/admin/${testOrg}/settings/ai`);
    await expect(page).toHaveURL(new RegExp(`/admin/${testOrg}/settings/ai`));
  });
});
