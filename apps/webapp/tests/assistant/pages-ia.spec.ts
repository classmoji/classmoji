import { test, expect } from '@playwright/test';
import { TEST_CLASSROOM } from '../helpers/env.helpers';
import { getTestPrisma } from '../helpers/prisma.helpers';

/**
 * The assistant surfaces are re-exports of the student routes, so this spec
 * only has to prove the two things a re-export can get wrong: that the route
 * exists at the assistant URL, and that its loader actually authorises an
 * assistant.
 *
 * The second is not hypothetical — `assistant.$class_.pages_.$pageId` used to
 * re-export a loader gated on `requireStudentAccess` (STUDENT only), so every
 * assistant got a 403 from a route whose comment claimed otherwise.
 */
test.describe('Assistant page IA', () => {
  test('the sidebar carries exactly one Pages entry', async ({ page }) => {
    await page.goto(`/assistant/${TEST_CLASSROOM}/dashboard`);
    const nav = page.locator('[data-cm-sidebar]');
    const pagesLinks = nav.getByRole('link', { name: 'Pages', exact: true });
    await expect(pagesLinks).toHaveCount(1, { timeout: 15000 });
    await expect(pagesLinks).toHaveAttribute('href', `/assistant/${TEST_CLASSROOM}/pages`);
  });

  test('the docked Pages view renders for an assistant', async ({ page }) => {
    const response = await page.goto(`/assistant/${TEST_CLASSROOM}/pages`);
    expect(response?.status()).toBeLessThan(400);
    await expect(page.getByRole('heading', { name: 'Pages', level: 1 })).toBeVisible();
    await expect(page.locator('[data-cm-page-panel="docked"]')).toBeVisible({ timeout: 15000 });
  });

  test('a page deep link no longer 403s an assistant', async ({ page }) => {
    const published = await getTestPrisma().page.findFirst({
      where: { classroom: { slug: TEST_CLASSROOM }, is_draft: false },
      select: { id: true },
      orderBy: { title: 'asc' },
    });
    test.skip(!published, 'No published page in this fixture');

    const response = await page.goto(`/assistant/${TEST_CLASSROOM}/pages/${published!.id}`);
    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator('[data-cm-page-panel="docked"] iframe')).toBeVisible({
      timeout: 15000,
    });
  });

  test('staff may read a draft page that students cannot', async ({ page }) => {
    const draft = await getTestPrisma().page.findFirst({
      where: { classroom: { slug: TEST_CLASSROOM }, is_draft: true },
      select: { id: true },
    });
    test.skip(!draft, 'No draft page in this fixture');

    const response = await page.goto(`/assistant/${TEST_CLASSROOM}/pages/${draft!.id}`);
    expect(response?.status()).toBeLessThan(400);
  });
});
