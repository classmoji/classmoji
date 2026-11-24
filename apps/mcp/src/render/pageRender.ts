/**
 * Drive the pages app's `/_render/page/:pageId`: load the page, wait until it
 * is drawn, let its images settle, outline the blocks asked about, measure
 * where they sit, and screenshot the page in viewport-sized chunks.
 *
 * Two kinds of render page answer there, because the pages app and this
 * server deploy separately and in either order:
 *   - the reader island (current): the page is drawn in the browser by the
 *     shared page reader. Its first HTML declares it (`data-render-pending` on
 *     <html>), and it raises `data-render-ready` (or `data-render-error`) once
 *     the reader is on screen with code highlighted and fonts loaded. The
 *     driver waits for that, bounded (`waitForPageReady`).
 *   - the older static render: complete at `load`; nothing more to wait for.
 * Both keep the same markup the measurements read: `article` (the page's
 * extent), `.site-article` (the boxes checked for hidden overflow), and
 * BlockNote's `.bn-block-outer[data-id] > .bn-block` per block.
 */

import type { Page } from 'playwright-core';
import {
  VIEW_ERROR_ATTRIBUTE,
  VIEW_META_ELEMENT_ID,
  VIEW_READY_ATTRIBUTE,
  VIEW_SETTLED_SELECTOR,
  declaresPendingRender,
  pageViewUrl,
  viewTarget,
  viewTokenCookie,
  type PageViewMeta,
  type ViewAt,
} from '@classmoji/services/render-contract';
import { signDocViewToken } from '@classmoji/services/render-token';
import {
  EVALUATE_DEADLINE_MS,
  RenderError,
  within,
  withRenderPage,
  type RenderBackend,
} from './browser.ts';

/** The page is laid out at this CSS width. */
export const PAGE_RENDER_WIDTH = 900;
/** Each returned image covers this much of the page. */
export const PAGE_CHUNK_HEIGHT = 1200;

export interface PageRenderRequest {
  origin: string;
  pageId: string;
  classroomId: string;
  keyVersion: number;
  at: ViewAt;
  pin: string | null;
  /** Blocks to outline and locate. */
  blockIds: string[];
  /** Pick the chunks to capture once the page height is known. */
  chooseChunks: (layout: PageLayout) => number[];
  quality: number;
}

export interface PageBlockBox {
  id: string;
  top: number;
  bottom: number;
}

export interface PageLayout {
  height: number;
  chunks: number;
  blocks: PageBlockBox[];
}

export interface PageRenderResult extends PageLayout {
  version: string;
  /**
   * How the page was drawn when it was captured: `'settled'` (everything in),
   * what timed out (`'highlight-timeout'`, `'fonts-timeout'`, …: a degraded
   * capture), or `'static'` (the older server-rendered page).
   */
  drawn: string;
  /** Wider than the viewport by this many px (0 = fits). */
  overflowX: number;
  /** Boxes hiding content behind a scrollbar, by block. */
  clipped: Array<{ block_id: string | null; element: string; hidden_px: { x: number; y: number } }>;
  /** chunk number (1-based) → base64 JPEG. */
  images: Map<number, string>;
  backend: RenderBackend;
}

const NAVIGATION_TIMEOUT_MS = 45_000;
/** How long a pending page may take from `load` to its ready marker. */
export const PAGE_READY_TIMEOUT_MS = 20_000;
const HIGHLIGHT_COLOR = '#f97316';

/**
 * Wait until the page is drawn. `html` is the page's first HTML (the
 * navigation response): a page that does not declare itself pending is the
 * static render, complete at `load` (`'static'`). A pending one is waited for
 * until <html> itself carries the ready marker (its value: `'settled'`, or
 * what timed out, e.g. `'highlight-timeout'`) or the error marker, at most
 * `timeoutMs`. A marker anywhere else in the page counts for nothing. A
 * failure and the timeout are RenderErrors the caller can show.
 */
