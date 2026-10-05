/**
 * svg and html slide blocks in the live slides editor, worked by hand: a
 * person drags and resizes an svg block with its handles and a second editor
 * and the live deck follow; the block source modal's Apply replaces an svg
 * block's drawing and an html block's frame, seen in both editors and in the
 * live deck; in dark mode the svg block draws and the source modal is dark;
 * and deck_render (the MCP render path) shows what an svg block draws.
 *
 * Everything happens on one scratch slide of the kitchen-sink deck, added
 * through the MCP's own collab client (acting as TEACHER_2, like
 * slide-blocks.spec.ts) and deleted at the end. Opt-in:
 *
 *   COLLAB_E2E=1 npx dotenv -e .env -- ./scripts/devport.sh run \
 *     npx playwright test -c tests/collab slide-blocks-editor
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { CollabActor } from '@classmoji/collab';

import {
  CLASSROOM_ID,
  CLASSROOM_REF,
  COLLAB_USERS,
  KITCHEN_SINK_DECK_TITLE,
} from '../../scripts/collab-dev/constants.ts';
import { SLIDES_URL, db, signIn } from './helpers.ts';

const [TEACHER_1, TEACHER_2] = COLLAB_USERS;
const RUN = Date.now().toString(36);
const SKIP_REASON = 'Set COLLAB_E2E=1 with the dev stack running';
const MCP_URL = (process.env.MCP_PUBLIC_URL || 'http://localhost:8110').replace(/\/$/, '');

type CollabClient = typeof import('../../apps/mcp/src/collab/client.ts');
type CollabEnv = NonNullable<ReturnType<typeof import('@classmoji/collab/env').resolveCollabEnv>>;

const SVG_ID = `svg-${RUN}`;
const HTML_ID = `html-${RUN}`;
const RENDER_ID = `render-${RUN}`;

const SVG_SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<circle cx="50" cy="50" r="40" fill="#2563eb"/></svg>';
/** What the source modal's Apply puts in the svg block. */
const APPLIED_FILL = '#00aa55';
const APPLIED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  `<rect x="5" y="5" width="90" height="90" fill="${APPLIED_FILL}"/></svg>`;
const HTML_SOURCE = `<!DOCTYPE html><html><body><p>First ${RUN}</p></body></html>`;
const APPLIED_HTML = `<!DOCTYPE html><html><body><p>Applied ${RUN}</p></body></html>`;
/** A solid block deck_render must show. */
const RENDER_RGB = [0xff, 0x00, 0xaa] as const;
const RENDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">' +
  '<rect x="0" y="0" width="100" height="100" fill="#ff00aa"/></svg>';

type Box = { left: number; top: number; width: number; height: number };

// ─── the live editor ─────────────────────────────────────────────────────────

async function openLive(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    // Always the full URL: an editor that could not go live drops `?mode=edit`,
    // so a plain reload would retry the viewer.
    if (attempt > 1) await page.goto('about:blank');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    try {
      await expect(page.getByTestId('live-sync-status').first()).toHaveAttribute(
        'data-status',
        'synced',
        { timeout: 40_000 }
      );
      await page
        .locator('.reveal.ready .slides section.present[contenteditable]')
        .first()
        .waitFor({ timeout: 40_000 });
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
    }
  }
}

/** Step the editor right until the slide with this id is the one shown. */
async function showSlide(page: Page, slideId: string): Promise<void> {
  const current = page.locator(`.reveal .slides section.present[data-cm-id="${slideId}"]`);
  for (let i = 0; i < 60 && (await current.count()) === 0; i++) {
    await page.locator('.reveal .controls .navigate-right').click();
    await page.waitForTimeout(150);
  }
  await expect(current).toHaveCount(1);
}

/** The block in the editor's slide (thumbnails are not under `.reveal .slides`). */
function blockIn(page: Page, slideId: string, blockId: string) {
  return page.locator(
    `.reveal .slides section[data-cm-id="${slideId}"] .sl-block[data-cm-block-id="${blockId}"]`
  );
}

