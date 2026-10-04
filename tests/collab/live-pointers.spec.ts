/**
 * Live pointers over a deck's slide in the live editor: a person's mouse
 * shows in everyone else's editor as an arrow in their colour with their
 * name, at the same spot on the slide whatever the window size; it glides
 * as they move, dims after a few seconds still, and goes when they leave
 * the slide. An agent's arrow (deck_cursor_set with x, y) sits where it
 * points and stays while the agent is present.
 *
 * Two people at different window sizes on the kitchen-sink deck; the agent
 * is played in-process through the MCP's collab client, as in
 * agent-activity.spec.ts. Opt-in:
 *
 *   COLLAB_E2E=1 npx dotenv -e .env -- ./scripts/devport.sh run \
 *     npx playwright test -c tests/collab live-pointers
 *
 * When the stack serves a public host (DEVPORT_PUBLIC_HOST), collab only
 * admits that origin: pass WEBAPP_URL / SLIDES_URL on that host too
 * (`... devport.sh run env WEBAPP_URL=http://<host>:3010 SLIDES_URL=... npx playwright ...`).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { CollabActor } from '@classmoji/collab';

import {
  CLASSROOM_ID,
  COLLAB_USERS,
  KITCHEN_SINK_DECK_TITLE,
} from '../../scripts/collab-dev/constants.ts';
import { SLIDES_URL, db, signIn } from './helpers.ts';

const [TEACHER_1, TEACHER_2] = COLLAB_USERS;
const RUN = Date.now().toString(36);
const SKIP_REASON = 'Set COLLAB_E2E=1 with the dev stack running';
const SLIDE = { width: 960, height: 700 };

type CollabClient = typeof import('../../apps/mcp/src/collab/client.ts');
type CollabEnv = NonNullable<ReturnType<typeof import('@classmoji/collab/env').resolveCollabEnv>>;

/**
 * Open the live deck editor; a dev-server load that never hydrates is loaded
 * again (from the URL: the editor drops `?mode=edit` once it has read it).
 */
async function openLive(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    try {
      await expect(page.getByTestId('live-sync-status').first()).toHaveAttribute(
        'data-status',
        'synced',
        { timeout: 40_000 }
      );
      // The live editor itself (a lazy chunk) is up, with its pointer layer.
      await page.locator('.reveal .slides section[contenteditable]').first().waitFor({
        state: 'attached',
        timeout: 40_000,
      });
      await page.locator('.reveal.ready .slides section.present').first().waitFor({
        timeout: 20_000,
      });
      await page.getByTestId('live-pointers').waitFor({ state: 'attached', timeout: 10_000 });
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}

/** The slide on screen once Reveal has settled on it. */
async function settledSlide(page: Page): Promise<string> {
  const shown = () =>
    page.evaluate(
      () =>
        document.querySelector('.reveal .slides section.present')?.getAttribute('data-cm-id') ?? ''
    );
  let current = await shown();
  await expect
    .poll(
      async () => {
        const before = current;
        await page.waitForTimeout(500);
        current = await shown();
        return current !== '' && current === before;
      },
      { timeout: 10_000 }
    )
    .toBe(true);
  return current;
}

/** Where the slide box is drawn. */
const slideRect = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector('.reveal .slides')!.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });

/** A slide point on this page's screen. */
async function toScreen(page: Page, x: number, y: number) {
  const r = await slideRect(page);
  return { x: r.left + (x / SLIDE.width) * r.width, y: r.top + (y / SLIDE.height) * r.height };
}

/** Every arrow drawn, with where its tip is on screen. */
const arrows = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="live-pointer"]')].map(el => {
      const r = el.getBoundingClientRect();
      const name = el.querySelector<HTMLElement>('[data-testid="live-pointer-name"]');
      return {
        name: el.dataset.name ?? '',
        agent: el.dataset.agent === 'true',
        resting: el.dataset.resting === 'true',
        tip: { x: r.left, y: r.top },
        transition: getComputedStyle(el).transitionProperty,
        nameOpacity: name ? Number(getComputedStyle(name).opacity) : null,
      };
    })
  );

const peerLabels = (page: Page) =>
  page
    .getByTestId('live-peers')
    .locator('[aria-label]')
    .evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label') ?? ''));

