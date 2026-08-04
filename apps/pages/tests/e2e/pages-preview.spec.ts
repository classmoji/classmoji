/**
 * Pages Preview Mode E2E Tests (plan §3b — preview branches)
 *
 * Covers the staff-gating of `?preview=1` and the preview chrome:
 * - anonymous / student viewers: the param is silently ignored, no preview
 *   chrome renders (the preview loader state is staff-only)
 * - staff: `?preview=1` always yields exactly one of the preview bar (branch
 *   exists) or the "no preview pending" notice (branch absent)
 *
 * The accept/discard/diff flows need a page with a real `preview/<content_path>`
 * branch in the classroom content repo — those specs are skeletons (test.skip)
 * until a content-repo fixture exists; the dev-stack verification pass covers
 * them manually.
 *
 * Requires the dev stack (npm run dev) with a seeded classroom.
 */

import { test, expect } from '../fixtures/test.fixture';
import {
  loginAs,
  logout,
  getTestClassroomSlug,
  getClassroomIdBySlug,
  findViewablePage,
  type PageRow,
} from '../helpers';

test.describe.configure({ mode: 'serial' });

const classroomSlug = getTestClassroomSlug();
let publicPage: PageRow | null = null;
let memberPage: PageRow | null = null;

test.beforeAll(async () => {
  const classroomId = await getClassroomIdBySlug(classroomSlug);
  publicPage = await findViewablePage(classroomId, { publicOnly: true });
  memberPage = await findViewablePage(classroomId);
});

test.describe('Pages preview mode', () => {
  test('anonymous: ?preview=1 is ignored and no preview chrome renders', async ({ page }) => {
    test.skip(!publicPage, 'No public, published page seeded in the test classroom');

    await page.goto(`/${classroomSlug}/${publicPage!.id}?preview=1`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

    // Preview loader state is staff-only — none of the chrome may render
    await expect(page.getByTestId('preview-bar')).toHaveCount(0);
    await expect(page.getByTestId('no-preview-notice')).toHaveCount(0);
    await expect(page.getByTestId('pending-preview-banner')).toHaveCount(0);
  });

  test('student: ?preview=1 is ignored (param is staff-gated)', async ({ page }) => {
    test.skip(!memberPage, 'No published page seeded in the test classroom');

    await loginAs(page, 'student');
    await page.goto(`/${classroomSlug}/${memberPage!.id}?preview=1`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

    await expect(page.getByTestId('preview-bar')).toHaveCount(0);
    await expect(page.getByTestId('no-preview-notice')).toHaveCount(0);
    await expect(page.getByTestId('pending-preview-banner')).toHaveCount(0);

    await logout(page);
  });

  test('staff: ?preview=1 shows exactly one of preview bar / no-preview notice', async ({
    page,
  }) => {
    test.skip(!memberPage, 'No published page seeded in the test classroom');

    await loginAs(page, 'owner');
    await page.goto(`/${classroomSlug}/${memberPage!.id}?preview=1`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

    // Both states are SSR'd from loader data: a pending preview branch renders
    // the amber bar; no branch renders the "no preview pending" notice. Staff
    // must always get exactly one of the two.
    const barCount = await page.getByTestId('preview-bar').count();
    const noticeCount = await page.getByTestId('no-preview-notice').count();
    expect(barCount + noticeCount).toBe(1);

    if (barCount === 1) {
      // Preview bar carries the three actions
      await expect(page.getByRole('button', { name: 'Accept' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Discard' })).toBeVisible();
      await expect(page.getByRole('link', { name: /Diff/ })).toBeVisible();
    }

    await logout(page);
  });

  // TODO(Phase 2p follow-up): the specs below need a fixture that creates a
  // `preview/<content_path>` branch in the classroom content repo (a GitHub
  // write via ContentService, plus cleanup). Seeded-data auth works (see
  // above), but provisioning a real preview branch per run was out of scope
  // tonight — the dev-stack verification pass covers these manually.

  test.skip('staff: preview bar shows commit count, age, and renders the branch content', async () => {
    // 1. Create a preview branch with one content.json commit on top of main
    // 2. loginAs(page, 'owner'); goto `?preview=1`
    // 3. expect preview-bar visible with "1 commit" and a relative age
    // 4. expect the previewed block content (not main's) to render
    // 5. Cleanup: delete the branch
  });

  test.skip('staff: Accept merges cleanly and redirects to the live view with a success toast', async () => {
    // 1. Create a preview branch with a non-conflicting content.json change
    // 2. loginAs(page, 'owner'); goto `?preview=1`; click Accept
    // 3. expect redirect to the page without ?preview=1 and a success toast
    // 4. expect the merged content on the live view; branch deleted
  });

  test.skip('staff: Discard deletes the branch and shows the discarded notice', async () => {
    // 1. Create a preview branch
    // 2. loginAs(page, 'owner'); goto `?preview=1`; click Discard (accept the confirm dialog)
    // 3. expect redirect to the live view with the "Preview discarded" toast
    // 4. expect main content unchanged; branch deleted
  });

  test.skip('staff: pending-preview banner appears on the normal view when a preview exists', async () => {
    // 1. Create a preview branch
    // 2. loginAs(page, 'owner'); goto the page WITHOUT ?preview=1
    // 3. expect pending-preview-banner with "View preview", Accept, Discard
    // 4. Cleanup: delete the branch
  });
});
