/**
 * deckOps.ts — the granular deck op engine (update / insert / move / delete /
 * reorder / set_theme, and the block ops block_add / block_update /
 * block_delete), extracted VERBATIM from apps/mcp/src/tools/deck.ts so
 * the editor save path (deckSaveMerge saveDeckFromOps) and the MCP deck_apply
 * tool share one implementation.
 *
 * Pure: no service imports, no network, no database. Every incoming html/notes
 * fragment rounds through normalizeSlideHtml (deckHtml), so op-built documents
 * carry the SAME canonical form as editor whole-document saves.
 *
 * The zod schemas here are the single source of truth for the op vocabulary —
 * deck_apply's inputSchema and the slides editor action both validate against
 * them.
 *
 * NOTE for the MCP suite: deck.ts imports this module via the
 * `@classmoji/services/slides/ops` subpath (NOT `…/slides`), so the deck tool
 * tests' module mock of `@classmoji/services/slides` leaves the real engine in
 * place — op behavior in those tests is genuine, exactly as it was when the
 * engine lived inline in deck.ts.
 */

import { z } from 'zod';
import {
  HTML_BLOCK_FRAME_STYLE,
  blockMarkup,
  escapeBlockAttr,
  htmlBlockMarkup,
  mintBlockId,
  type BlockBox,
} from './deckBlocks.ts';
import {
  BUILTIN_THEMES,
  SlideBlockError,
  mintSlideId,
  normalizeSlideHtml,
  normalizeSvgBlockSource,
  readSlideBlocks,
  removeSlideBlock,
  updateSlideBlock,
  type SlideBlockEdit,
} from './deckHtml.ts';
import { stripRuntimeSectionAttrs } from './deckRuntimeAttrs.ts';
import type { DeckJson, DeckSlide } from './deckTypes.ts';

// Re-exported so op-engine callers can catch the SAME class instance the
// engine's normalizeSlideHtml throws (module-identity-safe instanceof), and
// read blocks with the engine's own reader.
export { SlideHtmlError, readSlideBlocks, type SlideBlockInfo } from './deckHtml.ts';

/** The most characters a slide's html may hold (the op schemas' html cap). */
export const MAX_SLIDE_HTML = 200_000;

// ─── Op schemas ──────────────────────────────────────────────────────────────

const attrsSchema = z.record(z.string());

/**
 * What an agent writing slide html needs to know beyond plain HTML: the
 * editor's draggable blocks, and vector art inside them.
 */
const SLIDE_HTML_DESCRIPTION =
  'Slide HTML (no <section>). Draggable blocks: <div class="sl-block" data-block-type="text" ' +
  'style="left:Xpx;top:Ypx;width:Wpx"><div class="sl-block-content">…</div></div> on the ' +
  "deck's logical canvas. Inline <svg> works in slide html and inside a text block; for an " +
  'image block use <img src="data:image/svg+xml,…"> with the SVG percent-encoded';

const positionSchema = z.union([
  z.object({ after: z.string().min(1) }).strict(),
  z.object({ at: z.enum(['start', 'end']) }).strict(),
]);

const newChildSlideSchema = z
  .object({
    html: z.string().max(200_000),
    notes: z.string().max(50_000).optional(),
    hidden: z.boolean().optional(),
    attrs: attrsSchema.optional(),
  })
  .strict();

const newSlideSchema = z
  .object({
    html: z.string().max(200_000).optional().describe(SLIDE_HTML_DESCRIPTION),
    notes: z.string().max(50_000).optional(),
    hidden: z.boolean().optional(),
    attrs: attrsSchema.optional(),
    children: z
      .array(newChildSlideSchema)
      .min(1)
      .max(20)
      .optional()
      .describe(
        'Create a vertical stack: the slide becomes a container holding these child slides ' +
          '(one nesting level — children cannot have children). Omit html on the container.'
      ),
  })
  .strict()
  .refine(s => (s.children?.length ? s.html === undefined : typeof s.html === 'string'), {
    message:
      'A new slide needs either html (regular slide) or children (vertical stack container) — ' +
      'stack containers carry no html of their own',
  });

