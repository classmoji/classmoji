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

    // Seeing who is on the teaching staff is a teaching-team right — the nav
    // entry lists OWNER, TEACHER and ASSISTANT — so a teacher SHOULD have this
    // one. What stays owner-only is MANAGING the team, which the sibling test
    // below covers on the page itself.
    await expect(page.getByRole('link', { name: 'Teaching Staff' })).toBeVisible();

    // Letter grades and per-student comments are a teaching-staff surface —
    // the nav entry lists OWNER and TEACHER — so a teacher SHOULD have this
    // one, served under their own prefix.
    await expect(page.getByRole('link', { name: 'Grades' })).toBeVisible();

    // Owner-only entries must not appear for a teacher.
    await expect(page.getByRole('link', { name: 'Class Settings' })).not.toBeVisible();
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
  test('the /admin namespace refuses a teacher (403), grades included', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // /admin/:class/** is owner-only at the server, so this is a 403 even
    // though the grades route's own gate now admits a teacher. The prefix is
    // what is being refused here, not the screen.
    const response = await page.goto(`/admin/${testOrg}/grades`);
    expect(response?.status()).toBe(403);
  });

  test('a teacher reaches grades at their own prefix', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // The other half of the assertion above: letter grades and comments are a
    // teaching-staff surface, served to a teacher under /teacher.
    await page.goto(`/teacher/${testOrg}/grades`);
    await waitForDataLoad(page);

    await expect(page).toHaveURL(new RegExp(`/teacher/${testOrg}/grades`));
    // .first(): the Suspense fallback carries the same heading while the
    // deferred payload resolves.
    await expect(page.getByRole('heading', { name: 'Grades' }).first()).toBeVisible();
  });

  test('a teacher may READ the teaching-staff list, with no management controls', async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    // The other half of the nav assertion above: the entry is there for a
    // teacher, and so is the page behind it — seeing who is on the team is a
    // teaching-team right, so this is no longer a 403. What stays owner-only is
    // MANAGING the team: the loader derives `canManage` from role AND path, and
    // this prefix exports no action at all.
    await page.goto(`/teacher/${testOrg}/staff`);
    await waitForDataLoad(page);

    await expect(page.getByRole('heading', { name: 'Teaching Staff' })).toBeVisible();
    await expect(page.getByRole('button', { name: /New staff member/i })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Actions' })).toHaveCount(0);
  });
});
