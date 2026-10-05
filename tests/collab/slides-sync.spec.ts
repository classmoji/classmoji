/**
 * Live deck editor — sync repros (two people, the kitchen-sink deck).
 *
 * Needs the dev stack (collab + trigger:dev) on the devport, the collab seed,
 * ENABLE_TEST_LOGIN=true. Opt-in, like the rest of this suite:
 *
 *   COLLAB_E2E=1 npx dotenv -e .env -- ./scripts/devport.sh run \
 *     npx playwright test -c tests/collab slides-sync
 *
 * Pinned: (1) a slide that changes hands never loses the last holder's edit —
 * it shows while the slide is held, even with the other person's caret
 * resting in it, and their release does not let a stale DOM overwrite it;
 * (2) Done keeps edits that are still waiting (offline) instead of dropping
 * them; (5) undo takes back only your own step, which the other editor sees.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import {
  CLASSROOM_ID,
  COLLAB_USERS,
  KITCHEN_SINK_DECK_TITLE,
} from '../../scripts/collab-dev/constants.ts';
import { SLIDES_URL, db, signIn } from './helpers.ts';

const [TEACHER_1, TEACHER_2] = COLLAB_USERS;
const RUN = Date.now().toString(36).slice(-5);
const SKIP_REASON = 'Set COLLAB_E2E=1 with the dev stack running';

/** Slide index → the section the test types into (the deck's two editable slides). */
const SLIDE_A = 1;
const SLIDE_B = 2;

async function twoTeachers(browser: Browser): Promise<[BrowserContext, BrowserContext]> {
  const one = await browser.newContext();
  const two = await browser.newContext();
  await signIn(one, TEACHER_1.login);
  await signIn(two, TEACHER_2.login);
  return [one, two];
}

