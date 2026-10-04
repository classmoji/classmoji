/**
 * Renders of a deck for an agent: resolve which copy and version it asked
 * for, serve what the cache already holds, render the rest in one browser
 * visit, and shape the result as MCP content (JSON + JPEG image blocks).
 *
 * Shared by `deck_render` and `deck_apply`'s `render: true`.
 */

import { createHash } from 'node:crypto';
import type { SlideMeasure, ViewAt } from '@classmoji/services/render-contract';
import type { DeckJson, DeckSlide } from '@classmoji/services/slides';
import { ToolError } from '../mcp/errors.ts';
import type { ToolResult } from '../mcp/registry.ts';
import { RenderError } from './browser.ts';
import { LruCache } from './cache.ts';
import { renderDeck, type DeckRenderResult } from './deckRender.ts';

/** Single-image width (px): ~480×350 for the default deck. */
export const IMAGE_WIDTH = 480;
export const IMAGE_WIDTH_HI_RES = 960;
const JPEG_QUALITY = 70;
/** Slides per contact sheet. */
export const SHEET_SIZE = 24;
/** Single images per call. */
export const MAX_SINGLE_IMAGES = 12;

const measureCache = new LruCache<SlideMeasure>(4000);
const imageCache = new LruCache<string>(400);
const sheetCache = new LruCache<string>(60);

/** For tests. */
export function clearRenderCaches(): void {
  measureCache.clear();
  imageCache.clear();
  sheetCache.clear();
}

export interface DeckRenderTarget {
  slide: {
    id: string;
    classroom_id: string;
    classroom: { content_key_version?: unknown; [key: string]: unknown };
  };
  at: ViewAt;
  /** The version the caller's read saw, or null when unknown. */
  version: string | null;
  /** The deck as read (validates ids and orders them). */
  deck: DeckJson;
}

export interface DeckRenderOptions {
  /** Slides to check, in deck order. */
  ids: string[];
  /** Single images for these (≤ MAX_SINGLE_IMAGES). */
  imageIds: string[];
  /** One contact sheet of these. */
  sheetIds: string[];
  hiRes: boolean;
}

/** Every slide id in deck order; a stack's container is left out (it shows its first child). */
export function deckSlideOrder(deck: DeckJson): Array<{ id: string; index: string }> {
  const out: Array<{ id: string; index: string }> = [];
  deck.slides.forEach((slide: DeckSlide, h: number) => {
    const children = slide.children ?? [];
    if (children.length === 0) out.push({ id: slide.id, index: String(h + 1) });
    children.forEach((child, v) => out.push({ id: child.id, index: `${h + 1}.${v + 1}` }));
  });
  return out;
}

/** Every id the deck knows, stack containers included. */
export function deckIdSet(deck: DeckJson): Set<string> {
  const ids = new Set<string>();
  for (const slide of deck.slides) {
    ids.add(slide.id);
    for (const child of slide.children ?? []) ids.add(child.id);
  }
  return ids;
}

