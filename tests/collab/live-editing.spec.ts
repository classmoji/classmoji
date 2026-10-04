/**
 * Live collaborative editing — acceptance (two people, one classroom).
 *
 * Needs: the dev stack (incl. collab + trigger:dev) running on the devport,
 * `scripts/collab-dev/seed.ts` already run, ENABLE_TEST_LOGIN=true. Opt-in:
 *
 *   COLLAB_E2E=1 npx dotenv -e .env -- ./scripts/devport.sh run \
 *     npx playwright test -c tests/collab
 *
 * Covers: (a) two teachers type into the same page paragraph and both
 * converge, with both avatars shown; (b) on a deck, one teacher's slide is
 * locked for the other, who edits the next slide and the first sees it;
 * (c) the edits reach GitHub as a checkpoint commit (collab_docs settle with
 * pushed_version == version and the content repo HEAD moves).
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import {
  CLASSROOM_ID,
  CLASSROOM_SLUG,
  COLLAB_USERS,
  DECK_SLIDE_A_TEXT,
  DECK_SLIDE_B_TEXT,
  KITCHEN_SINK_DECK_TITLE,
  KITCHEN_SINK_PAGE_TITLE,
  PAGE_TARGET_TEXT,
} from '../../scripts/collab-dev/constants.ts';
import { PAGES_URL, SLIDES_URL, WEBAPP_URL, db, services, signIn } from './helpers.ts';

const [TEACHER_1, TEACHER_2] = COLLAB_USERS;
const RUN = Date.now().toString(36);
const PAGE_EDIT_1 = ` [p1-${RUN}]`;
const PAGE_EDIT_2 = ` [p2-${RUN}]`;
const SLIDE_EDIT_A = ` [a-${RUN}]`;
const SLIDE_EDIT_B = ` [b-${RUN}]`;

test.describe.configure({ mode: 'serial' });

test.describe('live editing', () => {
  test.skip(!process.env.COLLAB_E2E, 'Set COLLAB_E2E=1 with the dev stack running');

  let pageId = '';
  let deckId = '';
  let headBefore = '';

  async function contentRepo() {
    const prisma = await db();
    const classroom = await prisma.classroom.findUniqueOrThrow({
      where: { id: CLASSROOM_ID },
      include: { git_organization: true },
    });
    return { classroom, org: classroom.git_organization, repo: classroom.content_repo };
  }

  async function contentHead(): Promise<string> {
    const { getGitProvider } = await services();
    const { org, repo } = await contentRepo();
    const provider = getGitProvider(org);
    const branch = await provider.getDefaultBranch(org.login, repo);
    return provider.getLatestCommitSHA(org.login, repo, branch);
  }

  async function twoTeachers(browser: Browser): Promise<[BrowserContext, BrowserContext]> {
    const one = await browser.newContext();
    const two = await browser.newContext();
    await signIn(one, TEACHER_1.login);
    await signIn(two, TEACHER_2.login);
    return [one, two];
  }

  test.beforeAll(async () => {
    const prisma = await db();
    const classroom = await prisma.classroom.findUniqueOrThrow({ where: { id: CLASSROOM_ID } });
    expect(classroom.collab_enabled, 'run scripts/collab-dev/seed.ts first').toBe(true);
    const page = await prisma.page.findFirstOrThrow({
      where: { classroom_id: CLASSROOM_ID, title: KITCHEN_SINK_PAGE_TITLE },
    });
    const deck = await prisma.slide.findFirstOrThrow({
      where: { classroom_id: CLASSROOM_ID, title: KITCHEN_SINK_DECK_TITLE },
    });
    pageId = page.id;
    deckId = deck.id;
    headBefore = await contentHead();
  });

  test('test-login ?as= refuses unknown users and off-origin redirects', async ({ request }) => {
    const unknown = await request.get(`${WEBAPP_URL}/test-login?as=no-such-user-${RUN}`, {
      maxRedirects: 0,
    });
    expect(unknown.status()).toBe(404);

    const offOrigin = await request.get(
      `${WEBAPP_URL}/test-login?as=${TEACHER_1.login}&redirect=${encodeURIComponent('//evil.example')}`,
      { maxRedirects: 0 }
    );
    expect(offOrigin.status()).toBe(302);
    expect(offOrigin.headers()['location']).toBe(`/teacher/${CLASSROOM_SLUG}/dashboard`);
  });

  test('page: two teachers type in one paragraph and converge', async ({ browser }) => {
    const [one, two] = await twoTeachers(browser);
    const p1 = await one.newPage();
    const p2 = await two.newPage();
    const url = `${PAGES_URL}/${CLASSROOM_SLUG}/${pageId}`;
    await Promise.all([p1.goto(url), p2.goto(url)]);

    for (const p of [p1, p2]) {
      await expect(p.getByTestId('live-sync-status')).toHaveAttribute('data-status', 'synced', {
        timeout: 30_000,
      });
    }

    // Both people show up in each other's header (self included).
    await expect(p1.getByTestId('live-peers').getByLabel(TEACHER_2.name)).toBeVisible();
    await expect(p2.getByTestId('live-peers').getByLabel(TEACHER_1.name)).toBeVisible();

    const target = (p: Page) =>
      p.locator('[data-content-type="paragraph"]', { hasText: PAGE_TARGET_TEXT }).first();

    await target(p1).click();
    await p1.keyboard.press('End');
    await p1.keyboard.type(PAGE_EDIT_1, { delay: 20 });
    await expect(target(p2)).toContainText(PAGE_EDIT_1.trim());

    await target(p2).click();
    await p2.keyboard.press('End');
    await p2.keyboard.type(PAGE_EDIT_2, { delay: 20 });

    for (const p of [p1, p2]) {
      await expect(target(p)).toContainText(PAGE_EDIT_1.trim());
      await expect(target(p)).toContainText(PAGE_EDIT_2.trim());
    }
    const [text1, text2] = await Promise.all([target(p1).innerText(), target(p2).innerText()]);
    expect(text1).toBe(text2);

    await one.close();
    await two.close();
  });

  test('deck: a held slide is locked for the other teacher; edits elsewhere sync', async ({
    browser,
  }) => {
    const [one, two] = await twoTeachers(browser);
    const p1 = await one.newPage();
    const p2 = await two.newPage();
    const deckUrl = `${SLIDES_URL}/${deckId}?mode=edit`;
    const present = (p: Page) => p.locator('.reveal .slides > section.present');
    const goTo = async (p: Page, index: number) => {
      await p.evaluate(i => {
        window.location.hash = `#/${i}`;
      }, index);
      await expect(present(p)).toContainText(index === 1 ? 'Editable slide A' : 'Editable slide B');
    };

    await Promise.all([p1.goto(`${deckUrl}#/1`), p2.goto(`${deckUrl}#/1`)]);
    for (const p of [p1, p2]) {
      await expect(p.getByTestId('live-sync-status')).toHaveAttribute('data-status', 'synced', {
        timeout: 30_000,
      });
    }

    // Teacher 1 takes slide 2 by editing it.
    await present(p1).getByText(DECK_SLIDE_A_TEXT).click();
    await p1.keyboard.press('End');
    await p1.keyboard.type(SLIDE_EDIT_A, { delay: 20 });

    // Teacher 2 sees the lock and cannot type there.
    const badge = p2.getByTestId('slide-lock-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('data-holder', TEACHER_1.name);
    await expect(present(p2)).toHaveAttribute('contenteditable', 'false');
    await present(p2).getByText(DECK_SLIDE_A_TEXT).click({ force: true });
    await p2.keyboard.type(' should-not-land');
    await expect(present(p2)).not.toContainText('should-not-land');

    // Teacher 2 edits slide 3; teacher 1 sees it arrive.
    await goTo(p2, 2);
    await present(p2).getByText(DECK_SLIDE_B_TEXT).click();
    await p2.keyboard.press('End');
    await p2.keyboard.type(SLIDE_EDIT_B, { delay: 20 });

    await goTo(p1, 2);
    await expect(present(p1)).toContainText(SLIDE_EDIT_B.trim(), { timeout: 20_000 });
    // And teacher 1's own edit on slide 2 reached teacher 2.
    await goTo(p2, 1);
    await expect(present(p2)).toContainText(SLIDE_EDIT_A.trim(), { timeout: 20_000 });
    await expect(present(p1)).not.toContainText('should-not-land');

    await one.close();
    await two.close();
  });

  test('checkpoint: the edits land on GitHub', async () => {
    const prisma = await db();

    // Debounced checkpoint (dev: 10 s delay, 30 s max) → settled rows.
    await expect
      .poll(
        async () => {
          const rows = await prisma.collabDoc.findMany({
            where: {
              OR: [
                { kind: 'page', doc_id: pageId },
                { kind: 'deck', doc_id: deckId },
              ],
            },
            select: { kind: true, version: true, pushed_version: true, pushed_commit: true },
          });
          return (
            rows.length === 2 &&
            rows.every(r => r.version > 0 && r.pushed_version === r.version && r.pushed_commit)
          );
        },
        { timeout: 150_000, intervals: [2_000, 5_000] }
      )
      .toBe(true);

    const head = await contentHead();
    expect(head).not.toBe(headBefore);

    // The thing itself, not the counters: GitHub's content.json and deck.json
    // carry both people's edits.
    const { ContentService } = await services();
    const { org, repo } = await contentRepo();
    const page = await prisma.page.findUniqueOrThrow({ where: { id: pageId } });
    const deck = await prisma.slide.findUniqueOrThrow({ where: { id: deckId } });
    const pageFile = await ContentService.getContent({
      gitOrganization: org,
      repo,
      path: `${page.content_path}/content.json`,
      skipCache: true,
    });
    const deckFile = await ContentService.getContent({
      gitOrganization: org,
      repo,
      path: `${deck.content_path}/deck.json`,
      skipCache: true,
    });
    expect(pageFile?.content).toContain(PAGE_EDIT_1.trim());
    expect(pageFile?.content).toContain(PAGE_EDIT_2.trim());
    expect(deckFile?.content).toContain(SLIDE_EDIT_A.trim());
    expect(deckFile?.content).toContain(SLIDE_EDIT_B.trim());
  });
});
