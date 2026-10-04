/**
 * Drive the pages app's `/_render/page/:pageId`: load the statically
 * rendered page, let its images settle, outline the blocks asked about,
 * measure where they sit, and screenshot the page in viewport-sized chunks.
 */

import {
  VIEW_META_ELEMENT_ID,
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
  /** Wider than the viewport by this many px (0 = fits). */
  overflowX: number;
  /** Boxes hiding content behind a scrollbar, by block. */
  clipped: Array<{ block_id: string | null; element: string; hidden_px: { x: number; y: number } }>;
  /** chunk number (1-based) → base64 JPEG. */
  images: Map<number, string>;
  backend: RenderBackend;
}

const NAVIGATION_TIMEOUT_MS = 45_000;
const HIGHLIGHT_COLOR = '#f97316';

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
        overflowX: measured.overflowX,
        clipped: measured.clipped,
        images,
        backend,
      };
    }
  );
}