export function slidesOrigin(): string | null {
  const base =
    process.env.SLIDES_URL?.trim() ||
    (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:6500');
  return base ? base.replace(/\/+$/, '') : null;
}

function keyVersion(classroom: { content_key_version?: unknown }): number {
  const v = Number(classroom.content_key_version ?? 0);
  return Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

const mKey = (deckId: string, version: string, id: string) => `${deckId}|${version}|m|${id}`;
const iKey = (deckId: string, version: string, width: number, id: string) =>
  `${deckId}|${version}|i${width}|${id}`;
const sKey = (deckId: string, version: string, ids: string[]) =>
  `${deckId}|${version}|s|${createHash('sha1').update(ids.join(',')).digest('hex')}`;

/** A content address worth caching under (a read with no version is not). */
function cacheable(version: string | null): version is string {
  return Boolean(version && version !== 'unknown' && version !== 'head');
}

export interface DeckRenderOutcome {
  version: string;
  width: number;
  height: number;
  measures: Map<string, SlideMeasure>;
  images: Map<string, string>;
  sheet: string | null;
  cached: boolean;
  ms: number;
}

/** Cache first, then one render for whatever is missing. */
export async function renderDeckFor(
  target: DeckRenderTarget,
  options: DeckRenderOptions
): Promise<DeckRenderOutcome> {
  const started = Date.now();
  const deckId = target.slide.id;
  const width = options.hiRes ? IMAGE_WIDTH_HI_RES : IMAGE_WIDTH;
  const deckWidth = Number(target.deck.config?.width) || 960;
  const deckHeight = Number(target.deck.config?.height) || 700;

  const measures = new Map<string, SlideMeasure>();
  const images = new Map<string, string>();
  let sheet: string | null = null;

  if (cacheable(target.version)) {
    const v = target.version;
    for (const id of options.ids) {
      const m = measureCache.get(mKey(deckId, v, id));
      if (m) measures.set(id, m);
    }
    for (const id of options.imageIds) {
      const img = imageCache.get(iKey(deckId, v, width, id));
      if (img) images.set(id, img);
    }
    if (options.sheetIds.length) sheet = sheetCache.get(sKey(deckId, v, options.sheetIds)) ?? null;
    const complete =
      measures.size === options.ids.length &&
      images.size === options.imageIds.length &&
      (options.sheetIds.length === 0 || sheet !== null);
    if (complete) {
      return {
        version: v,
        width: deckWidth,
        height: deckHeight,
        measures,
        images,
        sheet,
        cached: true,
        ms: Date.now() - started,
      };
    }
  }

  const origin = slidesOrigin();
  if (!origin) {
    throw new ToolError(
      'internal',
      'Rendering is not configured here (SLIDES_URL is unset).',
      'RENDER_UNAVAILABLE'
    );
  }

  // Render what is missing: every id still unmeasured, every image not cached,
  // and the whole sheet when it is not cached.
  const needImages = options.imageIds.filter(id => !images.has(id));
  const needSheet = options.sheetIds.length > 0 && sheet === null ? options.sheetIds : [];
  const needIds = options.ids.filter(
    id => !measures.has(id) || needImages.includes(id) || needSheet.includes(id)
  );

  let result: DeckRenderResult;
  try {
    result = await renderDeck({
      origin,
      slideId: deckId,
      classroomId: target.slide.classroom_id,
      keyVersion: keyVersion(target.slide.classroom),
      at: target.at,
      pin: target.version,
      ids: needIds,
      imageIds: needImages,
      sheetIds: needSheet,
      width,
      quality: JPEG_QUALITY,
    });
  } catch (error) {
    if (error instanceof RenderError) {
      throw new ToolError('internal', error.message, error.code);
    }
    throw new ToolError(
      'internal',
      `The deck could not be rendered: ${error instanceof Error ? error.message : String(error)}`,
      'RENDER_FAILED'
    );
  }

  // A newer version than the caller read means an edit landed in between;
  // whatever the cache gave us belongs to the older one, so start over from
  // what the page actually rendered.
  if (cacheable(target.version) && result.version !== target.version) {
    measures.clear();
    images.clear();
  }
  for (const m of result.measures) {
    measures.set(m.id, m);
    if (cacheable(result.version)) measureCache.set(mKey(deckId, result.version, m.id), m);
  }
  for (const [id, img] of result.images) {
    images.set(id, img);
    if (cacheable(result.version)) imageCache.set(iKey(deckId, result.version, width, id), img);
  }
  if (result.sheet) {
    sheet = result.sheet;
    if (cacheable(result.version)) {
      sheetCache.set(sKey(deckId, result.version, options.sheetIds), result.sheet);
    }
  }
  return {
    version: result.version,
    width: result.width,
    height: result.height,
    measures,
    images,
    sheet,
    cached: false,
    ms: Date.now() - started,
  };
}

/** Only the non-zero sides. */
function compactOverflow(m: SlideMeasure): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [side, px] of Object.entries(m.overflow_px)) if (px > 0) out[side] = px;
  return out;
}

/** The overflow report: only slides that overflow or clip something. */
export function overflowReport(
  ids: string[],
  measures: Map<string, SlideMeasure>
): {
  overflow: Array<Record<string, unknown>>;
  clipped: Array<Record<string, unknown>>;
  fits: number;
} {
  const overflow: Array<Record<string, unknown>> = [];
  const clipped: Array<Record<string, unknown>> = [];
  let fits = 0;
  for (const id of ids) {
    const m = measures.get(id);
    if (!m) continue;
    const over = compactOverflow(m);
    if (Object.keys(over).length > 0) {
      overflow.push({
        slide_id: id,
        index: m.index,
        overflow_px: over,
        ...(m.element ? { element: m.element } : {}),
      });
    } else {
      fits += 1;
    }
    for (const c of m.clipped ?? []) {
      clipped.push({ slide_id: id, index: m.index, element: c.element, hidden_px: c.hidden_px });
    }
  }
  return { overflow, clipped, fits };
}

/** Image content blocks. Typed as text blocks only because ToolResult is. */
export function imageBlocks(images: string[]): ToolResult['content'] {
  return images.map(
    data =>
      ({ type: 'image', data, mimeType: 'image/jpeg' }) as unknown as ToolResult['content'][number]
  );
}
