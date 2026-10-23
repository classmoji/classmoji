/**
 * deck_apply / deck_get and the files behind html blocks.
 *
 * An html block's code is a file of the deck (`blocks/<8 hex>.html`) that the
 * block names by `data-cm-src` + `data-cm-rev`; the op engine only ever sees
 * `src` (+ `rev`). An agent may still send `source` (the code) on an html
 * block_add / block_update. deck_apply then:
 *
 *   1. dry-runs the ops op by op, each html `source` standing in as a
 *      placeholder `src` — every op is judged (ids, types, boxes, the slide
 *      cap) before anything is written;
 *   2. writes each `source` to the block's file: its own file, compare-and-swap
 *      on the rev the deck holds, in `mode: 'live'` when no other block shares
 *      it; a new file otherwise (and always in preview, so the published deck
 *      keeps its files);
 *   3. hands back the ops rewritten to `{ src, rev }`, which travel on as any
 *      other op (to the live server, or applied and saved to git).
 *
 * `block_delete` with `delete_file` removes the block's `blocks/` file once
 * the deck no longer names it (after the deck write, never in preview).
 */

import {
  deleteHtmlBlockFile,
  HtmlBlockFileError,
  readHtmlBlockSources,
  writeHtmlBlockFile,
  type DeckJson,
  type DeckSlide,
  type HtmlBlockFileRef,
} from '@classmoji/services/slides';
import {
  applyDeckOps,
  ensureSlideBlockIds,
  findSlide,
  isHtmlBlockFileSrc,
  readSlideBlocks,
  resolveDeckRelativeRef,
  type DeckOp,
  type SlideBlockInfo,
} from '@classmoji/services/slides/ops';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext } from '../mcp/registry.ts';

/** Stands in for a file not written yet, in the dry run. */
const PLACEHOLDER_SRC = 'blocks/00000000.html';

/** One slide block, as the ops address it. */
function blockOf(deck: DeckJson, slideId: string, blockId: string): SlideBlockInfo | null {
  const html = findSlide(deck.slides, slideId)?.slide.html;
  if (!html) return null;
  try {
    return (
      readSlideBlocks(ensureSlideBlockIds(html), { content: false }).find(b => b.id === blockId) ??
      null
    );
  } catch {
    return null;
  }
}

function eachSlide(slides: DeckSlide[], visit: (slide: DeckSlide) => void): void {
  for (const slide of slides) {
    visit(slide);
    if (slide.children) eachSlide(slide.children, visit);
  }
}

/** The repo path an html block ref names (relative to `deckFolder`), or null. */
function repoPathOf(src: string, deckFolder: string): string | null {
  return resolveDeckRelativeRef(src, deckFolder)?.repoPath ?? null;
}

/** How many html blocks of `deck` name the file `src` names, leaving out `except`. */
function fileUsers(
  deck: DeckJson,
  src: string,
  deckFolder: string,
  except: { slide: string; block: string } | null = null
): number {
  const target = repoPathOf(src, deckFolder);
  if (!target) return 0;
  let count = 0;
  eachSlide(deck.slides, slide => {
    if (!slide.html?.includes('data-cm-src')) return;
    let html = slide.html;
    try {
      html = ensureSlideBlockIds(html);
    } catch {
      // Listed as stored.
    }
    for (const block of readSlideBlocks(html, { content: false })) {
      if (block.type !== 'html' || !block.src) continue;
      if (except && slide.id === except.slide && block.id === except.block) continue;
      if (repoPathOf(block.src, deckFolder) === target) count++;
    }
  });
  return count;
}

/** A file refusal → the ToolError an agent can act on. */
function fileError(error: unknown): never {
  if (error instanceof HtmlBlockFileError) {
    if (error.code === 'changed') {
      throw new ToolError(
        'invalid_params',
        `${error.message} — re-read with deck_get and apply again`,
        'CONTENT_CONFLICT'
      );
    }
    if (error.code === 'forbidden') throw new ToolError('forbidden', error.message);
    if (error.code === 'not-found') throw new ToolError('not_found', error.message);
    throw new ToolError('invalid_params', error.message);
  }
  throw error;
}

/** What `writeBlockSources` did, for the caller's `applied` report. */
export interface BlockFileOutcome {
  /** Op index → the file its `source` was written to. */
  written: Map<number, HtmlBlockFileRef>;
  /** block_delete ops with `delete_file`: op index → the file the block named. */
  toDelete: Map<number, string>;
}