// ─── Block op schemas ────────────────────────────────────────────────────────

/** Which block to use — the guide agents read on block_add's `type`. */
const BLOCK_TYPE_DESCRIPTION =
  'html: a small self-contained interactive piece (figure, widget, one-file mini-game, demo) ' +
  'in a sandboxed frame. It lives in the slide: co-edited live, shown in previews and ' +
  'renders, copied with the slide. Limits: one document, slide html ≤200 KB, in-memory ' +
  'localStorage only, no private /content fetches, loads with the deck, restarts when ' +
  'someone edits the slide. iframe: embeds files uploaded to the deck (file_upload_start / ' +
  'file_import_url with slide_id + folder) — multi-file games, sprites, sounds, shared ' +
  'libraries, large code, persistent storage, private files, lazy loading, state that ' +
  'survives co-edits; not live-editable (re-upload to change). svg: static vector art ' +
  '(SMIL animation ok, scripts stripped)';

const BLOCK_SOURCE_DESCRIPTION =
  'html: the whole document the frame shows (<!doctype html>…; scripts run, no same-origin ' +
  'access). svg: one <svg> element (sanitized, scaled to the box). Plain text: escaping is ' +
  'done for you, and deck_get returns it decoded';

const BLOCK_SRC_DESCRIPTION =
  'iframe: the ref file_upload_status returned, a path in the deck folder ' +
  '(games/x/index.html), or an https URL; loaded lazily';

const blockIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Block ids use letters, digits, - and _');

const blockCoord = z.number().finite().min(-20_000).max(20_000);
const blockExtent = z.number().finite().positive().max(20_000);

const blockBoxSchema = z
  .object({ left: blockCoord, top: blockCoord, width: blockExtent, height: blockExtent })
  .strict()
  .describe("px on the deck's logical canvas (960×700 unless its config sets a size)");

const blockBoxPatchSchema = z
  .object({
    left: blockCoord.optional(),
    top: blockCoord.optional(),
    width: blockExtent.optional(),
    height: blockExtent.optional(),
  })
  .strict()
  .describe('The box fields to change, in px');

const blockSlideSchema = z.string().min(1).describe('Id of the slide holding the block');
const existingBlockIdSchema = blockIdSchema.describe('data-cm-block-id, from deck_outline');

export const deckOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('update'),
    id: z.string().min(1),
    html: z.string().max(200_000).optional().describe(SLIDE_HTML_DESCRIPTION),
    notes: z
      .string()
      .max(50_000)
      .nullable()
      .optional()
      .describe('Speaker notes HTML; null or empty string removes the notes'),
    hidden: z.boolean().optional(),
    attrs: z
      .record(z.string().nullable())
      .nullable()
      .optional()
      .describe(
        "Section attributes, MERGED into the slide's: keys you send are set, a key set to null " +
          'is removed, keys you omit are kept. attrs: null clears them all'
      ),
    replace_attrs: z
      .boolean()
      .optional()
      .describe('true = attrs replaces the whole record instead of merging'),
  }),
  z.object({
    op: z.literal('insert'),
    slides: z.array(newSlideSchema).min(1).max(20),
    position: positionSchema,
  }),
  z.object({
    op: z.literal('move'),
    id: z.string().min(1),
    position: positionSchema,
  }),
  z.object({
    op: z.literal('delete'),
    id: z.string().min(1),
  }),
  z.object({
    op: z.literal('reorder'),
    order: z
      .array(z.string().min(1))
      .min(1)
      .describe('The complete new top-level slide order (a permutation of current top-level ids)'),
  }),
  z.object({
    op: z.literal('set_theme'),
    theme: z.string().max(120).optional(),
    code_theme: z
      .string()
      .max(50)
      .regex(/^[\w.-]+$/)
      .optional(),
  }),
  z.object({
    op: z.literal('block_add'),
    slide: blockSlideSchema,
    type: z.enum(['html', 'svg', 'iframe']).describe(BLOCK_TYPE_DESCRIPTION),
    box: blockBoxSchema,
    source: z.string().max(MAX_SLIDE_HTML).optional().describe(BLOCK_SOURCE_DESCRIPTION),
    src: z.string().max(2_000).optional().describe(BLOCK_SRC_DESCRIPTION),
    block_id: blockIdSchema.optional().describe('Id for the new block; minted when omitted'),
  }),
  z.object({
    op: z.literal('block_update'),
    slide: blockSlideSchema,
    block_id: existingBlockIdSchema,
    box: blockBoxPatchSchema.optional(),
    source: z
      .string()
      .max(MAX_SLIDE_HTML)
      .optional()
      .describe('New source (html and svg blocks), as for block_add'),
    src: z.string().max(2_000).optional().describe('New src (iframe blocks), as for block_add'),
  }),
  z.object({
    op: z.literal('block_delete'),
    slide: blockSlideSchema,
    block_id: existingBlockIdSchema,
  }),
]);