/** The block's inline box, in slide px. */
function boxOf(page: Page, slideId: string, blockId: string): Promise<Box | null> {
  return page.evaluate(
    ([slide, block]) => {
      const el = document.querySelector(
        `.reveal .slides section[data-cm-id="${slide}"] .sl-block[data-cm-block-id="${block}"]`
      ) as HTMLElement | null;
      if (!el) return null;
      const px = (v: string) => Math.round(parseFloat(v));
      return {
        left: px(el.style.left),
        top: px(el.style.top),
        width: px(el.style.width),
        height: px(el.style.height),
      };
    },
    [slideId, blockId]
  );
}

/** The box once it has stopped changing (the handles settle over a few frames). */
async function settledBox(page: Page, slideId: string, blockId: string): Promise<Box> {
  let last = JSON.stringify(await boxOf(page, slideId, blockId));
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    const next = JSON.stringify(await boxOf(page, slideId, blockId));
    if (next === last && next !== 'null') return JSON.parse(next) as Box;
    last = next;
  }
  throw new Error(`block ${blockId} never settled: ${last}`);
}

/** The CSS scale of `.reveal .slides`, read as BlockHandles reads it. */
function slideScale(page: Page): Promise<number> {
  return page.evaluate(() => {
    const slides = document.querySelector('.reveal .slides');
    const transform = slides ? getComputedStyle(slides).transform : 'none';
    if (!transform || transform === 'none') return 1;
    const scale = parseFloat(transform.replace('matrix(', '').split(',')[0]);
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  });
}

/** Single click on a block selects it and shows its handles. */
/** Where each editor page was opened, to reopen it (see stillEditing). */
const editorUrls = new WeakMap<Page, string>();

/**
 * Reopen the editor if it has left edit mode. In this shared dev stack a Vite
 * full reload (another save) reloads the page without `?mode=edit`, which
 * leaves the person in the viewer — not what these tests are about.
 */
async function stillEditing(page: Page, slideId: string): Promise<void> {
  const editing = page.locator('.reveal.ready .slides section.present[contenteditable]');
  if ((await editing.count()) > 0) return;
  const url = editorUrls.get(page);
  if (!url) return;
  await openLive(page, url);
  await showSlide(page, slideId);
}