/**
 * Steps 1–2 above: the dry run, then the file writes. Returns the ops to send
 * (`source` replaced by `src` + `rev` on html blocks) and what was written.
 * Engine refusals in the dry run propagate as the engine throws them
 * (DeckOpError / SlideHtmlError) — nothing has been written then.
 */
export async function writeBlockSources(
  ops: DeckOp[],
  base: DeckJson,
  opts: {
    slide: { id: string; content_path: string };
    ctx: ToolContext;
    mode: 'live' | 'preview';
    starterCustomCss?: string;
  }
): Promise<{ ops: DeckOp[]; outcome: BlockFileOutcome }> {
  const deckFolder = opts.slide.content_path;
  const pending: Array<{
    index: number;
    prior: { src: string; rev?: string } | null;
    fork: boolean;
  }> = [];
  const deletes: Array<{ index: number; src: string; key: string }> = [];
  let deck = base;

  for (const [index, op] of ops.entries()) {
    let dry: DeckOp = op;
    if (op.op === 'block_add' && op.type === 'html' && op.source !== undefined) {
      if (op.src !== undefined || op.rev !== undefined) {
        throw new ToolError('invalid_params', 'An html block takes source or src, not both');
      }
      const { source: _source, ...rest } = op;
      dry = { ...rest, src: PLACEHOLDER_SRC };
      pending.push({ index, prior: null, fork: false });
    } else if (op.op === 'block_update' && op.source !== undefined) {
      const block = blockOf(deck, op.slide, op.block_id);
      if (block?.type === 'html') {
        if (op.src !== undefined || op.rev !== undefined) {
          throw new ToolError('invalid_params', 'An html block takes source or src, not both');
        }
        const { source: _source, ...rest } = op;
        dry = { ...rest, src: PLACEHOLDER_SRC };
        const prior =
          block.src && isHtmlBlockFileSrc(block.src)
            ? { src: block.src, ...(block.rev ? { rev: block.rev } : {}) }
            : null;
        const fork =
          prior !== null &&
          prior.src !== PLACEHOLDER_SRC &&
          fileUsers(deck, prior.src, deckFolder, { slide: op.slide, block: op.block_id }) > 0;
        pending.push({ index, prior, fork });
      }
    } else if (op.op === 'block_delete' && op.delete_file) {
      if (opts.mode === 'preview') {
        throw new ToolError(
          'invalid_params',
          "delete_file needs mode: 'live' — the published deck still shows the block until a " +
            'preview is accepted'
        );
      }
      const block = blockOf(deck, op.slide, op.block_id);
      if (block?.type === 'html' && block.src && isHtmlBlockFileSrc(block.src)) {
        deletes.push({ index, src: block.src, key: `${op.slide}\u0000${op.block_id}` });
      }
    }
    deck = applyDeckOps(deck, [dry], { starterCustomCss: opts.starterCustomCss }).deck;
  }

  const written = new Map<number, HtmlBlockFileRef>();
  // A block written earlier in this call: its next source goes to the same file.
  const byBlock = new Map<string, HtmlBlockFileRef>();
  const next = [...ops];
  for (const { index, prior, fork } of pending) {
    const op = ops[index] as Extract<DeckOp, { op: 'block_add' | 'block_update' }>;
    const key = `${op.slide}\u0000${op.block_id}`;
    const own = byBlock.get(key) ?? (prior?.src === PLACEHOLDER_SRC ? null : prior);
    let ref: HtmlBlockFileRef;
    try {
      ref = await writeHtmlBlockFile({
        slideId: opts.slide.id,
        actorUserId: opts.ctx.viewer.userId,
        html: op.source ?? '',
        ...(own ? { src: own.src } : {}),
        ...(own?.rev ? { expectedRev: own.rev } : {}),
        fork,
        mode: opts.mode,
        ...(op.block_id ? { blockId: op.block_id } : {}),
        surface: 'mcp',
      });
    } catch (error) {
      fileError(error);
    }
    written.set(index, ref);
    byBlock.set(key, ref);
    const { source: _source, ...rest } = op;
    next[index] = { ...rest, src: ref.src, rev: ref.rev } as DeckOp;
  }
  // A block given its file in this call names the written one, not the placeholder.
  const toDelete = new Map<number, string>();
  for (const { index, src, key } of deletes) {
    const file = src === PLACEHOLDER_SRC ? byBlock.get(key)?.src : src;
    if (file) toDelete.set(index, file);
  }
  return { ops: next, outcome: { written, toDelete } };
}