export async function waitForPageReady(
  page: Pick<Page, 'waitForSelector' | 'evaluate'>,
  html: string,
  timeoutMs: number = PAGE_READY_TIMEOUT_MS
): Promise<string> {
  if (!declaresPendingRender(html)) return 'static';
  const deadline = Date.now() + timeoutMs;
  const late = () =>
    new RenderError(
      'RENDER_FAILED',
      `The page did not finish drawing within ${Math.max(1, Math.round(timeoutMs / 1000))}s.`
    );
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw late();
    try {
      await page.waitForSelector(VIEW_SETTLED_SELECTOR, { state: 'attached', timeout: remaining });
    } catch {
      throw late();
    }
    const state = await page.evaluate(
      ([ready, failed]) => ({
        ready: document.documentElement.getAttribute(ready),
        failed: document.documentElement.getAttribute(failed),
      }),
      [VIEW_READY_ATTRIBUTE, VIEW_ERROR_ATTRIBUTE] as const
    );
    if (state.failed !== null) {
      throw new RenderError(
        'RENDER_FAILED',
        `The page could not be drawn in the render browser (${state.failed || 'error'}).`
      );
    }
    if (state.ready !== null) return state.ready || 'ready';
    // Neither on <html> (the selector cannot say otherwise, but never
    // report ready without it): keep waiting until the deadline.
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export async function renderPage(request: PageRenderRequest): Promise<PageRenderResult> {
  const token = await signDocViewToken({
    origin: request.origin,
    classroomId: request.classroomId,
    kind: 'page',
    docId: request.pageId,
    target: viewTarget(request.at, request.pin),
    keyVersion: request.keyVersion,
  });
  if (!token) {
    throw new RenderError(
      'RENDER_UNAVAILABLE',
      'Rendering is not configured on this server (no content signing secret).'
    );
  }
  const url = pageViewUrl(request.origin, request.pageId, request.at, request.pin);

  return withRenderPage(
    {
      width: PAGE_RENDER_WIDTH,
      height: PAGE_CHUNK_HEIGHT,
      cookie: viewTokenCookie(request.origin, token),
      origin: request.origin,
    },
    async (page, backend) => {
      const response = await page.goto(url, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
      if (!response || response.status() !== 200) {
        throw new RenderError(
          'RENDER_FAILED',
          `The render page answered ${response ? response.status() : 'nothing'}.`
        );
      }
      // Whether to wait is read from the RESPONSE, as the deck render reads
      // its meta: the first HTML says what kind of page this is.
      const drawn = await waitForPageReady(page, await response.text());

      if (request.blockIds.length > 0) {
        const selectors = request.blockIds
          .map(id => `.bn-block-outer[data-id="${id.replace(/["\\]/g, '\\$&')}"] > .bn-block`)
          .join(',\n');
        await page.addStyleTag({
          content: `${selectors} { outline: 3px solid ${HIGHLIGHT_COLOR}; outline-offset: 3px; border-radius: 4px; }`,
        });
      }

      const measured = await within(
        page.evaluate(
          async ({ metaId, ids }) => {
            const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
            // Images below the fold are lazy; a capture of the whole page needs them.
            const pending: Array<Promise<unknown>> = [];
            document.querySelectorAll('img').forEach(img => {
              img.loading = 'eager';
              if (img.complete) return;
              pending.push(
                new Promise(resolve => {
                  img.addEventListener('load', resolve, { once: true });
                  img.addEventListener('error', resolve, { once: true });
                })
              );
            });
            if (document.fonts?.ready) pending.push(document.fonts.ready.catch(() => undefined));
            await Promise.race([Promise.all(pending), sleep(5000)]);
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

            const describe = (el: Element) => {
              const tag = el.tagName.toLowerCase();
              const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
              let text = (el.textContent || '').replace(/\s+/g, ' ').trim();
              if (text.length > 40) text = `${text.slice(0, 39)}…`;
              return `${tag}${cls ? `.${cls}` : ''}${text ? ` "${text}"` : ''}`;
            };
            const blocks = ids
              .map(id => {
                const el = document.querySelector(
                  `.bn-block-outer[data-id="${CSS.escape(id)}"] > .bn-block`
                );
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return {
                  id,
                  top: Math.round(r.top + window.scrollY),
                  bottom: Math.round(r.bottom + window.scrollY),
                };
              })
              .filter(Boolean);
            const clipped: Array<{
              block_id: string | null;
              element: string;
              hidden_px: { x: number; y: number };
            }> = [];
            document.querySelectorAll('.site-article *').forEach(el => {
              const cs = getComputedStyle(el);
              if (cs.overflowX === 'visible' && cs.overflowY === 'visible') return;
              const hx = Math.max(0, el.scrollWidth - el.clientWidth);
              const hy = Math.max(0, el.scrollHeight - el.clientHeight);
              if (hx <= 1 && hy <= 1) return;
              const owner = el.closest('.bn-block-outer');
              clipped.push({
                block_id: owner?.getAttribute('data-id') ?? null,
                element: describe(el),
                hidden_px: { x: Math.round(hx), y: Math.round(hy) },
              });
            });
            const metaEl = document.getElementById(metaId);
            return {
              meta: metaEl ? (JSON.parse(metaEl.textContent || '{}') as { version?: string }) : {},
              // The article's own extent, not the document's: a short page is not
              // padded out to the viewport with blank space.
              height: Math.ceil(
                (document.querySelector('article')?.getBoundingClientRect().bottom ??
                  document.documentElement.scrollHeight) + window.scrollY
              ),
              overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
              blocks,
              clipped: clipped.slice(0, 10),
            };
          },
          { metaId: VIEW_META_ELEMENT_ID, ids: request.blockIds }
        ),
        EVALUATE_DEADLINE_MS,
        'Measuring the page'
      );

      const height = Math.max(1, measured.height);
      const layout: PageLayout = {
        height,
        chunks: Math.max(1, Math.ceil(height / PAGE_CHUNK_HEIGHT)),
        blocks: measured.blocks as PageBlockBox[],
      };
      const images = new Map<number, string>();
      for (const n of request.chooseChunks(layout)) {
        const from = (n - 1) * PAGE_CHUNK_HEIGHT;
        if (from >= height) continue;
        const buffer = await page.screenshot({
          type: 'jpeg',
          quality: request.quality,
          fullPage: true,
          animations: 'disabled',
          clip: {
            x: 0,
            y: from,
            width: PAGE_RENDER_WIDTH,
            height: Math.min(PAGE_CHUNK_HEIGHT, height - from),
          },
        });
        images.set(n, buffer.toString('base64'));
      }

      return {
        ...layout,
        version: (measured.meta as PageViewMeta).version ?? 'unknown',
        drawn,
        overflowX: measured.overflowX,
        clipped: measured.clipped,
        images,
        backend,
      };
    }
  );
}
