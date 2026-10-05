/**
 * Agent pointers in live editing: page_cursor_set puts the agent's caret (or a
 * selection) in a page people have open; deck_cursor_set shows which slide it
 * is on and where its pointer arrow sits on it. Neither changes content —
 * they move the agent's presence (collab
 * `POST /internal/:kind/:id/cursor`), so they need no version pin and write no
 * audit row. Gated exactly like the apply tools they accompany: the same
 * roles, the same record loaders, the deck's assistant sub-gate, and a write
 * scope (an agent that may not edit has nothing to point at).
 */

import { z } from 'zod';
import { DECK_SLIDE_SIZE, type CursorRequest } from '@classmoji/collab';
import {
  CollabRequestError,
  actorFor,
  fetchSnapshot,
  liveStateFor,
  liveWriteError,
  postCursor,
  requireLiveEnv,
} from '../collab/client.ts';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
  OWNER_TEACHER,
  TEACHING_TEAM,
  assertSlideEditable,
  loadPageWithRepoInClassroom,
  loadSlideInClassroom,
  ok,
} from './shared.ts';

const NOT_LIVE = (what: 'page' | 'deck') =>
  new ToolError(
    'invalid_params',
    `This classroom does not edit ${what}s live, so there is no one to point at it for.`,
    'LIVE_ONLY'
  );

const NOBODY_HERE = 'Nobody has it open right now, so no one sees this.';

/**
 * The live deck's slide size (`config.width/height`, as renders use it), or
 * the default when it sets none or cannot be read (a read with no viewer:
 * nothing is remembered as the agent's read).
 */
async function deckSize(
  env: Parameters<typeof fetchSnapshot>[0],
  deckId: string
): Promise<{ width: number; height: number }> {
  const known = sizes.get(deckId);
  if (known && Date.now() - known.at < SIZE_TTL_MS) return known.size;
  try {
    const snapshot = await fetchSnapshot(env, 'deck', deckId);
    const config = (snapshot.content as { config?: { width?: unknown; height?: unknown } }).config;
    const width = Number(config?.width);
    const height = Number(config?.height);
    const size = {
      width: Number.isFinite(width) && width > 0 ? width : DECK_SLIDE_SIZE.width,
      height: Number.isFinite(height) && height > 0 ? height : DECK_SLIDE_SIZE.height,
    };
    sizes.delete(deckId);
    sizes.set(deckId, { size, at: Date.now() });
    if (sizes.size > SIZE_MAX) sizes.delete(sizes.keys().next().value as string);
    return size;
  } catch {
    return DECK_SLIDE_SIZE;
  }
}

/** Deck sizes rarely change: one read per deck per few minutes, not per pointer move. */
const SIZE_TTL_MS = 5 * 60 * 1000;
const SIZE_MAX = 500;
const sizes = new Map<string, { size: { width: number; height: number }; at: number }>();

/** Tests only. */
export function clearDeckSizeCache(): void {
  sizes.clear();
}

/** A 404 from collab names the missing block/slide; anything else maps like a write. */
function cursorError(error: unknown, what: 'page' | 'deck', id: string): Error {
  if (error instanceof CollabRequestError && error.status === 404 && error.code === 'not-found') {
    const item = what === 'page' ? 'Block' : 'Slide';
    const read = what === 'page' ? 'page_content_outline' : 'deck_outline';
    return new ToolError('not_found', `${item} '${id}' is not in the live ${what} — see ${read}`);
  }
  return liveWriteError(error, what, { previewHint: false });
}

const pointShape = {
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Characters into the block's text (clamped to its length); wins over at"),
  at: z.enum(['start', 'end']).optional().describe("Without offset: 'start' or 'end' (default)"),
};

interface PageCursorSetArgs {
  classroom: string;
  page_id: string;
  block_id: string;
  offset?: number;
  at?: 'start' | 'end';
  select_to?: { block_id?: string; offset?: number; at?: 'start' | 'end' };
}

