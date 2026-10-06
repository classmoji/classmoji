/**
 * Two people in one live page, where the CRDT alone is not enough:
 *
 * - Multi-column: two editors each delete a different column of the same
 *   three-column list at once. Each edit alone is fine; merged, the list is
 *   left with one column, which BlockNote cannot load. The collab server
 *   repairs it (unwraps the list) and both editors converge on the remaining
 *   column's content, with no broken list left in the document.
 * - Undo: undo takes back only your own edits, never someone else's.
 *
 * A live page takes no NEW column layout, from an agent or from the editor,
 * so the three-column list comes the one way a live page still gains one: a
 * commit to the page's content.json in git, merged in as an outside push (a
 * room that is not open seeds from it instead). It is removed afterwards by
 * an in-process agent (the MCP's collab client, as agent-activity.spec.ts
 * does) — deleting an existing layout is allowed. Opt-in:
 *
 *   COLLAB_E2E=1 npx dotenv -e .env -- ./scripts/devport.sh run \
 *     npx playwright test -c tests/collab page-columns-undo
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { COLLAB_INTERNAL_PREFIX, COLLAB_SECRET_HEADER, type CollabActor } from '@classmoji/collab';

import {
  CLASSROOM_ID,
  CLASSROOM_SLUG,
  COLLAB_USERS,
  KITCHEN_SINK_PAGE_TITLE,
} from '../../scripts/collab-dev/constants.ts';
import { caretToBlockEnd, db, PAGES_URL, services, signIn } from './helpers.ts';

const [TEACHER_1, TEACHER_2] = COLLAB_USERS;
const RUN = Date.now().toString(36);
const SKIP_REASON = 'Set COLLAB_E2E=1 with the dev stack running';

type CollabClient = typeof import('../../apps/mcp/src/collab/client.ts');
type CollabEnv = NonNullable<ReturnType<typeof import('@classmoji/collab/env').resolveCollabEnv>>;

interface Block {
  id?: string;
  type?: string;
  content?: unknown;
  children?: Block[];
}

const para = (id: string, text: string): Block & Record<string, unknown> => ({
  id,
  type: 'paragraph',
  props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' },
  content: [{ type: 'text', text, styles: {} }],
  children: [],
});

const column = (id: string, child: Block) => ({
  id,
  type: 'column',
  props: { width: 1 },
  children: [child],
});

/** Open a live page editor; a dev-server load that never hydrates is reloaded. */
async function openLive(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      if (attempt === 1) await page.goto(url, { waitUntil: 'domcontentloaded' });
      else await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('live-sync-status').first()).toHaveAttribute(
        'data-status',
        'synced',
        { timeout: 40_000 }
      );
      await page.locator('.page-editor .ProseMirror').first().waitFor({ timeout: 40_000 });
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
    }
  }
}

/** A block's text in the editor, without other people's carets. */
function blockText(page: Page, id: string): Promise<string | null> {
  return page.evaluate(id => {
    const el = document.querySelector(`.page-editor .bn-block[data-id="${id}"]`);
    if (!el) return null;
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[class*="collaboration-cursor"]').forEach(node => node.remove());
    return (copy.textContent ?? '').replace(/⁠/g, '');
  }, id);
}

/** Every column list in the editor, as its number of columns. */
function columnCounts(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.page-editor .bn-block-column-list')].map(
      list => list.querySelectorAll(':scope > .bn-block-column').length
    )
  );
}

/** Delete a block through its side menu (drag handle → Delete), as a person does. */
async function deleteBlockByMenu(page: Page, id: string): Promise<void> {
  const text = page.locator(`.page-editor .bn-block[data-id="${id}"] .bn-inline-content`).first();
  const del = page.getByRole('menuitem', { name: 'Delete' });
  for (let attempt = 1; ; attempt++) {
    // A fresh mouse move over the block, or the side menu stays on another one.
    await page.mouse.move(0, 0);
    await text.hover();
    const handle = page.getByRole('button', { name: 'Open block menu' });
    await handle.waitFor({ state: 'visible' });
    await handle.click();
    try {
      await del.waitFor({ state: 'visible', timeout: 3_000 });
      await del.click();
      return;
    } catch (error) {
      await page.keyboard.press('Escape');
      if (attempt >= 3) throw error;
    }
  }
}

