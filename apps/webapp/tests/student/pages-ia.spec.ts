import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { request as playwrightRequest } from '@playwright/test';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getTestPrisma } from '../helpers/prisma.helpers';
import { TEST_CLASSROOM, getDevContext } from '../helpers/env.helpers';

/**
 * Student-side page IA (Option C): one Pages nav entry, a docked front page,
 * and a peek drawer for contextual links.
 *
 * The fixture classroom has no page links and no menu pages, so this spec
 * creates the minimum through the app's OWN authorized endpoints (never SQL)
 * and removes them again in afterAll:
 *   - show_in_student_menu ON for two pages, so "the per-page sidebar entries
 *     are gone" is a claim about real data rather than about an empty table;
 *   - one page linked to a repository, so the repos tree has something to peek.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const authDir = join(__dirname, '../.auth');
const { webappUrl } = getDevContext();

let owner: APIRequestContext;
let menuPageIds: string[] = [];
let linkedPageId = '';
let repositoryId = '';
let homePageTitle = '';

const setMenuFlag = (pageId: string, value: boolean) =>
  owner.post(`/admin/${TEST_CLASSROOM}/pages`, {
    form: { pageId, field: 'show_in_student_menu', value: String(value) },
  });

test.beforeAll(async () => {
  owner = await playwrightRequest.newContext({
    baseURL: webappUrl,
    storageState: join(authDir, 'owner.json'),
  });

  const prisma = getTestPrisma();
  const classroom = await prisma.classroom.findFirst({
    where: { slug: TEST_CLASSROOM },
    select: { id: true },
  });
  if (!classroom) throw new Error(`Fixture classroom ${TEST_CLASSROOM} not found`);

  const site = await prisma.classroomSite.findUnique({
    where: { classroom_id: classroom.id },
    select: { home_page_id: true },
  });
  const home = site?.home_page_id
    ? await prisma.page.findUnique({
        where: { id: site.home_page_id },
        select: { title: true },
      })
    : null;
  homePageTitle = home?.title ?? '';

  const pages = await prisma.page.findMany({
    where: { classroom_id: classroom.id, is_draft: false },
    select: { id: true, title: true },
    orderBy: { title: 'asc' },
    take: 2,
  });
  menuPageIds = pages.map(p => p.id);
  for (const id of menuPageIds) await setMenuFlag(id, true);

  const repo = await prisma.repository.findFirst({
    where: { classroom_id: classroom.id, is_published: true },
    select: { id: true },
  });
  if (repo && pages[0]) {
    repositoryId = repo.id;
    linkedPageId = pages[0].id;
    const response = await owner.post(`/admin/${TEST_CLASSROOM}/resources?/addLink`, {
      data: {
        resourceId: linkedPageId,
        resourceType: 'page',
        targetType: 'repository',
        targetId: repositoryId,
      },
    });
    if (!response.ok()) linkedPageId = '';
  }
});

test.afterAll(async () => {
  const prisma = getTestPrisma();
  for (const id of menuPageIds) await setMenuFlag(id, false);
  if (linkedPageId && repositoryId) {
    const link = await prisma.pageLink.findFirst({
      where: { page_id: linkedPageId, repository_id: repositoryId },
      select: { id: true },
    });
    if (link) {
      await owner.post(`/admin/${TEST_CLASSROOM}/resources?/removeLink`, {
        data: { linkId: link.id, resourceType: 'page' },
      });
    }
  }
  await owner.dispose();
});

const sidebar = (page: Page) => page.locator('[data-cm-sidebar]');

test.describe('Sidebar compression', () => {
  test('the sidebar carries exactly one Pages entry, and no per-page group', async ({ page }) => {
    await page.goto(`/student/${TEST_CLASSROOM}/dashboard`);
    const nav = sidebar(page);
    await expect(nav.getByRole('link', { name: 'Repositories' })).toBeVisible({ timeout: 15000 });

    // Two pages are flagged show_in_student_menu right now, so the old build
    // would have rendered a "Pages" group header plus one link per page.
    const pagesLinks = nav.getByRole('link', { name: 'Pages', exact: true });
    await expect(pagesLinks).toHaveCount(1);
    await expect(pagesLinks).toHaveAttribute('href', `/student/${TEST_CLASSROOM}/pages`);

    const linkTexts = await nav.getByRole('link').allInnerTexts();
    const pageTitles = await getTestPrisma()
      .page.findMany({ where: { id: { in: menuPageIds } }, select: { title: true } })
      .then(rows => rows.map(r => r.title));
    for (const title of pageTitles) {
      expect(linkTexts, `"${title}" must not be its own sidebar entry`).not.toContain(title);
    }
  });

  test('Pages is the last entry in the CONTENT group', async ({ page }) => {
    await page.goto(`/student/${TEST_CLASSROOM}/dashboard`);
    const nav = sidebar(page);
    await expect(nav.getByRole('link', { name: 'Pages', exact: true })).toBeVisible({
      timeout: 15000,
    });

    // Every nav item carries its route key in data-tour-nav, so DOM order is
    // read straight off the attributes instead of guessing at group wrappers.
    const order = await nav.locator('[data-tour-nav]').evaluateAll(nodes =>
      nodes.map(n => n.getAttribute('data-tour-nav'))
    );
    const contentLinks = ['/modules', '/repos', '/assignments', '/slides', '/quizzes', '/pages'];
    const present = order.filter(link => contentLinks.includes(link!));
    expect(present[present.length - 1]).toBe('/pages');
  });

  test('the flagged pages are still reachable at their own URL', async ({ page }) => {
    const response = await page.goto(`/student/${TEST_CLASSROOM}/pages/${menuPageIds[0]}`);
    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator('[data-cm-page-panel="docked"]')).toBeVisible({ timeout: 15000 });
  });
});

test.describe('Docked Pages view', () => {
  test('docks the class front page inside the standard card', async ({ page }) => {
    await page.goto(`/student/${TEST_CLASSROOM}/pages`);
    await expect(page.getByRole('heading', { name: 'Pages', level: 1 })).toBeVisible();

    const panel = page.locator('[data-cm-page-panel="docked"]');
    await expect(panel).toBeVisible({ timeout: 15000 });
    // Docked: no scrim, no close button (S5b).
    await expect(page.locator('[data-cm-page-peek]')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Close page preview' })).toHaveCount(0);

    if (homePageTitle) {
      await expect(panel.getByRole('heading', { level: 2 })).toHaveText(homePageTitle);
    }
  });

  test('the iframe embeds the pages app with the parent origin for the bridge', async ({
    page,
  }) => {
    await page.goto(`/student/${TEST_CLASSROOM}/pages`);
    const frame = page.locator('[data-cm-page-panel="docked"] iframe');
    await expect(frame).toBeVisible({ timeout: 15000 });

    const src = new URL((await frame.getAttribute('src'))!);
    expect(src.searchParams.get('embed')).toBe('true');
    expect(src.searchParams.get('parentOrigin')).toBe(new URL(webappUrl).origin);
    expect(src.pathname.startsWith(`/${TEST_CLASSROOM}/`)).toBe(true);
  });

  test('the ↗ points at the class site when the page is public there', async ({ page }) => {
    const prisma = getTestPrisma();
    const site = await prisma.classroomSite.findFirst({
      where: { classroom: { slug: TEST_CLASSROOM } },
      select: { subdomain: true, is_enabled: true, home_page_id: true },
    });
    test.skip(!site?.is_enabled, 'No enabled class site in this fixture');

    const homePage = await prisma.page.findUnique({
      where: { id: site!.home_page_id! },
      select: { slug: true, is_public: true },
    });

    await page.goto(`/student/${TEST_CLASSROOM}/pages`);
    const arrow = page.locator('[data-cm-page-panel="docked"] a[target="_blank"]');
    await expect(arrow).toBeVisible({ timeout: 15000 });

    const href = await arrow.getAttribute('href');
    expect(href).toContain(`${site!.subdomain}.`);
    if (homePage?.is_public && homePage.slug) {
      expect(href!.endsWith(`/${homePage.slug}`)).toBe(true);
    }
  });
});

test.describe('Peek drawer', () => {
  test.skip(() => !linkedPageId, 'No repository page link could be created');

  const openPeek = async (page: Page) => {
    await page.goto(`/student/${TEST_CLASSROOM}/repos`);
    const trigger = page.locator(`[data-cm-page-link="${linkedPageId}"]`).first();
    await expect(trigger).toBeVisible({ timeout: 20000 });
    await trigger.click();
    await expect(page.locator('[data-cm-page-peek]')).toBeVisible();
  };

  test('opens over the repositories view without changing the URL', async ({ page }) => {
    await page.goto(`/student/${TEST_CLASSROOM}/repos`);
    const before = page.url();

    await openPeek(page);

    expect(page.url()).toBe(before);
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('iframe')).toBeVisible();
  });

  test('closes on ✕, on Escape, and on a scrim click', async ({ page }) => {
    await openPeek(page);
    await page.getByRole('button', { name: 'Close page preview' }).last().click();
    await expect(page.locator('[data-cm-page-peek]')).toHaveCount(0);

    await openPeek(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-cm-page-peek]')).toHaveCount(0);

    await openPeek(page);
    // The scrim is the first button in the portal — clicking outside the panel.
    await page.locator('[data-cm-page-peek] > button').first().click({ position: { x: 8, y: 8 } });
    await expect(page.locator('[data-cm-page-peek]')).toHaveCount(0);
  });

  test('the ↗ resolves to the site URL for a public page, in-app otherwise', async ({ page }) => {
    await openPeek(page);
    const arrow = page.locator('[data-cm-page-peek] a[target="_blank"]');
    await expect(arrow).toBeVisible();
    const href = (await arrow.getAttribute('href'))!;

    const prisma = getTestPrisma();
    const [linked, site] = await Promise.all([
      prisma.page.findUnique({
        where: { id: linkedPageId },
        select: { slug: true, is_public: true },
      }),
      prisma.classroomSite.findFirst({
        where: { classroom: { slug: TEST_CLASSROOM } },
        select: { subdomain: true, is_enabled: true },
      }),
    ]);

    if (site?.is_enabled && linked?.is_public && linked.slug) {
      expect(href).toContain(`${site.subdomain}.`);
      expect(href.endsWith(`/${linked.slug}`)).toBe(true);
    } else {
      expect(href).toBe(`/student/${TEST_CLASSROOM}/pages/${linkedPageId}`);
    }
  });
});

/**
 * The postMessage contract, exercised for real: the panel can only learn where
 * a cross-origin iframe went by being told, so a genuine in-frame navigation
 * has to move the header title and the ↗ target or the bridge is dead.
 */
