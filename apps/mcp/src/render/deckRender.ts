/**
 * Drive the slides app's `/:slideId/render-view` page: step through the
 * requested slides, measure each, screenshot the ones asked for, and
 * optionally compose a contact sheet — all in one browser visit.
 */

import {
  VIEW_API_GLOBAL,
  VIEW_META_ELEMENT_ID,
  VIEW_READY_SELECTOR,
  deckViewUrl,
  viewTarget,
  viewTokenCookie,
  type DeckViewMeta,
  type SlideMeasure,
  type ViewAt,
} from '@classmoji/services/render-contract';
import { signDocViewToken } from '@classmoji/services/render-token';
import type { Page } from 'playwright-core';
import {
  EVALUATE_DEADLINE_MS,
  RenderError,
  within,
  withRenderPage,
  type RenderBackend,
} from './browser.ts';

export interface DeckRenderRequest {
  /** Slides app origin (SLIDES_URL). */
  origin: string;
  slideId: string;
  classroomId: string;
  keyVersion: number;
  at: ViewAt;
  /** The version the caller read (`live:E.V`, a blob sha); bound into the token. */
  pin: string | null;
  /** Slides to visit and measure, in order. */
  ids: string[];
  /** Of those, the ones to screenshot one by one. */
  imageIds: string[];
  /** Compose these (already visited) into one contact-sheet image. */
  sheetIds?: string[];
  /** Image width in CSS px; the height follows the deck's aspect. */
  width: number;
  /** JPEG quality, 1-100. */
  quality: number;
}

export interface DeckRenderResult {
  /** What the page actually rendered (may be newer than `pin`). */
  version: string;
  width: number;
  height: number;
  measures: SlideMeasure[];
  /** slide id → base64 JPEG. */
  images: Map<string, string>;
  /** base64 JPEG of the contact sheet. */
  sheet?: string;
  backend: RenderBackend;
}

/** Sheet geometry: columns and each tile's width in px. */
const SHEET_COLUMNS = 6;
const SHEET_TILE_WIDTH = 240;

/** Navigation budget: the slides app may be a cold Fly machine. */
const NAVIGATION_TIMEOUT_MS = 45_000;
const READY_TIMEOUT_MS = 20_000;

function heightFor(width: number, meta: { width: number; height: number }): number {
  return Math.max(1, Math.round((width * meta.height) / meta.width));
}

async function screenshot(page: Page, quality: number): Promise<string> {
  const buffer = await page.screenshot({ type: 'jpeg', quality, animations: 'disabled' });
  return buffer.toString('base64');
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c
  );
}

function overflows(m: SlideMeasure | undefined): boolean {
  if (!m) return false;
  const o = m.overflow_px;
  return o.top + o.right + o.bottom + o.left > 0;
}

/** The contact sheet, composed in the browser itself from the captured tiles. */
export function sheetHtml(
  tiles: Array<{ id: string; index: string; image: string; overflow: boolean }>,
  aspect: number
): string {
  const tileHeight = Math.round(SHEET_TILE_WIDTH * aspect);
  const cells = tiles
    .map(
      tile => `<figure class="${tile.overflow ? 'over' : ''}">
  <img src="data:image/jpeg;base64,${tile.image}" width="${SHEET_TILE_WIDTH}" height="${tileHeight}">
  <figcaption><b>${escapeHtml(tile.index)}</b> ${escapeHtml(tile.id)}${tile.overflow ? ' <i>overflow</i>' : ''}</figcaption>
</figure>`
    )
    .join('\n');
  return `<!doctype html><html><head><style>
  html, body { margin: 0; background: #f4f4f5; font: 12px/1.3 -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; color: #27272a; }
  main { display: grid; grid-template-columns: repeat(${Math.min(SHEET_COLUMNS, Math.max(1, tiles.length))}, ${SHEET_TILE_WIDTH}px); gap: 10px; padding: 10px; width: max-content; }
  figure { margin: 0; }
  img { display: block; outline: 1px solid #d4d4d8; background: #fff; }
  figure.over img { outline: 3px solid #dc2626; }
  figcaption { padding-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: ${SHEET_TILE_WIDTH}px; }
  i { color: #dc2626; font-style: normal; font-weight: 600; }
</style></head><body><main>
${cells}
</main></body></html>`;
}

/** The meta blob out of the served HTML, or null. Exported for tests. */
export function metaFromHtml(html: string): DeckViewMeta | null {
  const at = html.indexOf(`id="${VIEW_META_ELEMENT_ID}"`);
  if (at === -1) return null;
  const start = html.indexOf('>', at) + 1;
  const end = html.indexOf('</script>', start);
  if (start <= 0 || end === -1) return null;
  try {
    const meta = JSON.parse(html.slice(start, end)) as DeckViewMeta;
    return meta?.kind === 'deck' && Array.isArray(meta.slides) ? meta : null;
  } catch {
    return null;
  }
}