export type DeckOp = z.infer<typeof deckOpSchema>;

/**
 * Payload schema for the slides editor's ops-shaped save (a JSON array of
 * ops). More generous than deck_apply's 25-op cap — an editor session can
 * touch many slides between saves.
 */
export const deckOpsPayloadSchema = z.array(deckOpSchema).min(1).max(400);

// ─── Errors / lookup helpers ─────────────────────────────────────────────────

/** Typed error for deck op failures (unknown ids, bad positions, bad values). */
export class DeckOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeckOpError';
  }
}

/** Find a slide by id (top level or one stack level down, per Reveal). */
export function findSlide(
  slides: DeckSlide[],
  id: string
): { parent: DeckSlide[]; index: number; slide: DeckSlide } | null {
  for (let i = 0; i < slides.length; i++) {
    if (slides[i].id === id) return { parent: slides, index: i, slide: slides[i] };
    const children = slides[i].children;
    if (children) {
      for (let j = 0; j < children.length; j++) {
        if (children[j].id === id) return { parent: children, index: j, slide: children[j] };
      }
    }
  }
  return null;
}

/** All slide ids in a deck (stack children included). */
export function collectIds(slides: DeckSlide[], out = new Set<string>()): Set<string> {
  for (const slide of slides) {
    out.add(slide.id);
    if (slide.children) collectIds(slide.children, out);
  }
  return out;
}

function mustFindSlide(slides: DeckSlide[], id: string, opName: string) {
  const found = findSlide(slides, id);
  if (!found) {
    throw new DeckOpError(`Unknown slide id '${id}' in ${opName} op`);
  }
  return found;
}

function insertSlidesAt(
  deck: DeckJson,
  newSlides: DeckSlide[],
  position: { after: string } | { at: 'start' | 'end' },
  opName: string
): void {
  if ('after' in position) {
    const target = mustFindSlide(deck.slides, position.after, opName);
    target.parent.splice(target.index + 1, 0, ...newSlides);
  } else if (position.at === 'start') {
    deck.slides.unshift(...newSlides);
  } else {
    deck.slides.push(...newSlides);
  }
}

/** shared:/custom: theme names: single path segment, no separators, no '..'. */
const THEME_NAME_RE = /^[\w.-]+$/;

/** Validate a set_theme theme value: builtin, 'custom:<file>.css', or 'shared:<name>'. */
function assertValidTheme(theme: string): void {
  if (theme.startsWith('shared:') || theme.startsWith('custom:')) {
    // The suffix lands in repo paths (.slidesthemes/<name>/…) and generated
    // link hrefs — refuse anything that could traverse ('/', '..').
    const name = theme.slice(theme.indexOf(':') + 1);
    if (!THEME_NAME_RE.test(name) || name.includes('..')) {
      throw new DeckOpError(
        `Invalid theme name '${theme}' — shared:/custom: names may only contain letters, ` +
          "digits, '_', '-', and '.' (no path separators, no '..')"
      );
    }
    return;
  }
  if ((BUILTIN_THEMES as readonly string[]).includes(theme)) return;
  throw new DeckOpError(
    `Unknown theme '${theme}' — use a builtin (${BUILTIN_THEMES.join(', ')}), ` +
      "'custom:<file>.css', or 'shared:<name>'"
  );
}

