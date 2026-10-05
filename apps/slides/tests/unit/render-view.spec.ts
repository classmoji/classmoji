/**
 * `/:slideId/render-view` — the page the MCP's deck_render screenshots.
 *
 * Pure checks: the slide index the driver steps through, the one refusal, the
 * driver script's contract with the MCP, and that the route module exports
 * nothing but its loader (so no server code can reach the client bundle).
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '@playwright/test';
import type { DeckJson } from '@classmoji/services/slides';
import {
  VIEW_API_GLOBAL,
  VIEW_META_ELEMENT_ID,
  VIEW_READY_ATTRIBUTE,
} from '@classmoji/services/render-contract';
import { deckViewSlides, viewRefusal, viewScript } from '../../app/utils/deckView.server.ts';
import * as route from '../../app/routes/$slideId_.render-view/route.tsx';

const deck = {
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [
    { id: 'a', html: '<h1>A</h1>' },
    {
      id: 'stack',
      html: '',
      children: [
        { id: 'b1', html: '' },
        { id: 'b2', html: '' },
      ],
    },
    { id: 'c', html: '' },
  ],
} as unknown as DeckJson;

test.describe('render-view', () => {
  test('indexes slides as deck_outline does, with Reveal indices', () => {
    expect(deckViewSlides(deck)).toEqual([
      { id: 'a', index: '1', h: 0, v: 0 },
      { id: 'stack', index: '2', h: 1, v: 0 },
      { id: 'b1', index: '2.1', h: 1, v: 0 },
      { id: 'b2', index: '2.2', h: 1, v: 1 },
      { id: 'c', index: '3', h: 2, v: 0 },
    ]);
  });

  test('refuses with one uncached, unindexed 403', async () => {
    const response = viewRefusal();
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Forbidden');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  });

  test('the driver script raises the ready flag and exposes the API the MCP calls', () => {
    const script = viewScript();
    expect(script).toContain(JSON.stringify(VIEW_READY_ATTRIBUTE));
    expect(script).toContain(JSON.stringify(VIEW_API_GLOBAL));
    expect(script).toContain(JSON.stringify(VIEW_META_ELEMENT_ID));
    // A still frame: transitions and animations jump to their end state.
    expect(script).toContain('transition-duration: 0s !important');
  });

  test('renders the deck standalone, with the draggable-block rules', () => {
    // Outside the slides app there is no global.css: without these rules an
    // .sl-block falls into normal flow and the slide stacks.
    const source = readFileSync(
      new URL('../../app/utils/deckView.server.ts', import.meta.url),
      'utf8'
    );
    expect(source).toMatch(/generateDeckHtml\(deck, \{[^}]*standalone: true/);
  });

  test('the route module exports only its loader', () => {
    expect(Object.keys(route).sort()).toEqual(['loader']);
  });
});

/**
 * The driver waits for a slide's frames — html blocks and the embeds Reveal
 * starts — the way it waits for images, and never past its cap. A stub Reveal
 * whose `slide()` starts `data-src` frames like Reveal's own
 * `startEmbeddedContent`, on a page served by `page.route`.
 */
// The page-based tests drive the installed Chrome.
test.use({ channel: 'chrome' });

