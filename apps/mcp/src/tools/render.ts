/**
 * deck_render / page_render — let an agent SEE what it edits.
 *
 * An agent editing a deck through deck_apply works blind: it never sees a
 * slide. These tools render the real document in a headless browser
 * (Cloudflare Browser Run in production, a local Chrome in dev — see
 * render/browser.ts) through token-gated render routes in the slides and
 * pages apps, and return JPEG image content plus a measurement report: for a
 * deck, how far each slide's content runs past the deck's logical size.
 *
 * Tier: the READ gate, exactly as deck_get / page_content_get — any
 * teaching-team member who may read the document may render it (rendering is
 * a read; it writes nothing). The render route itself trusts only the
 * short-lived view token this server mints after that gate passes.
 */

import { getDeckPreviewStatus, type DeckJson } from '@classmoji/services/slides';
import type { ViewAt } from '@classmoji/services/render-contract';
import { z } from 'zod';
import { liveSha, liveStateFor } from '../collab/client.ts';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../mcp/registry.ts';
import {
  IMAGE_WIDTH,
  IMAGE_WIDTH_HI_RES,
  MAX_SINGLE_IMAGES,
  SHEET_SIZE,
  deckIdSet,
  deckSlideOrder,
  imageBlocks,
  overflowReport,
  renderDeckFor,
} from '../render/deckAgent.ts';
import { LEGACY_GUIDANCE, loadDeckForTool, previewReadRef, readLiveDeck } from './deck.ts';
import { loadSlideInClassroom, TEACHING_TEAM, type SlideWithRepoRecord } from './shared.ts';

/** Renders are heavier than reads: a smaller bucket than the default. */
const RENDER_RATE_LIMIT = { capacity: 12, refillPerSecond: 0.2 };

/** Which copy, and the deck as read there, with its version. */
export async function readDeckForRender(
  slide: SlideWithRepoRecord,
  at: ViewAt,
  viewerId: string
): Promise<{ deck: DeckJson; version: string | null; note?: string }> {
  let ref: string | undefined;
  if (at === 'preview') {
    ref = previewReadRef(slide, 'preview', await getDeckPreviewStatus(slide));
  }
  let note: string | undefined;
  const liveState = liveStateFor(slide.classroom);
  if (liveState && !ref) {
    const live = await readLiveDeck(liveState.env, slide, viewerId);
    if ('snapshot' in live) {
      return {
        deck: live.snapshot.content,
        version: liveSha(live.snapshot.epoch, live.snapshot.version),
      };
    }
    if (live.fallbackNote) note = live.fallbackNote;
  }
  const loaded = await loadDeckForTool(slide, ref);
  if ('parseError' in loaded) throw new ToolError('invalid_params', LEGACY_GUIDANCE);
  return { deck: loaded.deck, version: loaded.sha ?? null, ...(note ? { note } : {}) };
}

export interface DeckRenderArgs {
  classroom: string;
  slide_id: string;
  slide_ids?: string[];
  at?: 'main' | 'live' | 'preview';
  images?: boolean;
  sheet?: boolean;
  sheet_page?: number;
  hi_res?: boolean;
}

/**
 * The shared body of deck_render and deck_apply's `render: true`: render
 * `selected` (deck order, validated) and shape the result.
 */