test.describe('two editors, one page', () => {
  test.skip(!process.env.COLLAB_E2E, SKIP_REASON);

  let pageId = '';
  let client: CollabClient;
  let env: CollabEnv;
  let agent: CollabActor;
  const placed: string[] = [];

  test.beforeAll(async () => {
    const prisma = await db();
    const page = await prisma.page.findFirstOrThrow({
      where: { classroom_id: CLASSROOM_ID, title: KITCHEN_SINK_PAGE_TITLE },
    });
    const teacher1 = await prisma.user.findFirstOrThrow({ where: { email: TEACHER_1.email } });
    pageId = page.id;
    // After db(): the client imports the service layer, which needs DATABASE_URL.
    client = await import('../../apps/mcp/src/collab/client.ts');
    const { resolveCollabEnv } = await import('@classmoji/collab/env');
    const resolved = resolveCollabEnv();
    expect(resolved, 'COLLAB_URL / COLLAB_INTERNAL_SECRET (run through devport.sh)').toBeTruthy();
    env = resolved!;
    agent = {
      userId: teacher1.id,
      name: teacher1.name ?? TEACHER_1.name,
      agentSession: `e2e-columns-${RUN}`,
    };
  });

  /** Whatever this suite placed and is still in the page goes. */
  test.afterAll(async () => {
    if (!client || placed.length === 0) return;
    const snapshot = await client.fetchSnapshot(env, 'page', pageId);
    // The outermost placed blocks still there (deleting one takes its children).
    const leftovers: string[] = [];
    const walk = (blocks: Block[]) => {
      for (const block of blocks) {
        if (block.id && placed.includes(block.id)) leftovers.push(block.id);
        else walk(block.children ?? []);
      }
    };
    walk(snapshot.content.blocks as Block[]);
    if (leftovers.length > 0) {
      await client.postOps(
        env,
        'page',
        pageId,
        leftovers.map(id => ({ op: 'delete', id })),
        agent,
        null
      );
    }
  });

  /**
   * Cut and restore one page's live socket. Chromium's offline mode leaves an
   * open WebSocket alone, so the socket is routed through the test: offline
   * closes it and refuses reconnects until online again.
   */
  async function socketSwitch(page: Page) {
    let offline = false;
    const open = new Set<import('@playwright/test').WebSocketRoute>();
    await page.routeWebSocket(
      url => url.port === new URL(env.wsUrl).port,
      ws => {
        if (offline) {
          void ws.close({ code: 4000, reason: 'test offline' });
          return;
        }
        ws.connectToServer();
        open.add(ws);
        ws.onClose(() => open.delete(ws));
      }
    );
    return {
      set(next: boolean) {
        offline = next;
        if (next) for (const ws of open) void ws.close({ code: 4000, reason: 'test offline' });
      },
    };
  }

  async function twoEditors(browser: Browser, { switches = false } = {}) {
    const one = await browser.newContext();
    const two = await browser.newContext();
    await signIn(one, TEACHER_1.login);
    await signIn(two, TEACHER_2.login);
    const p1 = await one.newPage();
    const p2 = await two.newPage();
    const s1 = switches ? await socketSwitch(p1) : null;
    const s2 = switches ? await socketSwitch(p2) : null;
    const url = `${PAGES_URL}/${CLASSROOM_SLUG}/${pageId}`;
    await Promise.all([openLive(p1, url), openLive(p2, url)]);
    return { contexts: [one, two], p1, p2, s1, s2 };
  }

  /**
   * Commit `blocks` to the end of the page's content.json in git and tell the
   * live service, as hook-station does for a push from outside.
   */
  async function pushToGit(blocks: Block[]) {
    const prisma = await db();
    const { ClassmojiService, getGitProvider } = await services();
    const page = await prisma.page.findUniqueOrThrow({
      where: { id: pageId },
      include: { classroom: { include: { git_organization: true } } },
    });
    const { git_organization: org, content_repo: repo } = page.classroom;
    expect(org && repo, 'the page has a content repo').toBeTruthy();
    const provider = getGitProvider(org!);
    const before = await provider.getLatestCommitSHA(
      org!.login,
      repo!,
      await provider.getDefaultBranch(org!.login, repo!)
    );
    const pageContent = ClassmojiService.pageContent;
    const current = await pageContent.loadPageContent(page as never, { skipCache: true });
    expect(current.format).toBe('json');
    const saved = await pageContent.savePageContent(
      page as never,
      [...((current.blocks as Block[]) ?? []), ...blocks],
      { expectedSha: current.sha!, message: `e2e: column layout ${RUN}` }
    );
    const response = await fetch(
      `${env.httpUrl}${COLLAB_INTERNAL_PREFIX}/page/${pageId}/external`,
      {
        method: 'POST',
        headers: { [COLLAB_SECRET_HEADER]: env.secret, 'content-type': 'application/json' },
        body: JSON.stringify({ sha: saved.commit, before }),
      }
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }

  /** A three-column list at the end of the page, pushed to git from outside. */
  async function placeColumns(tag: string) {
    const ids = {
      list: `cols-${tag}-${RUN}`,
      pa: `colp-a-${tag}-${RUN}`,
      pb: `colp-b-${tag}-${RUN}`,
      pc: `colp-c-${tag}-${RUN}`,
    };
    const text = {
      a: `Column A ${tag} ${RUN}`,
      b: `Column B ${tag} ${RUN}`,
      c: `Column C ${tag} ${RUN}`,
    };
    await pushToGit([
      {
        id: ids.list,
        type: 'columnList',
        props: {},
        children: [
          column(`col-a-${tag}-${RUN}`, para(ids.pa, text.a)),
          column(`col-b-${tag}-${RUN}`, para(ids.pb, text.b)),
          column(`col-c-${tag}-${RUN}`, para(ids.pc, text.c)),
        ],
      } as Block,
    ]);
    placed.push(ids.list, ids.pa, ids.pb, ids.pc);
    return { ids, text };
  }

  /** How many blocks in the editor hold exactly `text`. */
  function blocksWithText(page: Page, text: string): Promise<number> {
    return page.evaluate(
      text =>
        [...document.querySelectorAll('.page-editor .bn-block')].filter(block => {
          const inline = block.querySelector(':scope > .bn-block-content .bn-inline-content');
          if (!inline) return false;
          const copy = inline.cloneNode(true) as HTMLElement;
          copy.querySelectorAll('[class*="collaboration-cursor"]').forEach(n => n.remove());
          return (copy.textContent ?? '').replace(/\u2060/g, '') === text;
        }).length,
      text
    );
  }

  /**
   * After both deletions: column B's text is in the page once, A's and C's
   * are gone, no column list with fewer than two columns is left (in either
   * editor or the live document), and edits still sync.
   */
  async function expectOnlyColumnB(
    p1: Page,
    p2: Page,
    { text }: Awaited<ReturnType<typeof placeColumns>>
  ) {
    for (const p of [p1, p2]) {
      await expect(p.getByTestId('live-sync-status').first()).toHaveAttribute(
        'data-status',
        'synced',
        { timeout: 30_000 }
      );
      await expect.poll(() => blocksWithText(p, text.b), { timeout: 15_000 }).toBe(1);
      await expect.poll(() => blocksWithText(p, text.a)).toBe(0);
      await expect.poll(() => blocksWithText(p, text.c)).toBe(0);
      await expect
        .poll(async () => (await columnCounts(p)).filter(n => n < 2), { timeout: 15_000 })
        .toEqual([]);
    }
    const snapshot = await client.fetchSnapshot(env, 'page', pageId);
    const broken: string[] = [];
    let bSeen = 0;
    const walk = (blocks: Block[]) => {
      for (const block of blocks) {
        if (block.type === 'columnList' && (block.children ?? []).length < 2) {
          broken.push(block.id ?? '?');
        }
        if (JSON.stringify(block.content ?? '').includes(text.b)) bSeen += 1;
        walk(block.children ?? []);
      }
    };
    walk(snapshot.content.blocks as Block[]);
    expect(broken).toEqual([]);
    expect(bSeen).toBe(1);
    const marker = ` ok-${RUN}`;
    const target = p1.locator('.page-editor .bn-inline-content', { hasText: text.b }).first();
    // The caret must be in that block before typing (it was just moved there).
    await expect
      .poll(async () => {
        await caretToBlockEnd(target);
        return p1.evaluate(
          () =>
            window.getSelection()?.anchorNode?.parentElement?.closest('.bn-inline-content')
              ?.textContent ?? ''
        );
      })
      .toContain(text.b);
    await p1.keyboard.type(marker, { delay: 20 });
    await expect.poll(() => blocksWithText(p2, `${text.b}${marker}`)).toBe(1);
  }

  test('an agent cannot add a column layout to the live page', async () => {
    const id = `cols-agent-${RUN}`;
    const error = await client
      .postOps(
        env,
        'page',
        pageId,
        [
          {
            op: 'insert',
            blocks: [
              {
                id,
                type: 'columnList',
                props: {},
                children: [
                  column(`col-x-${RUN}`, para(`colp-x-${RUN}`, 'X')),
                  column(`col-y-${RUN}`, para(`colp-y-${RUN}`, 'Y')),
                ],
              },
            ],
            position: { at: 'end' },
          },
        ],
        agent,
        null
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(client.CollabRequestError);
    expect(error).toMatchObject({ status: 422, code: 'columns-not-allowed-live' });
    const snapshot = await client.fetchSnapshot(env, 'page', pageId);
    expect(JSON.stringify(snapshot.content.blocks)).not.toContain(id);
  });

  test('deleting two columns one after the other keeps the last column', async ({ browser }) => {
    test.setTimeout(180_000);
    const placedColumns = await placeColumns('seq');
    const { ids, text } = placedColumns;
    const { contexts, p1, p2 } = await twoEditors(browser);
    try {
      for (const p of [p1, p2]) {
        await expect.poll(() => blockText(p, ids.pc)).toBe(text.c);
        expect(await columnCounts(p)).toContain(3);
      }
      await deleteBlockByMenu(p1, ids.pa);
      // The second deletion starts from the first one's result.
      await expect.poll(() => blocksWithText(p2, text.a)).toBe(0);
      await deleteBlockByMenu(p2, ids.pc);
      await expectOnlyColumnB(p1, p2, placedColumns);
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test('deleting different columns at once leaves a document both editors can load', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const placedColumns = await placeColumns('par');
    const { ids, text } = placedColumns;
    const { contexts, p1, p2, s1, s2 } = await twoEditors(browser, { switches: true });
    try {
      for (const p of [p1, p2]) {
        await expect.poll(() => blockText(p, ids.pc)).toBe(text.c);
        expect(await columnCounts(p)).toContain(3);
      }

      // Both cut off, each deletes a different column, both back: the two
      // deletions meet only when they sync.
      s1!.set(true);
      s2!.set(true);
      for (const p of [p1, p2]) {
        await expect(p.getByTestId('live-sync-status').first()).toHaveAttribute(
          'data-status',
          'offline',
          { timeout: 30_000 }
        );
      }
      await deleteBlockByMenu(p1, ids.pa);
      await deleteBlockByMenu(p2, ids.pc);
      await expect.poll(() => blocksWithText(p1, text.a)).toBe(0);
      await expect.poll(() => blocksWithText(p2, text.c)).toBe(0);
      // Really apart: each still has the column the other deleted.
      expect(await blocksWithText(p1, text.c)).toBe(1);
      expect(await blocksWithText(p2, text.a)).toBe(1);
      s1!.set(false);
      s2!.set(false);

      await expectOnlyColumnB(p1, p2, placedColumns);
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test('undo takes back only your own edits', async ({ browser }) => {
    test.setTimeout(120_000);
    const id = `undo-${RUN}`;
    const base = `Undo target ${RUN}`;
    await client.postOps(
      env,
      'page',
      pageId,
      [{ op: 'insert', blocks: [para(id, base)], position: { at: 'end' } }],
      agent,
      null
    );
    placed.push(id);

    const { contexts, p1, p2 } = await twoEditors(browser);
    try {
      for (const p of [p1, p2]) await expect.poll(() => blockText(p, id)).toBe(base);
      const target = (p: Page) =>
        p.locator(`.page-editor .bn-block[data-id="${id}"] .bn-inline-content`);
      const mine = ` mine-${RUN}`;
      const theirs = ` theirs-${RUN}`;

      await caretToBlockEnd(target(p1));
      await p1.keyboard.type(mine, { delay: 20 });
      await expect.poll(() => blockText(p2, id)).toBe(`${base}${mine}`);

      // The other teacher writes after that, in the same paragraph.
      await caretToBlockEnd(target(p2));
      await p2.keyboard.type(theirs, { delay: 20 });
      await expect.poll(() => blockText(p1, id)).toBe(`${base}${mine}${theirs}`);

      // Teacher 1 undoes: their text goes, teacher 2's stays — in both views.
      await target(p1).click();
      await p1.keyboard.press('ControlOrMeta+z');
      for (const p of [p1, p2]) {
        await expect.poll(() => blockText(p, id)).toBe(`${base}${theirs}`);
      }
      // Redo brings it back.
      await p1.keyboard.press('ControlOrMeta+Shift+z');
      for (const p of [p1, p2]) {
        await expect.poll(() => blockText(p, id)).toBe(`${base}${mine}${theirs}`);
      }
      // Teacher 2's undo takes back only theirs.
      await target(p2).click();
      await p2.keyboard.press('ControlOrMeta+z');
      for (const p of [p1, p2]) {
        await expect.poll(() => blockText(p, id)).toBe(`${base}${mine}`);
      }
    } finally {
      for (const context of contexts) await context.close();
    }
  });
});