/**
 * After the deck write: delete the files of `delete_file` block_deletes that
 * no html block of `deck` (the deck as written) still names, and note each
 * outcome on its `applied` entry. Never throws: the deck is already written.
 */
export async function deleteUnusedBlockFiles(
  outcome: BlockFileOutcome,
  deck: DeckJson,
  applied: Array<Record<string, unknown>>,
  opts: { slide: { id: string; content_path: string }; ctx: ToolContext }
): Promise<Array<Record<string, unknown>>> {
  if (outcome.toDelete.size === 0 && outcome.written.size === 0) return applied;
  const out = applied.map(entry => ({ ...entry }));
  for (const [index, ref] of outcome.written) {
    if (out[index]) Object.assign(out[index], { src: ref.src, rev: ref.rev });
  }
  for (const [index, src] of outcome.toDelete) {
    const entry = out[index] ?? {};
    if (fileUsers(deck, src, opts.slide.content_path) > 0) {
      Object.assign(entry, {
        file: src,
        file_deleted: false,
        note: 'another block uses this file',
      });
      continue;
    }
    try {
      const { deleted } = await deleteHtmlBlockFile({
        slideId: opts.slide.id,
        actorUserId: opts.ctx.viewer.userId,
        src,
        blockId: String(entry.block_id ?? ''),
        surface: 'mcp',
      });
      Object.assign(entry, { file: src, file_deleted: deleted });
    } catch (error) {
      console.warn('[deck_apply] Could not delete an html block file:', error);
      Object.assign(entry, {
        file: src,
        file_deleted: false,
        note: 'the file could not be deleted',
      });
    }
  }
  return out;
}

/** The most code deck_get returns in one read, across its html block files. */
export const MAX_BLOCK_SOURCE_BYTES = 400_000;
/** The most html block files deck_get reads in one call. */
export const MAX_BLOCK_SOURCE_FILES = 12;

/**
 * deck_get: each html block of `slides` whose file is a `blocks/` file of the
 * deck gets its code as `source` (read from the repo), in slide order, up to
 * {@link MAX_BLOCK_SOURCE_FILES} files and {@link MAX_BLOCK_SOURCE_BYTES};
 * past that, or when a read fails, `source_omitted: true` instead. Mutates
 * the blocks of `slides` (deck_get's own copies).
 */
export async function attachBlockSources(
  slides: Array<DeckSlide & { blocks?: SlideBlockInfo[] }>,
  opts: { slideId: string; ctx: ToolContext }
): Promise<void> {
  const blocks: Array<SlideBlockInfo & { source_omitted?: boolean }> = [];
  const visit = (list: Array<DeckSlide & { blocks?: SlideBlockInfo[] }>) => {
    for (const slide of list) {
      for (const block of slide.blocks ?? []) {
        if (block.type === 'html' && isHtmlBlockFileSrc(block.src)) blocks.push(block);
      }
      if (slide.children) visit(slide.children as Array<DeckSlide & { blocks?: SlideBlockInfo[] }>);
    }
  };
  visit(slides);
  if (blocks.length === 0) return;

  const reading = blocks.slice(0, MAX_BLOCK_SOURCE_FILES);
  let sources: Awaited<ReturnType<typeof readHtmlBlockSources>> = [];
  try {
    sources = await readHtmlBlockSources({
      slideId: opts.slideId,
      actorUserId: opts.ctx.viewer.userId,
      refs: reading.map(block => ({
        src: block.src ?? '',
        ...(block.rev ? { rev: block.rev } : {}),
      })),
      access: 'view',
    });
  } catch (error) {
    console.warn('[deck_get] Could not read html block files:', error);
  }
  let budget = MAX_BLOCK_SOURCE_BYTES;
  blocks.forEach((block, i) => {
    const file = sources[i];
    const size = file ? Buffer.byteLength(file.html, 'utf8') : 0;
    if (!file || size > budget) {
      block.source_omitted = true;
      return;
    }
    budget -= size;
    block.source = file.html;
  });
}