export async function deckRenderResult(
  slide: SlideWithRepoRecord,
  read: { deck: DeckJson; version: string | null; note?: string },
  at: ViewAt,
  selected: string[],
  opts: { images: boolean; sheet: boolean; sheetPage: number; hiRes: boolean }
): Promise<{ payload: Record<string, unknown>; images: string[] }> {
  const indexOf = new Map<string, string>();
  for (const entry of deckSlideOrder(read.deck)) indexOf.set(entry.id, entry.index);
  read.deck.slides.forEach((s, h) => {
    if (!indexOf.has(s.id)) indexOf.set(s.id, String(h + 1));
  });

  const pages = Math.max(1, Math.ceil(selected.length / SHEET_SIZE));
  const page = Math.min(Math.max(1, opts.sheetPage), pages);
  const sheetIds =
    opts.images && opts.sheet ? selected.slice((page - 1) * SHEET_SIZE, page * SHEET_SIZE) : [];
  const imageIds = opts.images && !opts.sheet ? selected : [];

  const outcome = await renderDeckFor(
    { slide, at, version: read.version, deck: read.deck },
    { ids: selected, imageIds, sheetIds, hiRes: opts.hiRes }
  );
  const report = overflowReport(selected, outcome.measures);
  const missing = selected.filter(id => !outcome.measures.has(id));

  const notes: string[] = [];
  if (read.note) notes.push(read.note);
  if (read.version && outcome.version !== read.version) {
    notes.push(`The deck changed after it was read (${read.version}); this is ${outcome.version}.`);
  }

  const images: string[] = [];
  const shown: Array<{ slide_id: string; index: string }> = [];
  for (const id of imageIds) {
    const img = outcome.images.get(id);
    if (!img) continue;
    images.push(img);
    shown.push({ slide_id: id, index: indexOf.get(id) ?? '?' });
  }
  if (outcome.sheet) images.push(outcome.sheet);

  const payload: Record<string, unknown> = {
    slide_id: slide.id,
    at,
    version: outcome.version,
    size: { width: outcome.width, height: outcome.height },
    checked: selected.length,
    fits: report.fits,
    overflow: report.overflow,
    ...(report.clipped.length ? { clipped: report.clipped } : {}),
    ...(missing.length ? { not_rendered: missing } : {}),
    ...(shown.length
      ? { images: shown, image_width: opts.hiRes ? IMAGE_WIDTH_HI_RES : IMAGE_WIDTH }
      : {}),
    ...(outcome.sheet
      ? {
          sheet: {
            page,
            pages,
            from: indexOf.get(sheetIds[0]) ?? null,
            to: indexOf.get(sheetIds[sheetIds.length - 1]) ?? null,
            slides: sheetIds.length,
          },
        }
      : {}),
    cached: outcome.cached,
    ms: outcome.ms,
    ...(notes.length ? { note: notes.join(' ') } : {}),
  };
  return { payload, images };
}

export function withImages(payload: Record<string, unknown>, images: string[]): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }, ...imageBlocks(images)],
  };
}

/** Changed slides an apply reports, at most this many get images. */
const APPLY_RENDER_MAX = 6;

/** The slide ids an apply's `applied` entries changed (deleted ones aside). */
export function changedSlideIds(applied: unknown): string[] {
  const out: string[] = [];
  const add = (id: unknown) => {
    if (typeof id === 'string' && !out.includes(id)) out.push(id);
  };
  if (!Array.isArray(applied)) return out;
  for (const entry of applied as Array<Record<string, unknown>>) {
    if (entry.op === 'update' || entry.op === 'move') add(entry.id);
    if (entry.op === 'insert') {
      for (const id of Array.isArray(entry.ids) ? entry.ids : []) {
        const kids = (entry.children as Record<string, unknown[]> | undefined)?.[id as string];
        // A new stack shows its children, not the container.
        if (Array.isArray(kids) && kids.length > 0) kids.forEach(add);
        else add(id);
      }
    }
  }
  return out;
}

/**
 * `deck_apply` with `render: true`: the apply's own result, plus a `render`
 * block (images and overflow of the slides it changed). A render that fails
 * never fails the apply — the edit has landed; `render_error` says why there
 * is no picture.
 */
export async function renderAfterDeckApply(
  result: ToolResult,
  slideId: string,
  ctx: ToolContext
): Promise<ToolResult> {
  if (result.isError) return result;
  const first = result.content[0];
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(first?.type === 'text' ? first.text : '{}') as Record<string, unknown>;
  } catch {
    return result;
  }
  const changed = changedSlideIds(payload.applied);
  if (changed.length === 0) {
    return withImages({ ...payload, render: { note: 'No slide content changed to show.' } }, []);
  }
  try {
    const slide = await loadSlideInClassroom(slideId, ctx);
    const at: ViewAt = payload.committed_to === 'preview' ? 'preview' : 'main';
    const read = await readDeckForRender(slide, at, ctx.viewer.userId);
    const known = deckIdSet(read.deck);
    const present = changed.filter(id => known.has(id));
    const shown = present.slice(0, APPLY_RENDER_MAX);
    const { payload: render, images } = await deckRenderResult(slide, read, at, shown, {
      images: true,
      sheet: false,
      sheetPage: 1,
      hiRes: false,
    });
    const { slide_id: _slideId, ...rest } = render;
    const notShown = present.slice(APPLY_RENDER_MAX);
    return withImages(
      { ...payload, render: { ...rest, ...(notShown.length ? { not_shown: notShown } : {}) } },
      images
    );
  } catch (error) {
    return withImages(
      {
        ...payload,
        render_error: error instanceof Error ? error.message : String(error),
      },
      []
    );
  }
}

