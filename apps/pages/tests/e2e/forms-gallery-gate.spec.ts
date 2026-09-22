/**
 * The gallery moderation endpoint's gate, over real HTTP.
 *
 * Approve/Hide is teaching-team work: OWNER, TEACHER and ASSISTANT pass, a
 * STUDENT does not. The slug names no form, so a caller the gate admits gets
 * the route's own 404 `Form not found` — that body (not a 403, and not the
 * router's no-match 404) is the proof the gate let them in.
 * Fixture-free on purpose, like forms-auth-gate.spec.ts; the fixture-backed
 * status changes live in forms-gallery-moderation.spec.ts.
 */

import { test, expect } from '@playwright/test';
import { getPagesBaseURL, getTestClassroomSlug, loginAs } from '../helpers';

const CLASS = getTestClassroomSlug();
const ENDPOINT = `/${CLASS}/forms/a-form-that-does-not-exist/responses/gallery`;
const post = (page: import('@playwright/test').Page) =>
  page.request.post(ENDPOINT, {
    data: { responseIds: [], status: 'APPROVED' },
    headers: { origin: getPagesBaseURL() },
    maxRedirects: 0,
  });

test.describe('gallery moderation gate', () => {
  test('an anonymous POST is refused', async ({ page }) => {
    expect([401, 302]).toContain((await post(page)).status());
  });

  test('a STUDENT is refused', async ({ page }) => {
    await loginAs(page, 'student');
    expect((await post(page)).status()).toBe(403);
  });

  test('an ASSISTANT passes the gate', async ({ page }) => {
    await loginAs(page, 'ta');
    const response = await post(page);
    expect(response.status()).toBe(404);
    expect(await response.text()).toBe('Form not found');
  });

  test('an OWNER passes the gate', async ({ page }) => {
    await loginAs(page, 'owner');
    const response = await post(page);
    expect(response.status()).toBe(404);
    expect(await response.text()).toBe('Form not found');
  });
});
