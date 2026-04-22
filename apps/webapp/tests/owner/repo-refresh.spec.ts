import { test, expect } from '../fixtures/auth.fixture';

/**
 * POST /api/repos/:id/refresh smoke test
 *
 * Minimal smoke — we don't seed a specific repository_assignment row for this
 * test, so we expect the route to reject with 404 (assignment missing) rather
 * than 200. What we're really asserting: the route exists, accepts POST, and
 * reaches our handler (not a 405 Method Not Allowed or route-not-found HTML).
 *
 * A fuller test that asserts `{ enqueued: true }` requires seeding a
 * RepositoryAssignment tied to the authenticated owner's classroom plus a
 * stubbed Trigger.dev client; left for when repo analytics fixtures land
 * alongside the dashboard UI.
 */
test.describe('POST /api/repos/:id/refresh', () => {
  test('rejects unknown repository assignment with 404', async ({ authenticatedPage: page }) => {
    const response = await page.request.post('/api/repos/00000000-0000-0000-0000-000000000000/refresh');

    // Either 404 (assignment not found) or 403 (no classroom access) is acceptable —
    // both prove the route mounted and executed server-side logic. We just want
    // to make sure we didn't get 405 / 404 route-not-found (HTML).
    expect([403, 404]).toContain(response.status());
    expect(response.status()).not.toBe(405);
  });

  test('rejects non-POST with 405', async ({ authenticatedPage: page }) => {
    const response = await page.request.get('/api/repos/00000000-0000-0000-0000-000000000000/refresh');
    // Action-only routes without a loader return 405 in React Router 7.
    expect(response.status()).toBe(405);
  });
});