async function selectBlock(page: Page, slideId: string, blockId: string): Promise<void> {
  await stillEditing(page, slideId);
  // A slide someone else holds takes no drags or source edits; a holder that
  // just left keeps it for the 30 s disconnect grace.
  await expect(
    page.locator(`.reveal .slides section[data-cm-id="${slideId}"]`),
    'scratch slide held by another editor'
  ).not.toHaveClass(/\bcm-locked\b/, { timeout: 45_000 });
  const overlay = page.getByTestId('block-resize-overlay');
  const block = blockIn(page, slideId, blockId);
  // Already selected: the handles sit over the block (and take its clicks).
  if (await overlay.isVisible()) {
    const [a, b] = await Promise.all([overlay.boundingBox(), block.boundingBox()]);
    if (
      a &&
      b &&
      Math.abs(a.x - b.x) <= 3 &&
      Math.abs(a.y - b.y) <= 3 &&
      Math.abs(a.width - b.width) <= 3 &&
      Math.abs(a.height - b.height) <= 3
    ) {
      return;
    }
  }
  for (let attempt = 1; ; attempt++) {
    await block.click();
    try {
      await expect(overlay).toBeVisible({ timeout: 5_000 });
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

/** Press from the centre of `from` and release `dx, dy` screen px away. */
async function dragBy(page: Page, selector: string, dx: number, dy: number): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `${selector} on screen`).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}

/** Replace the source modal's text (CodeMirror) and press Apply. */
async function applySource(page: Page, title: 'SVG source' | 'HTML source', source: string) {
  const modal = page.locator('.ant-modal').filter({ hasText: title });
  const editor = modal.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(source);
  await expect
    .poll(() => editor.evaluate(el => (el.textContent ?? '').replace(/\s+/g, '')))
    .toBe(source.replace(/\s+/g, ''));
  await modal.getByRole('button', { name: 'Apply' }).click();
  try {
    await expect(modal).toBeHidden({ timeout: 10_000 });
  } catch (error) {
    const alert = await modal
      .getByRole('alert')
      .textContent()
      .catch(() => null);
    throw new Error(`${title} modal stayed open (alert: ${alert ?? 'none'})`, { cause: error });
  }
}

// ─── a tiny MCP client (streamable HTTP, JSON-RPC) ──────────────────────────

type McpContent = { type: string; text?: string; data?: string; mimeType?: string };
type McpResult = { isError?: boolean; content?: McpContent[] };

/** Thrown when the MCP server cannot be reached at all (the only reason to skip). */
class McpUnreachable extends Error {}

async function mcpSession(login: string) {
  const minted = await fetch(`${MCP_URL}/dev/mint-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, scopes: ['read', 'write'], expiresInSeconds: 900 }),
  }).catch((error: unknown) => {
    throw new McpUnreachable(String(error));
  });
  if (!minted.ok) throw new Error(`mint-token ${minted.status}: ${await minted.text()}`);
  const token = ((await minted.json()) as { access_token: string }).access_token;
  let session: string | null = null;
  let id = 0;
  async function rpc(method: string, params: unknown, notify = false) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    };
    if (session) headers['mcp-session-id'] = session;
    const body = notify
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: ++id, method, params };
    const res = await fetch(`${MCP_URL}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    session = res.headers.get('mcp-session-id') ?? session;
    const text = await res.text();
    if (notify) return null;
    if (!res.ok) throw new Error(`MCP ${method} HTTP ${res.status}: ${text.slice(0, 300)}`);
    const messages = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => JSON.parse(line.slice(5)))
      : [JSON.parse(text)];
    return (messages.find(m => m.id === id) ?? messages.at(-1)) as {
      result?: McpResult;
      error?: { message?: string };
    };
  }
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'slide-blocks-editor-spec', version: '0' },
  });
  await rpc('notifications/initialized', {}, true);
  return {
    /** End the server-side session. */
    async close() {
      if (!session) return;
      await fetch(`${MCP_URL}/mcp`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}`, 'mcp-session-id': session },
      }).catch(() => undefined);
    },
    async call(name: string, args: Record<string, unknown>) {
      const reply = await rpc('tools/call', { name, arguments: args });
      const content = reply?.result?.content ?? [];
      return {
        isError: !!reply?.error || !!reply?.result?.isError,
        text: reply?.error?.message ?? content.map(c => c.text ?? '').join('\n'),
        images: content.filter(c => c.type === 'image' && c.data).map(c => c.data as string),
      };
    },
  };
}

/** How many pixels of an image are within `tolerance` of `rgb`, and its size. */
async function countNear(
  page: Page,
  imageBase64: string,
  mime: 'image/jpeg' | 'image/png',
  rgb: readonly [number, number, number],
  tolerance: number
): Promise<{ near: number; total: number }> {
  return page.evaluate(
    async ({ data, mime, rgb, tolerance }) => {
      const img = new Image();
      img.src = `data:${mime};base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let near = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (
          Math.abs(px[i] - rgb[0]) <= tolerance &&
          Math.abs(px[i + 1] - rgb[1]) <= tolerance &&
          Math.abs(px[i + 2] - rgb[2]) <= tolerance
        ) {
          near++;
        }
      }
      return { near, total: px.length / 4 };
    },
    { data: imageBase64, mime, rgb: [...rgb], tolerance }
  );
}