/**
 * An update op's attrs against the slide's current ones. By default a MERGE:
 * keys sent are set, a null value removes its key, keys not sent are kept —
 * so a pass that sets one attribute never drops the rest. `replace` (or
 * `attrs: null`, which clears everything) takes the record as the whole set.
 * Reveal's runtime paint never persists, even when an agent hands back
 * verbatim what deck_get returned (issue #361).
 */
function nextSlideAttrs(
  current: Record<string, string> | undefined,
  incoming: Record<string, string | null> | null,
  replace: boolean
): Record<string, string> {
  if (incoming === null) return {};
  const set: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(incoming)) {
    if (value === null) removed.push(name);
    else set[name] = value;
  }
  const cleaned = stripRuntimeSectionAttrs(set);
  if (replace) return cleaned;
  const next: Record<string, string> = { ...(current ?? {}) };
  for (const name of removed) delete next[name];
  return Object.assign(next, cleaned);
}

// ─── Blocks ──────────────────────────────────────────────────────────────────

/** Characters a frame URL never carries: whitespace, controls, backslashes. */
const FRAME_SRC_BAD_CHARS = /[\s\u0000-\u001f\u007f\\]/;

/**
 * An iframe block's URL, or a DeckOpError: an https URL, a root-relative
 * `/content/…` path, or a path relative to the deck folder — no other scheme,
 * no `..` segment.
 */
export function checkBlockFrameSrc(src: string): string {
  const value = src.trim();
  const refuse = (why: string): never => {
    throw new DeckOpError(
      `Invalid iframe src '${value.slice(0, 120)}' — ${why}. Use an https URL, the ref ` +
        'file_upload_status returned, or a path in the deck folder'
    );
  };
  if (!value) refuse('it is empty');
  if (FRAME_SRC_BAD_CHARS.test(value)) refuse('it contains spaces or backslashes');
  const path = value.split(/[?#]/)[0];
  // Checked as the browser will read it: `%2e%2e` is `..` once loaded.
  if (/%(?:2f|5c)/i.test(path)) refuse('encoded slashes are not allowed');
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    refuse('it is not a valid URL path');
  }
  if (decoded.split('/').includes('..')) refuse("'..' is not allowed");
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    let url: URL | null = null;
    try {
      url = new URL(value);
    } catch {
      refuse('it is not a valid URL');
    }
    if (url?.protocol !== 'https:') refuse('only https URLs can be embedded');
    return value;
  }
  if (value.startsWith('//')) refuse('protocol-relative URLs are not allowed');
  if (value.startsWith('/') && !value.startsWith('/content/')) {
    refuse('root paths must be /content/… paths');
  }
  if (value.startsWith('?') || value.startsWith('#')) refuse('it names no file');
  return value;
}

/** Where a deck's files live, for turning a path into a URL the deck can load. */
export interface DeckFrameContext {
  org: string;
  repo: string;
  /** The deck folder in the content repo (`slides/<slug>`). */
  contentPath: string;
}

/**
 * An iframe block `src` as stored: a repo path inside the deck folder (what an
 * upload reports) or a path relative to it becomes the `/content/{org}/{repo}/…`
 * URL deck embeds use, so a page's own relative references resolve next to
 * it. URLs and root paths are returned as given (`checkBlockFrameSrc` judges
 * them), and so is anything with a `..` segment.
 */
