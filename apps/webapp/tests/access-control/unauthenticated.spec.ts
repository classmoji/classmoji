import { test, expect } from '@playwright/test';
import { TEST_CLASSROOM } from '../helpers/env.helpers';

/**
 * Access Control: unauthenticated visitors.
 *
 * Run in a clean context with no storageState, so they import from
 * @playwright/test rather than the auth fixture. The root loader redirects any
 * non-public route with no session to `/` (the public landing page); there is
 * no `/login` route.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const ADMIN_ROUTES = [
  `/admin/${TEST_CLASSROOM}/dashboard`,
  `/admin/${TEST_CLASSROOM}/repos`,
  `/admin/${TEST_CLASSROOM}/grades`,
  `/admin/${TEST_CLASSROOM}/students`,
  `/admin/${TEST_CLASSROOM}/settings/general`,
];

const ROLE_ROUTES = [
  `/admin/${TEST_CLASSROOM}/dashboard`,
  `/assistant/${TEST_CLASSROOM}/dashboard`,
  `/student/${TEST_CLASSROOM}/dashboard`,
];

test.describe('Access Control: an unauthenticated visitor cannot view protected pages', () => {
  test('visiting an admin dashboard without a session lands on the public landing page', async ({
    page,
  }) => {
    const response = await page.goto(`/admin/${TEST_CLASSROOM}/dashboard`);

    await expect(page).toHaveURL('/');
    if (response) {
      expect(response.status(), 'final document should not be a 5xx error').toBeLessThan(500);
    }
  });

  for (const route of ADMIN_ROUTES) {
    test(`visiting ${route} without a session does not expose the admin page`, async ({ page }) => {
      await page.goto(route);

      await expect(page).not.toHaveURL(new RegExp(`/admin/${TEST_CLASSROOM}`));
      await expect(page).toHaveURL('/');
    });
  }

  for (const route of ROLE_ROUTES) {
    test(`visiting ${route} without a session redirects away from the role route`, async ({
      page,
    }) => {
      await page.goto(route);
      await expect(page).toHaveURL('/');
    });
  }

  test('the org subscription API rejects a request that carries no session', async ({ request }) => {
    const res = await request.get(
      `/api/get-org-subscription?orgLogin=${TEST_CLASSROOM}`,
      { maxRedirects: 0 }
    );
    expect(res.ok(), 'unauthenticated subscription read must not succeed').toBeFalsy();
    expect(res.status(), 'should redirect (3xx) or be unauthorized, never 200').not.toBe(200);
  });
});