/** Wait out this person's agent sessions from an earlier run (each stays a minute). */
async function noAgentsOf(page: Page, name: string): Promise<void> {
  await expect
    .poll(async () => (await peerLabels(page)).filter(l => l.startsWith(`${name} (agent`)), {
      timeout: 75_000,
      intervals: [1_000],
    })
    .toEqual([]);
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

test.describe('live pointers', () => {
  test.skip(!process.env.COLLAB_E2E, SKIP_REASON);
  test.describe.configure({ mode: 'serial' });

  let deckId = '';
  let teacherOneName = '';
  let client: CollabClient;
  let env: CollabEnv;
  let agent: CollabActor;

  test.beforeAll(async () => {
    const prisma = await db();
    const deck = await prisma.slide.findFirstOrThrow({
      where: { classroom_id: CLASSROOM_ID, title: KITCHEN_SINK_DECK_TITLE },
    });
    deckId = deck.id;
    const teacher1 = await prisma.user.findFirstOrThrow({ where: { email: TEACHER_1.email } });
    const teacher2 = await prisma.user.findFirstOrThrow({ where: { email: TEACHER_2.email } });
    teacherOneName = teacher1.name ?? TEACHER_1.name;
    client = await import('../../apps/mcp/src/collab/client.ts');
    const { resolveCollabEnv } = await import('@classmoji/collab/env');
    const resolved = resolveCollabEnv();
    expect(resolved, 'COLLAB_URL / COLLAB_INTERNAL_SECRET (run through devport.sh)').toBeTruthy();
    env = resolved!;
    agent = {
      userId: teacher2.id,
      name: teacher2.name ?? TEACHER_2.name,
      agentSession: `e2e-pointer-${RUN}`,
    };
  });

  async function person(
    browser: import('@playwright/test').Browser,
    login: string,
    viewport: { width: number; height: number }
  ): Promise<{ context: BrowserContext; page: Page }> {
    // A dev-server load can stall on one module for good in a context; a
    // fresh context loads it again.
    for (let attempt = 1; ; attempt++) {
      const context = await browser.newContext({ viewport });
      try {
        await signIn(context, login);
        const page = await context.newPage();
        await openLive(page, `${SLIDES_URL}/${deckId}?mode=edit#/2`);
        return { context, page };
      } catch (error) {
        await context.close();
        if (attempt >= 3) throw error;
      }
    }
  }

  test("a person's pointer shows at the same slide spot in another window, glides, rests, and goes", async ({
    browser,
  }) => {
    test.setTimeout(420_000);
    const a = await person(browser, TEACHER_1.login, { width: 1400, height: 950 });
    const b = await person(browser, TEACHER_2.login, { width: 1000, height: 720 });
    try {
      const slideA = await settledSlide(a.page);
      const slideB = await settledSlide(b.page);
      expect(slideB).toBe(slideA);

      const mine = async () => (await arrows(b.page)).filter(p => p.name === teacherOneName);

      // A points at (240, 180) on the slide.
      let target = await toScreen(a.page, 240, 180);
      await a.page.mouse.move(target.x, target.y, { steps: 4 });
      await expect.poll(async () => (await mine()).length, { timeout: 5_000 }).toBe(1);
      // B draws it at the same slide spot, in its own (smaller) window.
      let expected = await toScreen(b.page, 240, 180);
      await expect
        .poll(async () => distance((await mine())[0].tip, expected), { timeout: 3_000 })
        .toBeLessThan(20);
      // Never your own (an agent from an earlier run may still be present).
      expect((await arrows(a.page)).filter(p => !p.agent)).toEqual([]);

      // A moves: B's arrow follows, gliding (a transform transition).
      const before = (await mine())[0].tip;
      target = await toScreen(a.page, 720, 520);
      await a.page.mouse.move(target.x, target.y, { steps: 12 });
      expected = await toScreen(b.page, 720, 520);
      await expect
        .poll(async () => distance((await mine())[0].tip, expected), { timeout: 3_000 })
        .toBeLessThan(20);
      const moved = (await mine())[0];
      expect(distance(moved.tip, before)).toBeGreaterThan(100);
      expect(moved.transition).toContain('transform');
      expect(moved.resting).toBe(false);
      expect(moved.nameOpacity).toBe(1);

      // Still for a few seconds: the arrow dims and its name hides, it stays put.
      await expect.poll(async () => (await mine())[0]?.resting, { timeout: 8_000 }).toBe(true);
      await expect.poll(async () => (await mine())[0]?.nameOpacity, { timeout: 2_000 }).toBe(0);
      // Moving again wakes it.
      target = await toScreen(a.page, 700, 500);
      await a.page.mouse.move(target.x, target.y, { steps: 3 });
      await expect.poll(async () => (await mine())[0]?.resting, { timeout: 3_000 }).toBe(false);

      // Off the slide area (to the top bar): gone.
      await a.page.mouse.move(4, 4, { steps: 3 });
      await expect.poll(async () => (await mine()).length, { timeout: 3_000 }).toBe(0);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test("an agent's arrow sits where deck_cursor_set points and moves when it points again", async ({
    browser,
  }) => {
    test.setTimeout(420_000);
    const b = await person(browser, TEACHER_1.login, { width: 1200, height: 860 });
    try {
      await noAgentsOf(b.page, agent.name);
      const slide = await settledSlide(b.page);
      const label = `${agent.name} (agent)`;
      const agentArrows = async () => (await arrows(b.page)).filter(p => p.name === label);

      expect(
        await client.postCursor(env, 'deck', deckId, { actor: agent, slide, x: 200, y: 150 })
      ).toEqual({ shown: true });
      await expect.poll(async () => (await agentArrows()).length, { timeout: 3_000 }).toBe(1);
      let expected = await toScreen(b.page, 200, 150);
      await expect
        .poll(async () => distance((await agentArrows())[0].tip, expected), { timeout: 3_000 })
        .toBeLessThan(20);
      expect((await agentArrows())[0].agent).toBe(true);

      // Pointing again moves it; an agent's arrow does not rest.
      await client.postCursor(env, 'deck', deckId, { actor: agent, slide, x: 800, y: 600 });
      expected = await toScreen(b.page, 800, 600);
      await expect
        .poll(async () => distance((await agentArrows())[0].tip, expected), { timeout: 3_000 })
        .toBeLessThan(20);
      await b.page.waitForTimeout(6_000);
      const still = (await agentArrows())[0];
      expect(still.resting).toBe(false);
      expect(still.nameOpacity).toBe(1);

      // No spot named: the slide's centre.
      await client.postCursor(env, 'deck', deckId, { actor: agent, slide });
      expected = await toScreen(b.page, 480, 350);
      await expect
        .poll(async () => distance((await agentArrows())[0].tip, expected), { timeout: 3_000 })
        .toBeLessThan(20);
    } finally {
      await b.context.close();
    }
  });
});