export async function renderDeck(request: DeckRenderRequest): Promise<DeckRenderResult> {
  const token = await signDocViewToken({
    origin: request.origin,
    classroomId: request.classroomId,
    kind: 'deck',
    docId: request.slideId,
    target: viewTarget(request.at, request.pin),
    keyVersion: request.keyVersion,
  });
  if (!token) {
    throw new RenderError(
      'RENDER_UNAVAILABLE',
      'Rendering is not configured on this server (no content signing secret).'
    );
  }
  const url = deckViewUrl(request.origin, request.slideId, request.at, request.pin);
  const initialHeight = heightFor(request.width, { width: 960, height: 700 });

  return withRenderPage(
    {
      width: request.width,
      height: initialHeight,
      cookie: viewTokenCookie(request.origin, token),
      origin: request.origin,
    },
    async (page, backend) => {
      const response = await page.goto(url, {
        waitUntil: 'load',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      if (!response || response.status() !== 200) {
        throw new RenderError(
          'RENDER_FAILED',
          `The render page answered ${response ? response.status() : 'nothing'}.`
        );
      }
      // The meta (version rendered, logical size) is read from the RESPONSE,
      // not the window: the page runs the deck author's scripts, which could
      // rewrite anything in the DOM before we asked.
      const meta = metaFromHtml(await response.text());
      if (!meta) throw new RenderError('RENDER_FAILED', 'The render page carried no meta.');
      await page.waitForSelector(VIEW_READY_SELECTOR, {
        state: 'attached',
        timeout: READY_TIMEOUT_MS,
      });

      const height = heightFor(request.width, meta);
      if (height !== initialHeight) {
        await page.setViewportSize({ width: request.width, height });
      }

      const wantImage = new Set(request.imageIds);
      const wantSheet = new Set(request.sheetIds ?? []);
      const measures: SlideMeasure[] = [];
      const images = new Map<string, string>();
      const tiles = new Map<string, string>();

      for (const id of request.ids) {
        // Measurements come from the page and are trusted as far as the deck's
        // own scripts are: they can only misreport their own deck, and the
        // cache key's deck id comes from the server-side load, not from here.
        const measured = (await within(
          page.evaluate(
            ([name, slideId]) =>
              (
                window as unknown as Record<
                  string,
                  { show: (id: string) => Promise<SlideMeasure | { error: string }> }
                >
              )[name].show(slideId),
            [VIEW_API_GLOBAL, id] as const
          ),
          EVALUATE_DEADLINE_MS,
          `Rendering slide ${id}`
        )) as SlideMeasure | { error: string };
        if (!measured || 'error' in measured) {
          console.warn('[render] slide not rendered', id, JSON.stringify(measured ?? null));
          continue;
        }
        measures.push(measured);
        if (wantImage.has(id) || wantSheet.has(id)) {
          const shot = await screenshot(page, request.quality);
          if (wantImage.has(id)) images.set(id, shot);
          if (wantSheet.has(id)) tiles.set(id, shot);
        }
      }

      let sheet: string | undefined;
      if (wantSheet.size > 0 && tiles.size > 0) {
        const byId = new Map(measures.map(m => [m.id, m]));
        const ordered = (request.sheetIds ?? [])
          .filter(id => tiles.has(id))
          .map(id => ({
            id,
            index: byId.get(id)?.index ?? '?',
            image: tiles.get(id) ?? '',
            overflow: overflows(byId.get(id)),
          }));
        await page.setViewportSize({ width: 200, height: 200 });
        await page.setContent(sheetHtml(ordered, meta.height / meta.width), {
          waitUntil: 'load',
        });
        const box = await within(
          page.evaluate(() => {
            const main = document.querySelector('main');
            return { width: main?.scrollWidth ?? 800, height: main?.scrollHeight ?? 600 };
          }),
          EVALUATE_DEADLINE_MS,
          'Laying out the contact sheet'
        );
        await page.setViewportSize({ width: box.width, height: Math.min(box.height, 8000) });
        // Let the compositor catch up with the resize before capturing, or the
        // capture can show the previous surface tiled into the new size.
        await within(
          page.evaluate(
            () =>
              new Promise<void>(resolve =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
              )
          ),
          EVALUATE_DEADLINE_MS,
          'Painting the contact sheet'
        );
        const buffer = await page
          .locator('main')
          .screenshot({ type: 'jpeg', quality: request.quality, animations: 'disabled' });
        sheet = buffer.toString('base64');
      }

      return {
        version: meta.version,
        width: meta.width,
        height: meta.height,
        measures,
        images,
        ...(sheet ? { sheet } : {}),
        backend,
      };
    }
  );
}