test.describe('postMessage nav-sync', () => {
  test('the panel header and ↗ follow the iframe as it navigates itself', async ({ page }) => {
    const prisma = getTestPrisma();
    const classroom = await prisma.classroom.findFirst({
      where: { slug: TEST_CLASSROOM },
      select: { id: true },
    });
    const site = await prisma.classroomSite.findUnique({
      where: { classroom_id: classroom!.id },
      select: { home_page_id: true },
    });
    const other = await prisma.page.findFirst({
      where: {
        classroom_id: classroom!.id,
        is_draft: false,
        id: { not: site?.home_page_id ?? undefined },
      },
      select: { id: true, title: true, slug: true, is_public: true },
      orderBy: { title: 'asc' },
    });
    test.skip(!other, 'Need a second published page');

    await page.goto(`/student/${TEST_CLASSROOM}/pages`);
    const panel = page.locator('[data-cm-page-panel="docked"]');
    await expect(panel.locator('iframe')).toBeVisible({ timeout: 15000 });
    const titleBefore = await panel.getByRole('heading', { level: 2 }).innerText();

    // A real navigation inside the frame — the same thing a hub link does.
    const handle = await panel.locator('iframe').elementHandle();
    const frame = await handle!.contentFrame();
    expect(frame, 'embedded pages frame must exist').toBeTruthy();
    await frame!.waitForLoadState('domcontentloaded');
    await frame!.evaluate(
      ([slug, pageId]) => {
        window.location.href = `/${slug}/${pageId}?embed=true`;
      },
      [TEST_CLASSROOM, other!.id]
    );

    // Proof the ping arrived: the header is a "back to the front page" button
    // now, carrying the new page's title.
    const home = page.getByRole('button', { name: other!.title, exact: true });
    await expect(home).toBeVisible({ timeout: 20000 });
    expect(other!.title).not.toBe(titleBefore);

    // ...and the ↗ retargeted to the page the reader is actually on.
    const arrow = panel.locator('a[target="_blank"]');
    if (await arrow.count()) {
      const href = (await arrow.getAttribute('href'))!;
      if (other!.is_public && other!.slug) {
        expect(href.endsWith(`/${other!.slug}`)).toBe(true);
      }
    }

    // The header doubles as home (S5b): clicking it returns to the front page.
    await home.click();
    await expect(panel.getByRole('heading', { level: 2 })).toHaveText(titleBefore, {
      timeout: 20000,
    });
  });

  /**
   * In-page hub links (the pageLink block) navigate with a bare
   * `/{slug}/{pageId}` and drop `?embed=true`. Unhandled, one click inside the
   * reader pops the pages app's own sidebar into the panel. Embed mode is kept
   * sticky for any framed document, so this reproduces that navigation exactly
   * — a param-less in-frame URL — and asserts it heals.
   */
  test('embed mode survives an in-page link that drops the query param', async ({ page }) => {
    const other = await getTestPrisma().page.findFirst({
      where: { classroom: { slug: TEST_CLASSROOM }, is_draft: false },
      select: { id: true },
      orderBy: { title: 'asc' },
    });
    test.skip(!other, 'Need a published page');

    await page.goto(`/student/${TEST_CLASSROOM}/pages`);
    const panel = page.locator('[data-cm-page-panel="docked"]');
    await expect(panel.locator('iframe')).toBeVisible({ timeout: 15000 });
    const appUrlBefore = page.url();

    const handle = await panel.locator('iframe').elementHandle();
    const frame = await handle!.contentFrame();
    await frame!.waitForLoadState('domcontentloaded');
    await frame!.evaluate(
      ([slug, pageId]) => {
        window.location.href = `/${slug}/${pageId}`;
      },
      [TEST_CLASSROOM, other!.id]
    );

    // The panel healed itself back into embed mode...
    await expect
      .poll(
        async () => {
          const current = await panel.locator('iframe').elementHandle();
          return (await current!.contentFrame())?.url() ?? '';
        },
        { timeout: 20000 }
      )
      .toContain('embed=true');

    // ...the pages app's own sidebar never appeared...
    const embedded = page.frameLocator('[data-cm-page-panel="docked"] iframe');
    await expect(embedded.getByRole('button', { name: /collapse sidebar/i })).toHaveCount(0);

    // ...and the app behind the panel never navigated.
    expect(page.url()).toBe(appUrlBefore);
  });
});

