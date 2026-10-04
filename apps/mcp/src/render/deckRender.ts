/**
 * Drive the slides app's `/:slideId/render-view` page: step through the
 * requested slides, measure each, screenshot the ones asked for, and
 * optionally compose a contact sheet — all in one browser visit.
 */

import {
  VIEW_API_GLOBAL,
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
import { RenderError, withRenderPage, type RenderBackend } from './browser.ts';

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
      await page.waitForSelector(VIEW_READY_SELECTOR, {
        state: 'attached',
        timeout: READY_TIMEOUT_MS,
      });
      const meta = (await page.evaluate(
        name => (window as unknown as Record<string, { meta: DeckViewMeta }>)[name].meta,
        VIEW_API_GLOBAL
      )) as DeckViewMeta;

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
        const measured = (await page.evaluate(
          ([name, slideId]) =>
            (
              window as unknown as Record<
                string,
                { show: (id: string) => Promise<SlideMeasure | { error: string }> }
              >
            )[name].show(slideId),
          [VIEW_API_GLOBAL, id] as const
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
        const box = await page.evaluate(() => {
          const main = document.querySelector('main');
          return { width: main?.scrollWidth ?? 800, height: main?.scrollHeight ?? 600 };
        });
        await page.setViewportSize({ width: box.width, height: Math.min(box.height, 8000) });
        // Let the compositor catch up with the resize before capturing, or the
        // capture can show the previous surface tiled into the new size.
        await page.evaluate(
          () =>
            new Promise<void>(resolve =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
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
