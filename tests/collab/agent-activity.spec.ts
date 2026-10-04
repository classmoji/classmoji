/**
 * Agents in a live document, as a person in the editor sees them: the blocks
 * and slides an agent's edit touched are marked in its colour for a few
 * seconds; on a page its caret sits at the end of what it wrote, moves when
 * it points elsewhere, and stays while it is present (about a minute); two
 * agent sessions of one person are two carets in two colours.
 *
 * The agent is played in-process: the MCP's own collab client (`postOps`,
 * `postCursor`) against the devport collab server, acting as TEACHER_2 with
 * two agent session ids. Opt-in like live-editing.spec.ts:
 *
 *   COLLAB_E2E=1 npx dotenv -e .env -- ./scripts/devport.sh run \
 *     npx playwright test -c tests/collab agent-activity
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { CollabActor } from '@classmoji/collab';

import {
  CLASSROOM_ID,
  CLASSROOM_SLUG,
  COLLAB_USERS,
  KITCHEN_SINK_DECK_TITLE,
  KITCHEN_SINK_PAGE_TITLE,
} from '../../scripts/collab-dev/constants.ts';
import { PAGES_URL, SLIDES_URL, db, signIn } from './helpers.ts';

const [TEACHER_1, TEACHER_2] = COLLAB_USERS;
const RUN = Date.now().toString(36);
const SKIP_REASON = 'Set COLLAB_E2E=1 with the dev stack running';

type CollabClient = typeof import('../../apps/mcp/src/collab/client.ts');
type CollabEnv = NonNullable<ReturnType<typeof import('@classmoji/collab/env').resolveCollabEnv>>;

const para = (id: string, text: string) => ({
  id,
  type: 'paragraph',
  props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' },
  content: [{ type: 'text', text, styles: {} }],
  children: [],
});

/** Open a live editor; a dev-server load that never hydrates is reloaded. */
async function openLive(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    if (attempt === 1) await page.goto(url, { waitUntil: 'domcontentloaded' });
    else await page.reload({ waitUntil: 'domcontentloaded' });
    try {
      await expect(page.getByTestId('live-sync-status').first()).toHaveAttribute(
        'data-status',
        'synced',
        { timeout: 40_000 }
      );
      // The editor itself (a lazy chunk) is up, not only the room.
      await page
        .locator(
          url.includes('mode=edit')
            ? '.reveal.ready .slides section.present[contenteditable]'
            : '.page-editor .ProseMirror'
        )
        .first()
        .waitFor({ timeout: 40_000 });
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
    }
  }
}

/** The `::after` chip text and the tint of a page block. */
function blockMark(page: Page, id: string) {
  return page.evaluate(id => {
    const el = document.querySelector(`.page-editor .bn-block[data-id="${id}"]`);
    if (!el) return null;
    return {
      chip: getComputedStyle(el, '::after').content,
      tint: getComputedStyle(el).backgroundColor,
    };
  }, id);
}

/** Every remote caret: its label, colour, block, and whether it sits at the end of the block's text. */
function carets(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.bn-collaboration-cursor__base')].map(base => {
      const label = base.querySelector('.bn-collaboration-cursor__label')?.textContent ?? '';
      const caret = base.querySelector('.bn-collaboration-cursor__caret') as HTMLElement | null;
      const block = base.closest('.bn-block');
      const inline = block?.querySelector('.bn-inline-content');
      let before = '';
      let after = '';
      if (inline && inline.contains(base)) {
        const range = document.createRange();
        range.setStart(inline, 0);
        range.setEndBefore(base);
        before = range.toString();
        range.setStartAfter(base);
        range.setEnd(inline, inline.childNodes.length);
        after = range.toString();
      }
      const clean = (s: string) => s.replace(/⁠/g, '');
      return {
        label,
        color: caret ? getComputedStyle(caret).backgroundColor : '',
        block: block?.getAttribute('data-id') ?? null,
        before: clean(before),
        after: clean(after),
      };
    })
  );
}

const peerLabels = (page: Page) =>
  page
    .getByTestId('live-peers')
    .locator('[aria-label]')
    .evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label') ?? ''));

/**
 * Wait out agent sessions of this person left by an earlier run (each stays a
 * minute), so the labels below are numbered from this run's sessions only.
 */