/**
 * Light and dark captures of both containers. These are the design-review
 * artifacts, so they are asserted only for "the surface rendered".
 */
test.describe('Appearance', () => {
  const setTheme = async (page: Page, theme: 'light' | 'dark') => {
    await page.addInitScript(mode => {
      window.localStorage.setItem('cm-tweaks', JSON.stringify({ theme: mode, _v: 2 }));
    }, theme);
  };

  for (const theme of ['light', 'dark'] as const) {
    test(`docked Pages view — ${theme}`, async ({ page }, testInfo) => {
      await setTheme(page, theme);
      await page.goto(`/student/${TEST_CLASSROOM}/pages`);
      await expect(page.locator('[data-cm-page-panel="docked"] iframe')).toBeVisible({
        timeout: 20000,
      });
      await page.waitForTimeout(1500);
      await page.screenshot({
        path: testInfo.outputPath(`docked-${theme}.png`),
        fullPage: false,
      });
      testInfo.attach(`docked-${theme}`, { path: testInfo.outputPath(`docked-${theme}.png`) });
    });

    test(`peek drawer — ${theme}`, async ({ page }, testInfo) => {
      test.skip(!linkedPageId, 'No repository page link could be created');
      await setTheme(page, theme);
      await page.goto(`/student/${TEST_CLASSROOM}/repos`);
      const trigger = page.locator(`[data-cm-page-link="${linkedPageId}"]`).first();
      await expect(trigger).toBeVisible({ timeout: 20000 });
      await trigger.click();
      await expect(page.locator('[data-cm-page-peek] iframe')).toBeVisible();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: testInfo.outputPath(`peek-${theme}.png`), fullPage: false });
      testInfo.attach(`peek-${theme}`, { path: testInfo.outputPath(`peek-${theme}.png`) });
    });
  }
});

/**
 * A draft page is refused before the iframe is ever framed, so the reader gets
 * the app's own 403 rather than the pages app's generic error document.
 */
test.describe('Draft gating', () => {
  test('a student cannot deep-link a draft page', async ({ page }) => {
    const draft = await getTestPrisma().page.findFirst({
      where: { classroom: { slug: TEST_CLASSROOM }, is_draft: true },
      select: { id: true },
    });
    test.skip(!draft, 'No draft page in this fixture');

    const response = await page.goto(`/student/${TEST_CLASSROOM}/pages/${draft!.id}`);
    expect(response?.status()).toBe(403);
  });
});