async function openEditor(page: Page, deckId: string, h: number) {
  // A dev-server load can stall before it hydrates: up to three tries.
  for (let attempt = 1; ; attempt++) {
    try {
      // A fresh navigation each time: the page drops ?mode=edit once read.
      await page.goto(`${SLIDES_URL}/${deckId}?mode=edit&try=${attempt}#/${h}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await expect(page.getByTestId('live-sync-status').first()).toHaveAttribute(
        'data-status',
        'synced',
        { timeout: 40_000 }
      );
      await page.locator('.reveal.ready .slides section.present').first().waitFor();
      await page
        .locator('.reveal .slides section[contenteditable]')
        .first()
        .waitFor({ state: 'attached' });
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

/** The id of the h-th top-level slide. */
const slideId = (page: Page, h: number) =>
  page.evaluate(
    h => document.querySelectorAll('.reveal .slides > section')[h]?.getAttribute('data-cm-id'),
    h
  ) as Promise<string>;

const section = (page: Page, id: string) =>
  page.locator(`.reveal .slides section[data-cm-id="${id}"]`);

/** Focus the slide and put the caret at the end of its first paragraph. */
async function caretAtEnd(page: Page, id: string) {
  await section(page, id).locator('p').first().click();
  await page.evaluate(id => {
    const p = document.querySelector(`.reveal .slides section[data-cm-id="${id}"] p`) as Element;
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) last = n as Text;
    (p.closest('section') as HTMLElement).focus();
    if (last) window.getSelection()?.collapse(last, last.length);
  }, id);
}

test.describe('live deck sync', () => {
  test.skip(!process.env.COLLAB_E2E, SKIP_REASON);
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let deckId = '';

  test.beforeAll(async () => {
    const prisma = await db();
    const deck = await prisma.slide.findFirstOrThrow({
      where: { classroom_id: CLASSROOM_ID, title: KITCHEN_SINK_DECK_TITLE },
    });
    deckId = deck.id;
  });

  test('a slide changing hands never loses the last holder’s edit', async ({ browser }) => {
    const [one, two] = await twoTeachers(browser);
    const a = await one.newPage();
    const b = await two.newPage();
    await openEditor(a, deckId, SLIDE_A);
    await openEditor(b, deckId, SLIDE_A);
    const id = await slideId(a, SLIDE_A);

    // B takes the slide; A's caret rests in it (read-only for A).
    await caretAtEnd(b, id);
    await b.keyboard.type(` [B1-${RUN}]`, { delay: 20 });
    await expect(section(a, id)).toContainText(`B1-${RUN}`);
    await expect(section(a, id)).toHaveAttribute('contenteditable', 'false');
    await section(a, id).locator('p').first().click();
    await b.keyboard.type(` [B2-${RUN}]`, { delay: 20 });
    await expect(section(a, id)).toContainText(`B2-${RUN}`);

    // B's last keystrokes and its release land together (Done inside the debounce).
    await b.keyboard.type(` [B3-${RUN}]`, { delay: 10 });
    await b.getByRole('button', { name: 'Done' }).click();
    await expect(section(a, id)).toHaveAttribute('contenteditable', 'true');

    // A types where its caret was: B3 must survive.
    await caretAtEnd(a, id);
    await a.keyboard.type(` [A1-${RUN}]`, { delay: 30 });
    await expect(section(a, id)).toContainText(`B3-${RUN}`);
    await expect(section(a, id)).toContainText(`A1-${RUN}`);
    // B (view mode after Done) follows the live deck: both are there.
    await expect(section(b, id)).toContainText(`B3-${RUN}`, { timeout: 15_000 });
    await expect(section(b, id)).toContainText(`A1-${RUN}`, { timeout: 15_000 });

    await a.getByRole('button', { name: 'Done' }).click();
    await one.close();
    await two.close();
  });

  test('Done keeps edits that are still waiting while offline', async ({ browser }) => {
    const [one] = await twoTeachers(browser);
    const a = await one.newPage();
    // Offline = the collab socket cut and refused (Chrome's offline mode
    // leaves an open WebSocket alone).
    let offline = false;
    const sockets: Array<{ close(): Promise<void> }> = [];
    await a.routeWebSocket(/:\d+\/?$/, ws => {
      if (offline) return void ws.close();
      const server = ws.connectToServer();
      sockets.push(ws, server);
    });
    await openEditor(a, deckId, SLIDE_B);
    const id = await slideId(a, SLIDE_B);
    const status = a.getByTestId('live-sync-status').first();

    await caretAtEnd(a, id);
    offline = true;
    for (const socket of sockets.splice(0)) await socket.close().catch(() => {});
    await expect(status).toHaveAttribute('data-status', 'offline');
    await caretAtEnd(a, id);
    await a.keyboard.type(` [off-${RUN}]`, { delay: 20 });

    await a.getByRole('button', { name: 'Done' }).click();
    await expect(a.getByRole('button', { name: 'Finishing…' })).toBeVisible();
    await expect(a.getByTestId('live-leave-dialog')).toBeVisible({ timeout: 10_000 });
    await a.getByRole('button', { name: 'Stay' }).click();
    await expect(section(a, id)).toContainText(`off-${RUN}`);

    offline = false;
    await expect(status).toHaveAttribute('data-status', 'synced', { timeout: 30_000 });
    await a.getByRole('button', { name: 'Done' }).click();
    await expect(a.getByRole('button', { name: 'Edit' })).toBeVisible({ timeout: 15_000 });
    await expect(section(a, id)).toContainText(`off-${RUN}`);
    await one.close();
  });

  test('undo takes back only my own step; the other editor sees it', async ({ browser }) => {
    const [one, two] = await twoTeachers(browser);
    const a = await one.newPage();
    const b = await two.newPage();
    await openEditor(a, deckId, SLIDE_B);
    await openEditor(b, deckId, SLIDE_B);
    const id = await slideId(a, SLIDE_B);

    await caretAtEnd(a, id);
    await a.keyboard.type(` [U1-${RUN}]`, { delay: 15 });
    await expect(section(b, id)).toContainText(`U1-${RUN}`);
    await caretAtEnd(a, id);
    await a.keyboard.type(` [U2-${RUN}]`, { delay: 15 });
    await expect(section(b, id)).toContainText(`U2-${RUN}`);

    await a.keyboard.press('ControlOrMeta+z');
    await expect(section(a, id)).not.toContainText(`U2-${RUN}`);
    await expect(section(a, id)).toContainText(`U1-${RUN}`);
    await expect(section(b, id)).not.toContainText(`U2-${RUN}`);
    await a.keyboard.press('ControlOrMeta+Shift+z');
    await expect(section(b, id)).toContainText(`U2-${RUN}`);

    await a.getByRole('button', { name: 'Done' }).click();
    await b.getByRole('button', { name: 'Done' }).click();
    await one.close();
    await two.close();
  });
});