test.describe('render-view waits for frames', () => {
  const ORIGIN = 'http://cm-render.test';

  function pageHtml(frames: string): string {
    const meta = {
      kind: 'deck',
      version: 1,
      width: 960,
      height: 700,
      slides: [{ id: 'a', index: '1', h: 0, v: 0 }],
    };
    const startFrames = `function () {
      document.querySelectorAll('section iframe[data-src]').forEach(function (f) {
        if (f.getAttribute('src') !== f.getAttribute('data-src')) f.setAttribute('src', f.getAttribute('data-src'));
      });
    }`;
    return `<!doctype html><html><body>
<div class="reveal"><div class="slides"><section data-cm-id="a"><h1>A</h1>${frames}</section></div></div>
<script>window.Reveal = { isReady: function () { return true; }, on: function () {}, configure: function () {},
  layout: function () {}, getIndices: function () { return { h: 0, v: 0 }; },
  slide: ${startFrames}, startEmbeddedContent: ${startFrames} };</script>
<script type="application/json" id="${VIEW_META_ELEMENT_ID}">${JSON.stringify(meta)}</script>
${viewScript()}
</body></html>`;
  }

  async function open(
    page: import('@playwright/test').Page,
    frames: string,
    frameDelayMs: number | null
  ) {
    await page.route(`${ORIGIN}/**`, async routed => {
      const path = new URL(routed.request().url()).pathname;
      if (path === '/deck') {
        await routed.fulfill({ contentType: 'text/html', body: pageHtml(frames) });
        return;
      }
      if (frameDelayMs === null) return; // never answers
      await new Promise(resolve => setTimeout(resolve, frameDelayMs));
      await routed.fulfill({ contentType: 'text/html', body: '<p>game</p>' });
    });
    // Not 'load': the driver must do the waiting, not goto.
    await page.goto(`${ORIGIN}/deck`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`[${VIEW_READY_ATTRIBUTE}]`, { state: 'attached' });
  }

  async function timedShow(page: import('@playwright/test').Page) {
    return page.evaluate(async api => {
      const started = performance.now();
      const result = await (
        window as unknown as Record<string, { show(id: string): Promise<unknown> }>
      )[api].show('a');
      return { ms: performance.now() - started, result };
    }, VIEW_API_GLOBAL);
  }

  test('a lazy embed on the shown slide is waited for until it loads', async ({ page }) => {
    await open(
      page,
      `<div class="sl-block" data-block-type="iframe"><div class="sl-block-content"><iframe data-src="${ORIGIN}/game.html"></iframe></div></div>`,
      1500
    );
    const { ms, result } = await timedShow(page);
    expect(ms).toBeGreaterThan(1200);
    expect(ms).toBeLessThan(3900);
    expect(result).toMatchObject({ id: 'a' });
  });

  test('an html block still loading is waited for', async ({ page }) => {
    // The srcdoc's own image keeps the frame (and the window) loading. A
    // sandboxed frame's requests bypass page.route, so a real (slow) server
    // serves the page and the image.
    const frame = (port: number) =>
      `<div class="sl-block" data-block-type="html"><div class="sl-block-content"><iframe sandbox="allow-scripts" srcdoc="&lt;img src=&quot;http://127.0.0.1:${port}/sprite.png&quot;&gt;"></iframe></div></div>`;
    const server = createServer((req, res) => {
      if (req.url === '/deck') {
        const { port } = server.address() as AddressInfo;
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(pageHtml(frame(port)));
        return;
      }
      setTimeout(() => res.writeHead(200, { 'Content-Type': 'image/png' }).end(), 1500);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await page.goto(`http://127.0.0.1:${port}/deck`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`[${VIEW_READY_ATTRIBUTE}]`, { state: 'attached' });
      const { ms } = await timedShow(page);
      expect(ms).toBeGreaterThan(1000);
      expect(ms).toBeLessThan(3900);
    } finally {
      server.close();
    }
  });

  test('an html block that already loaded costs nothing', async ({ page }) => {
    await open(
      page,
      `<div class="sl-block" data-block-type="html"><div class="sl-block-content"><iframe sandbox="allow-scripts" srcdoc="&lt;canvas&gt;&lt;/canvas&gt;"></iframe></div></div>`,
      0
    );
    const { ms } = await timedShow(page);
    expect(ms).toBeLessThan(1000);
  });

  test('a frame that never loads holds the slide only up to the cap', async ({ page }) => {
    await open(
      page,
      `<div class="sl-block" data-block-type="iframe"><div class="sl-block-content"><iframe data-src="${ORIGIN}/never.html"></iframe></div></div>`,
      null
    );
    const { ms, result } = await timedShow(page);
    expect(ms).toBeGreaterThan(3500);
    expect(ms).toBeLessThan(6000);
    expect(result).toMatchObject({ id: 'a' });
  });
});
