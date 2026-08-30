/**
 * The forms subtree's auth gate, over real HTTP.
 *
 * `tests/unit/forms-paths.spec.ts` asserts the classification rule in
 * isolation. This file asserts that `root.tsx` acts on it and that the route
 * config puts the right module behind each path — the two halves that can drift
 * apart without either one being wrong on its own.
 *
 * The properties:
 *
 *  1. an anonymous GET of a PUBLIC fill path answers 200, not a login redirect
 *     — a waitlist link has to open for someone with no account;
 *  2. an anonymous GET of the ADMIN surfaces still redirects to the webapp
 *     login — the exemption did not widen;
 *  3. a signed-in non-staff member is refused, which is the case no redirect
 *     can catch and therefore the case `assertFormAdmin` exists for;
 *  4. neither surface renders the pages sidebar, i.e. the subtree really did
 *     escape the `$classroomSlug` layout.
 *
 * Requests go through `page.request`, not the standalone `request` fixture:
 * `page.request` shares cookies with the page's context, so a `loginAs` in the
 * page is visible to the call under test. `maxRedirects: 0` is deliberate too —
 * the redirect target is the WEBAPP, which this harness does not run, so
 * following it would fail for a reason unrelated to what is being tested. The
 * status line and the Location header are the assertion.
 */

import { test, expect } from '@playwright/test';
import { getTestClassroomSlug, loginAs } from '../helpers';

const CLASS = getTestClassroomSlug();

/**
 * A slug no form holds. Deliberate: the public fill route must answer for a
 * stranger BEFORE anything is known about the form, so asserting against a
 * missing form proves the 200 comes from the gate and not from a fixture.
 */
const SOME_FORM = 'a-form-that-does-not-exist';

test.describe('forms auth gate', () => {
  test('anonymous GET of a public fill path is 200, not a login redirect', async ({ page }) => {
    const response = await page.request.get(`/${CLASS}/forms/${SOME_FORM}`, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
  });

  test('anonymous GET of the magic-link verify path is 200', async ({ page }) => {
    const response = await page.request.get(`/${CLASS}/forms/${SOME_FORM}/verify`, {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(200);
  });

  test('anonymous GET of the admin list redirects to the webapp login', async ({ page }) => {
    const response = await page.request.get(`/${CLASS}/forms`, { maxRedirects: 0 });
    expect(response.status()).toBe(302);

    const location = response.headers()['location'] ?? '';
    // Not merely "a redirect": it must be the login hand-off, carrying the
    // original URL so the round trip lands back on the list.
    expect(location).toContain('redirect=');
    expect(decodeURIComponent(location)).toContain(`/${CLASS}/forms`);
  });

  test('anonymous GET of the builder redirects to the webapp login', async ({ page }) => {
    const response = await page.request.get(`/${CLASS}/forms/${SOME_FORM}/edit`, {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(302);
    expect(response.headers()['location'] ?? '').toContain('redirect=');
  });

  test('anonymous GET of the new-form drawer redirects to the webapp login', async ({ page }) => {
    const response = await page.request.get(`/${CLASS}/forms/new`, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
  });

  test('a signed-in STUDENT is refused the admin list', async ({ page }) => {
    // A student holds a valid session, so the login redirect can never catch
    // them — `assertFormAdmin` is the only thing that does.
    await loginAs(page, 'student');
    const response = await page.request.get(`/${CLASS}/forms`, { maxRedirects: 0 });
    expect(response.status()).toBe(403);
  });

  test('a signed-in ASSISTANT is refused the admin list', async ({ page }) => {
    // Deliberate, and worth pinning: forms compose `requireClassroomStaff`
    // (OWNER | TEACHER), not `requireClassroomTeachingTeam`. Responses carry
    // applicant PII, so the TA-visible tier is the wrong default here.
    await loginAs(page, 'ta');
    const response = await page.request.get(`/${CLASS}/forms`, { maxRedirects: 0 });
    expect(response.status()).toBe(403);
  });

  test('a signed-in OWNER gets the list, without the pages sidebar', async ({ page }) => {
    await loginAs(page, 'owner');
    const response = await page.request.get(`/${CLASS}/forms`, { maxRedirects: 0 });
    expect(response.status()).toBe(200);

    const html = await response.text();
    expect(html).toContain('New Form');
    // The other half of the layout escape: the admin surface sits outside the
    // `$classroomSlug` layout too, so it carries none of the page chrome.
    expect(html).not.toContain('New Page');
  });

  test('the fill page does not inherit the pages sidebar', async ({ page }) => {
    const response = await page.request.get(`/${CLASS}/forms/${SOME_FORM}`, { maxRedirects: 0 });
    const html = await response.text();

    // If the forms subtree were nested under the `$classroomSlug` layout, that
    // layout's loader would have run and its chrome — along with the
    // classroom's page list — would be in a document an anonymous stranger is
    // allowed to see.
    expect(html).not.toContain('New Page');
    // And the placeholder really is what rendered.
    expect(html).toContain('will be fillable here shortly');
  });
});