async function noAgentsOf(page: Page, name: string): Promise<void> {
  await expect
    .poll(async () => (await peerLabels(page)).filter(l => l.startsWith(`${name} (agent`)), {
      timeout: 75_000,
      intervals: [1_000],
    })
    .toEqual([]);
}

test.describe('agent activity', () => {
  test.skip(!process.env.COLLAB_E2E, SKIP_REASON);
  test.describe.configure({ mode: 'serial' });

  let pageId = '';
  let deckId = '';
  let client: CollabClient;
  let env: CollabEnv;
  let agentA: CollabActor;
  let agentB: CollabActor;

  test.beforeAll(async () => {
    const prisma = await db();
    const page = await prisma.page.findFirstOrThrow({
      where: { classroom_id: CLASSROOM_ID, title: KITCHEN_SINK_PAGE_TITLE },
    });
    const deck = await prisma.slide.findFirstOrThrow({
      where: { classroom_id: CLASSROOM_ID, title: KITCHEN_SINK_DECK_TITLE },
    });
    const teacher2 = await prisma.user.findFirstOrThrow({ where: { email: TEACHER_2.email } });
    pageId = page.id;
    deckId = deck.id;
    // After db(): the client imports the service layer, which needs DATABASE_URL.
    client = await import('../../apps/mcp/src/collab/client.ts');
    const { resolveCollabEnv } = await import('@classmoji/collab/env');
    const resolved = resolveCollabEnv();
    expect(resolved, 'COLLAB_URL / COLLAB_INTERNAL_SECRET (run through devport.sh)').toBeTruthy();
    env = resolved!;
    const name = teacher2.name ?? TEACHER_2.name;
    agentA = { userId: teacher2.id, name, agentSession: `e2e-a-${RUN}` };
    agentB = { userId: teacher2.id, name, agentSession: `e2e-b-${RUN}` };
  });

  async function teacherOne(browser: import('@playwright/test').Browser): Promise<BrowserContext> {
    const context = await browser.newContext();
    await signIn(context, TEACHER_1.login);
    return context;
  }

  test('page: the edit is marked, the caret ends the text, sessions differ, presence stays', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const context = await teacherOne(browser);
    const page = await context.newPage();
    await openLive(page, `${PAGES_URL}/${CLASSROOM_SLUG}/${pageId}`);
    await noAgentsOf(page, agentA.name);

    const idA = `agent-a-${RUN}`;
    const idB = `agent-b-${RUN}`;
    const textA = `Written by agent A ${RUN}`;
    try {
      await client.postOps(
        env,
        'page',
        pageId,
        [{ op: 'insert', blocks: [para(idA, textA)], position: { at: 'end' } }],
        agentA
      );
      const lastOpAt = Date.now();

      // Within a second: the block is marked with the agent's name…
      await expect
        .poll(async () => (await blockMark(page, idA))?.chip ?? '', { timeout: 1_000 })
        .toContain(`${agentA.name} (agent)`);
      const mark = await blockMark(page, idA);
      expect(mark?.tint).not.toBe('rgba(0, 0, 0, 0)');
      // …and its caret sits at the end of what it wrote.
      await expect
        .poll(async () => (await carets(page)).find(c => c.block === idA), { timeout: 1_000 })
        .toMatchObject({ label: `${agentA.name} (agent)`, before: textA, after: '' });

      // The mark fades and goes after ~5 s; the agent is still here.
      await expect
        .poll(async () => (await blockMark(page, idA))?.chip, { timeout: 8_000 })
        .toBe('none');
      expect(await peerLabels(page)).toContain(`${agentA.name} (agent)`);

      // A second session of the same person: numbered, its own caret and colour.
      await client.postOps(
        env,
        'page',
        pageId,
        [
          {
            op: 'insert',
            blocks: [para(idB, `Written by agent B ${RUN}`)],
            position: { at: 'end' },
          },
        ],
        agentB
      );
      await expect
        .poll(async () => (await carets(page)).map(c => c.label).sort(), { timeout: 3_000 })
        .toEqual([`${agentA.name} (agent 1)`, `${agentA.name} (agent 2)`]);
      const both = await carets(page);
      expect(new Set(both.map(c => c.color)).size).toBe(2);
      await expect
        .poll(() => peerLabels(page))
        .toEqual(expect.arrayContaining([`${agentA.name} (agent 1)`, `${agentA.name} (agent 2)`]));

      // Pointing elsewhere moves the caret (page_cursor_set does this).
      const shown = await client.postCursor(env, 'page', pageId, {
        actor: agentA,
        page: { blockId: idA, at: 'start' },
      });
      expect(shown).toEqual({ shown: true });
      await expect
        .poll(async () => (await carets(page)).find(c => c.label.endsWith('(agent 1)')), {
          timeout: 2_000,
        })
        .toMatchObject({ block: idA, before: '', after: textA });

      // Present for about a minute after its last op or move: still there at 50 s…
      const pointedAt = Date.now();
      await page.waitForTimeout(Math.max(0, pointedAt + 50_000 - Date.now()));
      expect((await peerLabels(page)).some(l => l.startsWith(`${agentA.name} (agent`))).toBe(true);
      expect((await carets(page)).length).toBeGreaterThan(0);
      // …and gone by about 65 s.
      await expect
        .poll(
          async () => (await peerLabels(page)).filter(l => l.startsWith(`${agentA.name} (agent`)),
          { timeout: 20_000, intervals: [1_000] }
        )
        .toEqual([]);
      expect(Date.now() - lastOpAt).toBeGreaterThan(55_000);
    } finally {
      const snapshot = await client.fetchSnapshot(env, 'page', pageId);
      const ids = new Set<string>();
      const walk = (blocks: Array<{ id?: string; children?: unknown[] }>) => {
        for (const b of blocks) {
          if (b.id) ids.add(b.id);
          walk((b.children ?? []) as typeof blocks);
        }
      };
      walk(snapshot.content.blocks as Array<{ id?: string }>);
      const leftovers = [idA, idB].filter(id => ids.has(id));
      if (leftovers.length > 0) {
        await client.postOps(
          env,
          'page',
          pageId,
          leftovers.map(id => ({ op: 'delete', id })),
          { userId: agentA.userId, name: agentA.name, agentSession: `e2e-cleanup-${RUN}` }
        );
      }
      await context.close();
    }
  });

  test('deck: a changed slide is framed in the agent colour, then the frame goes', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const context = await teacherOne(browser);
    const page = await context.newPage();
    await openLive(page, `${SLIDES_URL}/${deckId}?mode=edit#/2`);
    await noAgentsOf(page, agentA.name);
    // The slide on screen once Reveal has settled on it (the hash route lands after load).
    const shown = () =>
      page.evaluate(
        () =>
          document.querySelector('.reveal .slides section.present')?.getAttribute('data-cm-id') ??
          ''
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
    expect(current).not.toBe('');

    // Rewrite the shown slide with its own html: a change to show, none to clean up.
    const snapshot = await client.fetchSnapshot(env, 'deck', deckId);
    const all = snapshot.content.slides.flatMap(s => [s, ...(s.children ?? [])]);
    const slide = all.find(s => s.id === current);
    expect(slide?.html).toBeTruthy();
    await client.postOps(
      env,
      'deck',
      deckId,
      [{ op: 'update', id: current, html: slide!.html }],
      agentA
    );

    // One look at the frame and the chip together (they fade and go after ~5 s).
    await expect
      .poll(
        () =>
          page.evaluate(() => ({
            frames: [...document.querySelectorAll('[data-testid="agent-touch"]')].map(n =>
              n.getAttribute('data-agent-name')
            ),
            chip: document.querySelector('[data-testid="agent-touch-chip"]')?.textContent ?? null,
          })),
        { timeout: 2_000, intervals: [100] }
      )
      .toEqual({ frames: [`${agentA.name} (agent)`], chip: `${agentA.name} (agent)` });
    await expect(page.getByTestId('agent-touch')).toHaveCount(0, { timeout: 8_000 });

    // Pointing at the shown slide puts the agent's avatar on it.
    await client.postCursor(env, 'deck', deckId, { actor: agentA, slide: current });
    await expect(page.getByTestId('slide-peers').getByLabel(`${agentA.name} (agent)`)).toBeVisible({
      timeout: 2_000,
    });
    await context.close();
  });
});