export function resolveDeckFrameSrc(src: string, ctx: DeckFrameContext): string {
  const value = src.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/')) return value;
  if (value.startsWith('?') || value.startsWith('#')) return value;
  const cut = value.search(/[?#]/);
  const path = cut === -1 ? value : value.slice(0, cut);
  const tail = cut === -1 ? '' : value.slice(cut);
  const parts = path.split('/').filter(part => part.length > 0 && part !== '.');
  if (parts.length === 0 || parts.includes('..')) return value;
  const deck = ctx.contentPath.split('/').filter(Boolean);
  const inDeckRepoPath = parts.length > deck.length && deck.every((part, i) => parts[i] === part);
  const repoPath = (inDeckRepoPath ? parts : [...deck, ...parts]).join('/');
  return `/content/${ctx.org}/${ctx.repo}/${repoPath}${tail}`;
}

/**
 * Ops ready to send to every place that applies them: each block_add carries a
 * block id (minted here when the caller gave none, so a dry run, the live
 * server and a replay all name the same block) and every iframe `src` is
 * resolved against the deck folder. Input untouched.
 */
export function prepareDeckOps(ops: DeckOp[], ctx: DeckFrameContext | null): DeckOp[] {
  return ops.map(op => {
    if (op.op !== 'block_add' && op.op !== 'block_update') return op;
    const next = { ...op };
    if (next.op === 'block_add' && next.block_id === undefined) next.block_id = mintBlockId();
    if (ctx && next.src !== undefined) next.src = resolveDeckFrameSrc(next.src, ctx);
    return next;
  });
}

/** The frame inside an iframe block: today's lazy-loaded embed (attributes in name order). */
function iframeEmbedMarkup(src: string): string {
  return (
    `<iframe allowfullscreen="" data-src="${escapeBlockAttr(src)}" ` +
    `style="${HTML_BLOCK_FRAME_STYLE}"></iframe>`
  );
}

/** The slide a block op targets; stack containers carry no html. */
function blockSlide(deck: DeckJson, slideId: string, opName: string): DeckSlide {
  const target = mustFindSlide(deck.slides, slideId, opName);
  if (target.slide.children?.length) {
    throw new DeckOpError(
      `Slide '${slideId}' is a vertical stack container and has no html — put blocks on its children`
    );
  }
  return target.slide;
}

/** Refuse a slide html over the cap, naming the way out. */
function assertSlideHtmlFits(html: string, slideId: string): void {
  if (html.length > MAX_SLIDE_HTML) {
    throw new DeckOpError(
      `Slide '${slideId}' would hold ${html.length} characters of html, over the ` +
        `${MAX_SLIDE_HTML} limit — keep html blocks small, or upload the files and embed ` +
        'them with an iframe block'
    );
  }
}

/** A block edit, its SlideBlockError as the engine's own error. */
function blockEdit(slideId: string, edit: () => string): string {
  try {
    return edit();
  } catch (error) {
    if (error instanceof SlideBlockError) {
      throw new DeckOpError(`${error.message.replace('this slide', `slide '${slideId}'`)}`);
    }
    throw error;
  }
}

/** A new block's markup for a block_add op. */
function newBlockMarkup(
  op: Extract<DeckOp, { op: 'block_add' }>,
  id: string,
  box: BlockBox
): string {
  if (op.type === 'iframe') {
    if (op.source !== undefined) {
      throw new DeckOpError('An iframe block takes src (a URL or deck path), not source');
    }
    if (op.src === undefined) throw new DeckOpError('An iframe block needs src');
    return blockMarkup('iframe', id, box, iframeEmbedMarkup(checkBlockFrameSrc(op.src)));
  }
  if (op.src !== undefined) {
    throw new DeckOpError(`A ${op.type} block takes source, not src`);
  }
  if (op.source === undefined || op.source.trim() === '') {
    throw new DeckOpError(`A ${op.type} block needs source`);
  }
  if (op.type === 'html') return htmlBlockMarkup({ id, box, source: op.source });
  return blockMarkup('svg', id, box, normalizeSvgBlockSource(op.source));
}

// ─── applyDeckOps ────────────────────────────────────────────────────────────

export interface ApplyDeckOpsOptions {
  /**
   * The starter deck's recognized customCss (slideService.STARTER_CUSTOM_CSS).
   * When provided, an explicit set_theme change drops it — mirroring the
   * editor's buildEditorDeck merge rules. Callers that never route set_theme
   * ops (the editor save path) may omit it.
   */
  starterCustomCss?: string;
}

/**
 * Apply a sequence of deck operations. Pure — returns a new deck, input
 * untouched. Ops are applied sequentially, so later ops see earlier ops'
 * effects. Ids are matched at the top level and one stack level down.
 * EVERY incoming html/notes fragment rounds through normalizeSlideHtml
 * (SlideHtmlError propagates — stray <section> tags are rejected).
 *
 * @throws {DeckOpError} unknown ids/anchors, invalid positions or values.
 * @throws {SlideHtmlError} html/notes fragments carrying <section> tags.
 */
export function applyDeckOps(
  currentDeck: DeckJson,
  ops: DeckOp[],
  opts: ApplyDeckOpsOptions = {}
): { deck: DeckJson; applied: Array<Record<string, unknown>> } {
  const deck = structuredClone(currentDeck) as DeckJson;
  const applied: Array<Record<string, unknown>> = [];

  for (const op of ops) {
    switch (op.op) {
      case 'update': {
        if (
          op.html === undefined &&
          op.notes === undefined &&
          op.hidden === undefined &&
          op.attrs === undefined
        ) {
          throw new DeckOpError(
            `update op for '${op.id}' must set at least one of html, notes, hidden, attrs`
          );
        }
        const target = mustFindSlide(deck.slides, op.id, 'update');
        if (op.html !== undefined && target.slide.children?.length) {
          throw new DeckOpError(
            `Slide '${op.id}' is a vertical stack container and has no html — target its children`
          );
        }
        if (op.html !== undefined) {
          target.slide.html = normalizeSlideHtml(op.html);
        }
        if (op.notes !== undefined) {
          if (op.notes == null || op.notes === '') {
            delete target.slide.notes;
          } else {
            target.slide.notes = normalizeSlideHtml(op.notes);
          }
        }
        if (op.hidden !== undefined) {
          if (op.hidden) target.slide.hidden = true;
          else delete target.slide.hidden;
        }
        if (op.replace_attrs && op.attrs === undefined) {
          throw new DeckOpError(`update op for '${op.id}' sets replace_attrs without attrs`);
        }
        if (op.attrs !== undefined) {
          const attrs = nextSlideAttrs(target.slide.attrs, op.attrs, op.replace_attrs === true);
          if (Object.keys(attrs).length === 0) {
            delete target.slide.attrs;
          } else {
            target.slide.attrs = attrs;
          }
        }
        applied.push({ op: 'update', id: op.id });
        break;
      }

      case 'insert': {
        // Runtime mirrors of the schema rules (defense in depth — the test
        // harness and any validation-bypassing client hit the handler direct).
        for (const spec of op.slides) {
          const hasChildren = Boolean(spec.children?.length);
          if (hasChildren && spec.html !== undefined) {
            throw new DeckOpError(
              'A vertical stack container cannot carry html — put content on its children'
            );
          }
          if (!hasChildren && typeof spec.html !== 'string') {
            throw new DeckOpError(
              'A new slide needs html (regular slide) or children (vertical stack container)'
            );
          }
          if (
            hasChildren &&
            (spec.children ?? []).some(c => (c as { children?: unknown[] }).children?.length)
          ) {
            throw new DeckOpError(
              'Nested stacks are not supported — child slides cannot have children'
            );
          }
        }
        // A stack container can never land inside another stack (Reveal
        // supports one nesting level) — mirror the move-op guard BEFORE any
        // building so the rejection is targeted.
        if (op.slides.some(s => s.children?.length) && 'after' in op.position) {
          const target = mustFindSlide(deck.slides, op.position.after, 'insert');
          if (target.parent !== deck.slides) {
            throw new DeckOpError(
              `Cannot insert a vertical stack after '${op.position.after}' — that position is ` +
                'inside another stack (nested stacks are not supported)'
            );
          }
        }
        const used = collectIds(deck.slides);
        const mint = (): string => {
          let id = mintSlideId();
          while (used.has(id)) id = mintSlideId(); // re-mint collisions
          used.add(id);
          return id;
        };
        const buildLeaf = (spec: {
          html: string;
          notes?: string;
          hidden?: boolean;
          attrs?: Record<string, string>;
        }): DeckSlide => {
          const leaf: DeckSlide = { id: mint(), html: normalizeSlideHtml(spec.html) };
          if (spec.notes != null && spec.notes !== '') {
            leaf.notes = normalizeSlideHtml(spec.notes);
          }
          if (spec.hidden) leaf.hidden = true;
          const attrs = stripRuntimeSectionAttrs(spec.attrs ?? {});
          if (Object.keys(attrs).length > 0) leaf.attrs = attrs;
          return leaf;
        };
        const childIdsByContainer: Record<string, string[]> = {};
        const inserted: DeckSlide[] = op.slides.map(spec => {
          if (spec.children?.length) {
            const container: DeckSlide = { id: mint() };
            container.children = spec.children.map(buildLeaf);
            if (spec.notes != null && spec.notes !== '') {
              container.notes = normalizeSlideHtml(spec.notes);
            }
            if (spec.hidden) container.hidden = true;
            const containerAttrs = stripRuntimeSectionAttrs(spec.attrs ?? {});
            if (Object.keys(containerAttrs).length > 0) {
              container.attrs = containerAttrs;
            }
            childIdsByContainer[container.id] = container.children.map(c => c.id);
            return container;
          }
          // The schema refine guarantees html is present on non-containers.
          return buildLeaf(
            spec as {
              html: string;
              notes?: string;
              hidden?: boolean;
              attrs?: Record<string, string>;
            }
          );
        });
        insertSlidesAt(deck, inserted, op.position, 'insert');
        const entry: Record<string, unknown> = {
          op: 'insert',
          count: inserted.length,
          ids: inserted.map(s => s.id),
        };
        if (Object.keys(childIdsByContainer).length > 0) entry.children = childIdsByContainer;
        applied.push(entry);
        break;
      }

      case 'move': {
        if ('after' in op.position && op.position.after === op.id) {
          throw new DeckOpError(`Cannot move slide '${op.id}' relative to itself`);
        }
        const source = mustFindSlide(deck.slides, op.id, 'move');
        // Reveal supports one level of nesting: a stack container can never
        // land inside another container. Checked BEFORE the splice so the
        // rejection is targeted (not a generic unknown-id error).
        if (source.slide.children?.length && 'after' in op.position) {
          const target = mustFindSlide(deck.slides, op.position.after, 'move');
          if (target.parent !== deck.slides) {
            throw new DeckOpError(
              `Cannot move slide '${op.id}' after '${op.position.after}' — '${op.id}' is a ` +
                'vertical stack container and that position is inside another stack ' +
                '(nested stacks are not supported)'
            );
          }
        }
        const [moved] = source.parent.splice(source.index, 1);
        insertSlidesAt(deck, [moved], op.position, 'move');
        applied.push({ op: 'move', id: op.id });
        break;
      }

      case 'delete': {
        const target = mustFindSlide(deck.slides, op.id, 'delete');
        if (target.parent === deck.slides && deck.slides.length === 1) {
          throw new DeckOpError('A deck must keep at least one slide — cannot delete the last one');
        }
        target.parent.splice(target.index, 1);
        applied.push({ op: 'delete', id: op.id });
        break;
      }

      case 'reorder': {
        const currentIds = deck.slides.map(s => s.id);
        const sameLength = op.order.length === currentIds.length;
        const currentSet = new Set(currentIds);
        const isPermutation =
          sameLength &&
          new Set(op.order).size === op.order.length &&
          op.order.every(id => currentSet.has(id));
        if (!isPermutation) {
          throw new DeckOpError(
            'reorder order must be a permutation of the current top-level slide ids ' +
              `(current: ${currentIds.join(', ')})`
          );
        }
        const byId = new Map(deck.slides.map(s => [s.id, s]));
        deck.slides = op.order.flatMap(id => {
          const found = byId.get(id);
          return found ? [found] : []; // unreachable — permutation verified above
        });
        applied.push({ op: 'reorder', count: op.order.length });
        break;
      }

      case 'set_theme': {
        if (op.theme === undefined && op.code_theme === undefined) {
          throw new DeckOpError('set_theme op must set theme and/or code_theme');
        }
        if (op.theme !== undefined && op.theme !== deck.theme) {
          assertValidTheme(op.theme);
          deck.theme = op.theme;
          // Mirror the editor's merge rules: an explicit theme change clears
          // the paired dark theme and drops starter-recognized customCss.
          delete deck.themeDark;
          if (opts.starterCustomCss !== undefined && deck.customCss === opts.starterCustomCss) {
            delete deck.customCss;
          }
        }
        if (op.code_theme !== undefined && op.code_theme !== deck.codeTheme) {
          deck.codeTheme = op.code_theme;
          delete deck.codeThemeDark;
        }
        applied.push({
          op: 'set_theme',
          ...(op.theme !== undefined ? { theme: op.theme } : {}),
          ...(op.code_theme !== undefined ? { code_theme: op.code_theme } : {}),
        });
        break;
      }

      case 'block_add': {
        const slide = blockSlide(deck, op.slide, 'block_add');
        const html = slide.html ?? '';
        // Every block id on the slide, nested blocks included.
        const taken = new Set(
          [...html.matchAll(/data-cm-block-id="([^"]*)"/g)].map(match => match[1])
        );
        let blockId = op.block_id;
        if (blockId !== undefined && taken.has(blockId)) {
          throw new DeckOpError(`Slide '${op.slide}' already has a block '${blockId}'`);
        }
        if (blockId === undefined) {
          blockId = mintBlockId();
          while (taken.has(blockId)) blockId = mintBlockId();
        }
        const next = normalizeSlideHtml(html + newBlockMarkup(op, blockId, op.box));
        assertSlideHtmlFits(next, op.slide);
        slide.html = next;
        applied.push({ op: 'block_add', slide: op.slide, block_id: blockId, type: op.type });
        break;
      }

      case 'block_update': {
        const slide = blockSlide(deck, op.slide, 'block_update');
        const hasBox = op.box !== undefined && Object.keys(op.box).length > 0;
        if (!hasBox && op.source === undefined && op.src === undefined) {
          throw new DeckOpError(
            `block_update for '${op.block_id}' must set at least one of box, source, src`
          );
        }
        const html = slide.html ?? '';
        const block = readSlideBlocks(html, { content: false }).find(b => b.id === op.block_id);
        if (!block) {
          throw new DeckOpError(
            `No block '${op.block_id}' on slide '${op.slide}' — deck_outline lists block ids`
          );
        }
        const edit: SlideBlockEdit = {};
        if (hasBox) edit.box = op.box;
        if (op.source !== undefined) {
          if (block.type === 'html') edit.source = op.source;
          else if (block.type === 'svg') edit.svg = op.source;
          else {
            throw new DeckOpError(
              `Block '${op.block_id}' is ${block.type}; source applies to html and svg blocks` +
                (block.type === 'iframe' ? ' (an iframe block takes src)' : '')
            );
          }
        }
        if (op.src !== undefined) {
          if (block.type !== 'iframe') {
            throw new DeckOpError(
              `Block '${op.block_id}' is ${block.type}; src applies to iframe blocks`
            );
          }
          edit.src = checkBlockFrameSrc(op.src);
        }
        const next = blockEdit(op.slide, () => updateSlideBlock(html, op.block_id, edit));
        assertSlideHtmlFits(next, op.slide);
        slide.html = next;
        applied.push({ op: 'block_update', slide: op.slide, block_id: op.block_id });
        break;
      }

      case 'block_delete': {
        const slide = blockSlide(deck, op.slide, 'block_delete');
        slide.html = blockEdit(op.slide, () => removeSlideBlock(slide.html ?? '', op.block_id));
        applied.push({ op: 'block_delete', slide: op.slide, block_id: op.block_id });
        break;
      }
    }
  }

  return { deck, applied };
}