/** Relative luminance (0 black … 1 white) of a computed `rgb()/rgba()` colour. */
function luminance(color: string): number {
  const parts = (color.match(/[\d.]+/g) ?? ['255', '255', '255']).map(Number);
  // Transparent shows whatever is behind it: never counted as dark.
  if (parts.length > 3 && parts[3] === 0) return 1;
  const [r, g, b] = parts;
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function hexRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

// ─── the suite ───────────────────────────────────────────────────────────────

test.describe('svg and html slide blocks in the editor', () => {
  test.skip(!process.env.COLLAB_E2E, SKIP_REASON);
  test.describe.configure({ mode: 'serial' });

  let deckId = '';
  let slideId = '';
  let client: CollabClient;
  let env: CollabEnv;
  let agent: CollabActor;

  /**
   * Ops on the live deck as the agent, unpinned. postOps' trailing pin
   * parameter is in flux (optional, or required); null means "unpinned"
   * either way.
   */
  function postDeckOps(ops: unknown[]): Promise<{ insertedIds?: string[] }> {
    const post = client.postOps as unknown as (
      ...args: unknown[]
    ) => Promise<{ insertedIds?: string[] }>;
    return post(env, 'deck', deckId, ops, agent, null);
  }

  /**
   * postDeckOps, waiting out a slide lock: an editor that just closed keeps
   * its slide for the disconnect grace (30 s), and agent ops on a held slide
   * are refused as slide-locked until it lapses.
   */
  async function postDeckOpsWhenFree(ops: unknown[]): Promise<{ insertedIds?: string[] }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await postDeckOps(ops);
      } catch (error) {
        if (!/slide-locked/.test(String(error)) || attempt >= 12) throw error;
        await new Promise(resolve => setTimeout(resolve, 5_000));
      }
    }
  }

  /** Where the scratch slide is now (others share the deck). */
  async function currentSlideIndex(): Promise<number> {
    const snapshot = await client.fetchSnapshot(env, 'deck', deckId);
    const index = snapshot.content.slides.findIndex(s => s.id === slideId);
    expect(index, 'scratch slide in the live deck').toBeGreaterThan(-1);
    return index;
  }

  async function slideHtml(): Promise<string> {
    const snapshot = await client.fetchSnapshot(env, 'deck', deckId);
    return snapshot.content.slides.find(s => s.id === slideId)?.html ?? '';
  }

  /** The opening tag of a block in the live deck's slide html. */
  async function liveBlockTag(blockId: string): Promise<string> {
    const html = await slideHtml();
    return html.match(new RegExp(`<div[^>]*data-cm-block-id="${blockId}"[^>]*>`))?.[0] ?? '';
  }

  async function editor(
    browser: Browser,
    login: string,
    contexts: BrowserContext[],
    options: Parameters<Browser['newContext']>[0] = {}
  ): Promise<Page> {
    const context = await browser.newContext(options);
    contexts.push(context);
    await signIn(context, login);
    const page = await context.newPage();
    const url = `${SLIDES_URL}/${deckId}?mode=edit#/${await currentSlideIndex()}`;
    editorUrls.set(page, url);
    await openLive(page, url);
    await showSlide(page, slideId);
    return page;
  }

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const prisma = await db();
    const deck = await prisma.slide.findFirstOrThrow({
      where: { classroom_id: CLASSROOM_ID, title: KITCHEN_SINK_DECK_TITLE },
    });
    const teacher2 = await prisma.user.findFirstOrThrow({ where: { email: TEACHER_2.email } });
    deckId = deck.id;
    client = await import('../../apps/mcp/src/collab/client.ts');
    const { resolveCollabEnv } = await import('@classmoji/collab/env');
    const resolved = resolveCollabEnv();
    expect(resolved, 'COLLAB_URL / COLLAB_INTERNAL_SECRET (run through devport.sh)').toBeTruthy();
    env = resolved!;
    agent = {
      userId: teacher2.id,
      name: teacher2.name ?? TEACHER_2.name,
      agentSession: `blocks-editor-${RUN}`,
    };

    const inserted = await postDeckOps([
      {
        op: 'insert',
        slides: [{ html: `<h2>Blocks editor ${RUN}</h2>` }],
        position: { at: 'end' },
      },
    ]);
    slideId = inserted.insertedIds?.[0] ?? '';
    expect(slideId, 'inserted slide id').toBeTruthy();
    await postDeckOps([
      {
        op: 'block_add',
        slide: slideId,
        type: 'svg',
        box: { left: 520, top: 160, width: 260, height: 260 },
        source: SVG_SOURCE,
        block_id: SVG_ID,
      },
      {
        op: 'block_add',
        slide: slideId,
        type: 'html',
        box: { left: 60, top: 160, width: 380, height: 240 },
        source: HTML_SOURCE,
        block_id: HTML_ID,
      },
    ]);
    await currentSlideIndex();
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    if (slideId) await postDeckOpsWhenFree([{ op: 'delete', id: slideId }]);
  });

  test('dragging and resizing an svg block reaches a second editor and the live deck', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const contexts: BrowserContext[] = [];
    try {
      const mover = await editor(browser, TEACHER_1.login, contexts);
      const watcher = await editor(browser, TEACHER_2.login, contexts);
      await expect(blockIn(watcher, slideId, SVG_ID)).toHaveCount(1);

      const start = await settledBox(mover, slideId, SVG_ID);
      expect(start).toEqual({ left: 520, top: 160, width: 260, height: 260 });
      const scale = await slideScale(mover);

      // Move: the handles' move area, 90 x 45 screen px.
      await selectBlock(mover, slideId, SVG_ID);
      await dragBy(mover, '.block-move-area', 90, 45);
      const moved = await settledBox(mover, slideId, SVG_ID);
      expect(Math.abs(moved.left - (start.left + 90 / scale))).toBeLessThanOrEqual(2);
      // `top` is compensated for Reveal's re-centring after the drop: direction only.
      expect(moved.top).toBeGreaterThan(start.top);
      expect(moved.width).toBe(start.width);
      expect(moved.height).toBe(start.height);

      // Resize: the south-east handle, 60 x 30 screen px.
      await selectBlock(mover, slideId, SVG_ID);
      await dragBy(mover, '.block-resize-handle-se', 60, 30);
      const resized = await settledBox(mover, slideId, SVG_ID);
      expect(Math.abs(resized.width - (moved.width + 60 / scale))).toBeLessThanOrEqual(2);
      expect(Math.abs(resized.height - (moved.height + 30 / scale))).toBeLessThanOrEqual(2);
      expect(resized.left).toBe(moved.left);

      // The other editor converges on the same box.
      await expect
        .poll(() => boxOf(watcher, slideId, SVG_ID), { timeout: 20_000 })
        .toEqual(resized);

      // And the live document holds it.
      await expect
        .poll(() => liveBlockTag(SVG_ID), { timeout: 20_000 })
        .toContain(`left: ${resized.left}px`);
      const tag = await liveBlockTag(SVG_ID);
      expect(tag).toContain(`top: ${resized.top}px`);
      expect(tag).toContain(`width: ${resized.width}px`);
      expect(tag).toContain(`height: ${resized.height}px`);
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test('the source modal applies a new svg drawing and a new html frame', async ({ browser }) => {
    test.setTimeout(240_000);
    const contexts: BrowserContext[] = [];
    try {
      const author = await editor(browser, TEACHER_1.login, contexts);
      const watcher = await editor(browser, TEACHER_2.login, contexts);

      // svg: Edit source in the properties panel, replace, Apply.
      await selectBlock(author, slideId, SVG_ID);
      await author.getByTestId('svg-block-edit-source').click();
      await applySource(author, 'SVG source', APPLIED_SVG);

      for (const page of [author, watcher]) {
        const svg = blockIn(page, slideId, SVG_ID).locator('svg');
        await expect(svg).toHaveCount(1, { timeout: 20_000 });
        await expect(svg.locator(`rect[fill="${APPLIED_FILL}"]`)).toHaveCount(1, {
          timeout: 20_000,
        });
        await expect(svg.locator('circle')).toHaveCount(0);
      }
      await expect.poll(slideHtml, { timeout: 20_000 }).toContain(`fill="${APPLIED_FILL}"`);
      expect(await slideHtml()).not.toContain('<circle');

      // html: the same modal writes the frame's srcdoc.
      await selectBlock(author, slideId, HTML_ID);
      await author.getByTestId('html-block-edit-source').click();
      await applySource(author, 'HTML source', APPLIED_HTML);

      for (const page of [author, watcher]) {
        const frame = blockIn(page, slideId, HTML_ID).locator('iframe');
        await expect(frame).toHaveAttribute('srcdoc', new RegExp(`Applied ${RUN}`), {
          timeout: 20_000,
        });
        await expect(frame).not.toHaveAttribute('srcdoc', new RegExp(`First ${RUN}`));
        // The frame shows it, inside its sandbox.
        await expect(
          page
            .frameLocator(
              `.reveal .slides section[data-cm-id="${slideId}"] .sl-block[data-cm-block-id="${HTML_ID}"] iframe`
            )
            .getByText(`Applied ${RUN}`)
        ).toBeVisible({ timeout: 20_000 });
      }
      await expect.poll(slideHtml, { timeout: 20_000 }).toContain(`Applied ${RUN}`);
      expect(await slideHtml()).not.toContain(`First ${RUN}`);
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test('in dark mode the svg block draws and the source modal is dark', async ({ browser }) => {
    test.setTimeout(180_000);
    const contexts: BrowserContext[] = [];
    try {
      const page = await editor(browser, TEACHER_1.login, contexts, { colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveClass(/\bdark\b/);

      const svg = blockIn(page, slideId, SVG_ID).locator('svg');
      await expect(svg).toBeVisible();
      const box = await svg.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(20);
      expect(box?.height ?? 0).toBeGreaterThan(20);
      const shape = svg.locator('rect, circle').first();
      await expect(shape).toBeVisible();
      expect((await shape.boundingBox())?.width ?? 0).toBeGreaterThan(10);
      // It draws: the block's pixels hold its fill (not hidden, not blended away).
      const fill = hexRgb((await shape.getAttribute('fill')) ?? '');
      const shot = (await blockIn(page, slideId, SVG_ID).screenshot()).toString('base64');
      const drawn = await countNear(page, shot, 'image/png', fill, 24);
      expect(drawn.near / drawn.total).toBeGreaterThan(0.2);

      // The source modal (closed with the context, never with Cancel).
      await selectBlock(page, slideId, SVG_ID);
      await page.getByTestId('svg-block-edit-source').click();
      const modal = page.locator('.ant-modal').filter({ hasText: 'SVG source' });
      await expect(modal.locator('.cm-content')).toBeVisible();
      await expect
        .poll(
          async () =>
            luminance(
              await modal
                .locator('.ant-modal-content')
                .evaluate(el => getComputedStyle(el).backgroundColor)
            ),
          { timeout: 10_000 }
        )
        .toBeLessThan(0.1);
      const editorBg = await modal
        .locator('.cm-editor')
        .evaluate(el => getComputedStyle(el).backgroundColor);
      expect(luminance(editorBg)).toBeLessThan(0.1);
      // The editor text is light on it.
      const editorFg = await modal.locator('.cm-editor').evaluate(el => getComputedStyle(el).color);
      expect(luminance(editorFg)).toBeGreaterThan(0.5);
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test('deck_render shows what an svg block draws', async ({ browser }) => {
    test.setTimeout(180_000);
    await postDeckOpsWhenFree([
      {
        op: 'block_add',
        slide: slideId,
        type: 'svg',
        box: { left: 180, top: 150, width: 600, height: 400 },
        source: RENDER_SVG,
        block_id: RENDER_ID,
      },
    ]);
    await expect.poll(() => liveBlockTag(RENDER_ID)).toContain('width: 600px');

    let mcp: Awaited<ReturnType<typeof mcpSession>>;
    try {
      mcp = await mcpSession(TEACHER_1.login);
    } catch (error) {
      // Only an unreachable server skips; a refused mint or initialize fails.
      if (!(error instanceof McpUnreachable)) throw error;
      test.skip(true, `MCP server unreachable at ${MCP_URL}: ${error.message}`);
      return;
    }
    let result: Awaited<ReturnType<typeof mcp.call>>;
    try {
      result = await mcp.call('deck_render', {
        classroom: CLASSROOM_REF,
        slide_id: deckId,
        slide_ids: [slideId],
        hi_res: true,
      });
    } finally {
      await mcp.close();
    }
    if (/rate limit/i.test(result.text)) {
      test.skip(true, `deck_render is rate-limited: ${result.text.slice(0, 200)}`);
      return;
    }
    expect(result.isError, result.text.slice(0, 500)).toBe(false);
    expect(result.images, result.text.slice(0, 500)).toHaveLength(1);

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const { near, total } = await countNear(page, result.images[0], 'image/jpeg', RENDER_RGB, 40);
      // 600 x 400 of a 960 x 700 slide is ~36 % of the image.
      expect(near).toBeGreaterThan(10_000);
      expect(near / total).toBeGreaterThan(0.15);
    } finally {
      await context.close();
    }
  });
});