export const pageCursorSetTool: ToolDefinition<PageCursorSetArgs> = {
  name: 'page_cursor_set',
  annotations: { destructive: false, idempotent: true, openWorld: false },
  title: 'Point at text in a live page',
  description:
    'Puts your caret, or a selection, in a page people are editing live, to show them what ' +
    'you are looking at or about to change. Changes no content. Only for classrooms with live ' +
    'editing: everyone with the page open sees it under your name, in your colour, until about ' +
    'a minute after your last edit or move. block_id comes from page_content_outline/get; ' +
    "offset counts characters into the block's text, else at: 'start' or 'end' (default). " +
    'select_to selects from there to a second point (its block_id defaults to the same block). ' +
    "An apply in mode: 'live' already leaves your caret at the end of what it wrote.",
  scope: 'write',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    page_id: z.string().uuid().describe('Page id'),
    block_id: z.string().min(1).max(200).describe('Block to put the caret in'),
    ...pointShape,
    select_to: z
      .object({
        block_id: z.string().min(1).max(200).optional(),
        ...pointShape,
      })
      .strict()
      .optional()
      .describe('The other end of a selection'),
  },
  handler: async (args, ctx) => {
    const page = await loadPageWithRepoInClassroom(args.page_id, ctx);
    const liveState = liveStateFor(page.classroom);
    if (!liveState) throw NOT_LIVE('page');
    const env = requireLiveEnv(liveState);
    const point = (p: { block_id?: string; offset?: number; at?: 'start' | 'end' }) => ({
      ...(p.block_id ? { blockId: p.block_id } : {}),
      ...(p.offset !== undefined ? { offset: p.offset } : {}),
      ...(p.at ? { at: p.at } : {}),
    });
    const request: CursorRequest = {
      actor: await actorFor(ctx),
      page: {
        blockId: args.block_id,
        ...point({ offset: args.offset, at: args.at }),
        ...(args.select_to ? { selectTo: point(args.select_to) } : {}),
      },
    };
    let shown: boolean;
    try {
      ({ shown } = await postCursor(env, 'page', page.id, request));
    } catch (error) {
      throw cursorError(error, 'page', args.select_to?.block_id ?? args.block_id);
    }
    return ok({ success: true, shown, ...(shown ? {} : { note: NOBODY_HERE }) });
  },
};

interface DeckCursorSetArgs {
  classroom: string;
  slide_id: string;
  slide: string;
  x?: number;
  y?: number;
}

export const deckCursorSetTool: ToolDefinition<DeckCursorSetArgs> = {
  name: 'deck_cursor_set',
  annotations: { destructive: false, idempotent: true, openWorld: false },
  title: 'Point at a slide in a live deck',
  description:
    'Shows people editing a deck live which slide you are looking at or about to change: your ' +
    'avatar sits on that slide, in the editor and the slide overview, and a pointer arrow sits ' +
    'on the slide itself, under your name and in your colour, until about a minute after your ' +
    'last edit or move. Changes no content. Only for classrooms with live editing. slide is ' +
    'the id deck_outline lists. x and y place the arrow in the slide coordinates deck_render ' +
    "and block boxes use: 0 to the deck's width (left to right) and 0 to its height (top to " +
    `bottom), ${DECK_SLIDE_SIZE.width}×${DECK_SLIDE_SIZE.height} unless the deck sets its ` +
    "own size; a coordinate left out is the slide's centre. Calling again moves the arrow. " +
    "A deck_apply in mode: 'live' already points at the slides it changes.",
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    slide_id: z.string().uuid().describe('Slide deck id'),
    slide: z.string().min(1).max(200).describe('Id of the slide to point at (from deck_outline)'),
    x: z
      .number()
      .min(0)
      .max(100_000)
      .optional()
      .describe("Arrow position across the slide, 0 (left) to the deck's width (right)"),
    y: z
      .number()
      .min(0)
      .max(100_000)
      .optional()
      .describe("Arrow position down the slide, 0 (top) to the deck's height (bottom)"),
  },
  handler: async (args, ctx) => {
    const deck = await loadSlideInClassroom(args.slide_id, ctx);
    await assertSlideEditable(deck, ctx);
    const liveState = liveStateFor(deck.classroom);
    if (!liveState) throw NOT_LIVE('deck');
    const env = requireLiveEnv(liveState);
    // Pointers travel in the editors' normalized slide space (960×700, drawn
    // in proportion to the slide on screen); the agent's x, y are in the
    // deck's own size, like its renders and block boxes.
    const size =
      args.x !== undefined || args.y !== undefined ? await deckSize(env, deck.id) : DECK_SLIDE_SIZE;
    const scaled = (value: number | undefined, from: number, to: number) =>
      value === undefined ? undefined : (Math.min(value, from) / from) * to;
    const x = scaled(args.x, size.width, DECK_SLIDE_SIZE.width);
    const y = scaled(args.y, size.height, DECK_SLIDE_SIZE.height);
    let shown: boolean;
    try {
      ({ shown } = await postCursor(env, 'deck', deck.id, {
        actor: await actorFor(ctx),
        slide: args.slide,
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
      }));
    } catch (error) {
      throw cursorError(error, 'deck', args.slide);
    }
    return ok({ success: true, shown, ...(shown ? {} : { note: NOBODY_HERE }) });
  },
};
