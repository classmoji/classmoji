/**
 * A deck's own scripts run on the render page. A script that never yields
 * (a busy loop) must not be able to hold a render slot: every call into the
 * page has a Node-side deadline, the whole render has one, and the slot is
 * released either way.
 *
 * Runs the REAL driver (renderDeck → withRenderPage → local headless Chrome)
 * against a tiny local server standing in for the slides render route. Needs
 * a local Chrome (the installed channel or Playwright's Chromium); skipped
 * when none can be launched.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  VIEW_API_GLOBAL,
  VIEW_META_ELEMENT_ID,
  VIEW_READY_ATTRIBUTE,
} from '@classmoji/services/render-contract';
import { closeRenderBrowser, RenderError, withRenderPage } from '../src/render/browser.ts';
import { renderDeck } from '../src/render/deckRender.ts';

process.env.NODE_ENV = 'test';

const meta = {
  kind: 'deck',
  version: 'live:1.1',
  width: 960,
  height: 700,
  slides: [{ id: 's1', index: '1', h: 0, v: 0 }],
};

/** A render page whose show() is well behaved, or busy-loops forever. */
function page(behaviour: 'ok' | 'busy'): string {
  const show =
    behaviour === 'busy'
      ? 'function () { for (;;) {} }'
      : "function (id) { return Promise.resolve({ id: id, index: '1', overflow_px: { top: 0, right: 0, bottom: 0, left: 0 } }); }";
  return `<!doctype html><html><body><p>slide</p>
<script type="application/json" id="${VIEW_META_ELEMENT_ID}">${JSON.stringify(meta)}</script>
<script>
  window[${JSON.stringify(VIEW_API_GLOBAL)}] = { meta: ${JSON.stringify(meta)}, show: ${show} };
  document.documentElement.setAttribute(${JSON.stringify(VIEW_READY_ATTRIBUTE)}, '');
</script></body></html>`;
}

let server: Server;
let origin = '';
let chromeAvailable = true;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(req.url?.includes(BUSY_DECK) ? 'busy' : 'ok'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await withRenderPage({ width: 100, height: 100, origin, cookie: cookie() }, async p =>
      p.evaluate(() => 1)
    );
  } catch {
    chromeAvailable = false;
  }
});

afterAll(async () => {
  await closeRenderBrowser();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function cookie() {
  return {
    name: 'cm_view',
    value: 'x',
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'Strict' as const,
  };
}

// The fake route serves the busy page for this deck id (it is in the path).
const BUSY_DECK = '00000000-0000-4000-8000-0000000b0050';
const OK_DECK = '00000000-0000-4000-8000-000000000001';

function request(slideId: string) {
  return {
    origin,
    slideId,
    classroomId: '11111111-2222-4333-8444-555555555555',
    keyVersion: 0,
    at: 'main' as const,
    pin: 'live:1.1',
    ids: ['s1'],
    imageIds: [],
    width: 480,
    quality: 70,
  };
}

describe('a deck script that never yields', () => {
  it('fails the render within the per-call deadline and frees the slot', async ctx => {
    if (!chromeAvailable) ctx.skip();
    const started = Date.now();
    const error = await renderDeck(request(BUSY_DECK))
      .then(() => null)
      .catch(e => e);
    expect(error).toBeInstanceOf(RenderError);
    expect(String(error.message)).toMatch(/did not finish within/);
    expect(Date.now() - started).toBeLessThan(30_000);

    // Both slots must be free again: two well-behaved renders at once succeed.
    const [a, b] = await Promise.all([renderDeck(request(OK_DECK)), renderDeck(request(OK_DECK))]);
    expect(a.measures).toHaveLength(1);
    expect(b.version).toBe('live:1.1');
  }, 60_000);

  it('an overall deadline ends a render whose work never settles', async ctx => {
    if (!chromeAvailable) ctx.skip();
    const started = Date.now();
    const error = await withRenderPage(
      { width: 100, height: 100, origin, cookie: cookie() },
      async p => {
        await p.setContent('<p>x</p>');
        // No per-call deadline here on purpose: only the overall one can end it.
        await p.evaluate(() => {
          for (;;) {
            /* never yields */
          }
        });
      },
      3_000
    )
      .then(() => null)
      .catch(e => e);
    expect(error).toBeInstanceOf(RenderError);
    expect(Date.now() - started).toBeLessThan(15_000);

    const ok = await withRenderPage(
      { width: 100, height: 100, origin, cookie: cookie() },
      async p => p.evaluate(() => 2)
    );
    expect(ok).toBe(2);
  }, 60_000);
});
