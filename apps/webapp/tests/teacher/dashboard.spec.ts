import { test, expect } from '../fixtures/auth.fixture';
import { waitForDataLoad } from '../helpers/wait.helpers';

/**
 * Teacher smoke tests.
 *
 * Authenticates as fake-teacher, who holds a TEACHER membership and NOTHING
 * else — the single-role identity matters, because a user who also held OWNER
 * would pass every gate here and make the denial assertion vacuous.
 *
 * Covers the three things that were broken before the /teacher prefix existed:
 * a teacher can reach a page at all, their navigation resolves, and an
 * owner-only route still refuses them.
 */

test.describe('Teacher shell', () => {
  test.beforeEach(async ({ authenticatedPage: page, testOrg }) => {
    await page.goto(`/teacher/${testOrg}/dashboard`);
    await waitForDataLoad(page, {
      anchor: page.getByRole('heading', { name: 'Dashboard', level: 1 }),
    });
  });

  test('lands on the teacher dashboard', async ({ authenticatedPage: page, testOrg }) => {
    await expect(page).toHaveURL(new RegExp(`/teacher/${testOrg}/dashboard`));
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  });

  test('org switcher exposes the Teacher role for this membership', async ({
    authenticatedPage: page,
  }) => {
    // The role label lives in the dropdown option, not the selected label.
    // This is also the regression guard for the switcher crash: before TEACHER
    // had a roleSettings entry, opening this dropdown threw on undefined.path.
    const orgSelect = page.locator('.ant-select-selector').first();
    await orgSelect.click();
    await expect(page.getByText('Teacher', { exact: true }).first()).toBeVisible({
      timeout: 10000,
    });
  });

  test('shows the expected teacher navigation', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Calendar' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Repositories' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Pages' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Students' })).toBeVisible();

    // Owner-only entries must not appear for a teacher.
    await expect(page.getByRole('link', { name: 'Class Settings' })).not.toBeVisible();
    await expect(page.getByRole('link', { name: 'Assistants' })).not.toBeVisible();
    await expect(page.getByRole('link', { name: 'Grades' })).not.toBeVisible();
  });

  test('every teacher nav link stays on the /teacher prefix', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const hrefs = await page.locator('nav a[href]').evaluateAll(links =>
      links.map(l => l.getAttribute('href') ?? '')
    );
    const classLinks = hrefs.filter(h => h.includes(`/${testOrg}/`));
    expect(classLinks.length).toBeGreaterThan(0);
    for (const href of classLinks) {
      expect(href, `nav link ${href} should stay under /teacher`).toMatch(/^\/teacher\//);
    }
  });

  test('can navigate to pages', async ({ authenticatedPage: page, testOrg }) => {
    await page.getByRole('link', { name: 'Pages' }).click();
    await page.waitForURL(`**/teacher/${testOrg}/pages`);
    await waitForDataLoad(page);
    await expect(page).toHaveURL(new RegExp(`/teacher/${testOrg}/pages`));
  });
});

test.describe('Teacher authorization', () => {
  test('an owner-only route refuses a teacher (403)', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const response = await page.goto(`/admin/${testOrg}/grades`);
    expect(response?.status()).toBe(403);
  });

  test('the teaching-team list is owner-only for a teacher (403)', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const response = await page.goto(`/admin/${testOrg}/assistants`);
    expect(response?.status()).toBe(403);
  });
});