export const deckRenderTool: ToolDefinition<DeckRenderArgs> = {
  name: 'deck_render',
  title: 'Render deck slides',
  rateLimit: RENDER_RATE_LIMIT,
  description:
    'Renders a deck so you can SEE it: the real reveal.js slides (theme, custom CSS, every ' +
    'fragment shown) as JPEG images, plus an overflow report — per slide, how many px content ' +
    "runs past the deck's size (960x700 unless the deck sets one) and the element that does it, " +
    'and boxes (code blocks) that hide content behind a scrollbar. Use it after edits. ' +
    'slide_ids picks slides, returned as single ~480px images (up to 12); without slide_ids ' +
    'you get a contact sheet of the whole deck, 24 slides per sheet (sheet_page for more), ' +
    'overflowing slides outlined in red. images: false returns only the overflow report for ' +
    'every selected slide — cheap, use it for whole-deck checks. at: main (alias live) is the ' +
    'deck itself, the live document when live editing is on; at: preview is the pending ' +
    'preview. hi_res: 960px images for reading small text. Renders are cached per version.',
  scope: 'read',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    slide_id: z.string().uuid().describe('Slide deck id'),
    slide_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(200)
      .optional()
      .describe('Slides to render (ids from deck_outline); omit for the whole deck'),
    at: z
      .enum(['main', 'live', 'preview'])
      .optional()
      .describe("'main' (default; 'live' is the same) or the pending 'preview'"),
    images: z
      .boolean()
      .optional()
      .describe('false = overflow report only, no images (default true)'),
    sheet: z
      .boolean()
      .optional()
      .describe(
        'One contact-sheet image instead of single images (default: true without slide_ids)'
      ),
    sheet_page: z.number().int().min(1).optional().describe('Which sheet of 24 (default 1)'),
    hi_res: z.boolean().optional().describe('960px-wide single images instead of 480px'),
  },
  handler: async (args, ctx) => {
    // No assertSlideEditable: rendering is a read, gated like deck_get.
    const slide = await loadSlideInClassroom(args.slide_id, ctx);
    const at: ViewAt = args.at === 'preview' ? 'preview' : 'main';
    const read = await readDeckForRender(slide, at, ctx.viewer.userId);

    const known = deckIdSet(read.deck);
    let selected: string[];
    if (args.slide_ids?.length) {
      selected = [];
      for (const id of args.slide_ids) {
        if (!known.has(id)) {
          throw new ToolError(
            'invalid_params',
            `Unknown slide id '${id}' — call deck_outline for current ids`
          );
        }
        if (!selected.includes(id)) selected.push(id);
      }
    } else {
      selected = deckSlideOrder(read.deck).map(entry => entry.id);
    }
    if (selected.length === 0) {
      return withImages({ slide_id: slide.id, at, version: read.version, checked: 0 }, []);
    }

    const images = args.images !== false;
    const sheet = images && (args.sheet ?? !args.slide_ids?.length);
    if (images && !sheet && selected.length > MAX_SINGLE_IMAGES) {
      throw new ToolError(
        'invalid_params',
        `At most ${MAX_SINGLE_IMAGES} single images per call (${selected.length} asked) — pass ` +
          'sheet: true for a contact sheet, images: false for the overflow report only, or fewer ' +
          'slide_ids.'
      );
    }

    const { payload, images: blocks } = await deckRenderResult(slide, read, at, selected, {
      images,
      sheet,
      sheetPage: args.sheet_page ?? 1,
      hiRes: args.hi_res === true,
    });
    return withImages(payload, blocks);
  },
};
