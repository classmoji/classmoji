/**
 * deckOps.ts — the granular deck op engine (update / insert / move / delete /
 * reorder / set_theme), extracted VERBATIM from apps/mcp/src/tools/deck.ts so
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
import { BUILTIN_THEMES, mintSlideId, normalizeSlideHtml } from './deckHtml.ts';
import type { DeckJson, DeckSlide } from './deckTypes.ts';

// Re-exported so op-engine callers can catch the SAME class instance the
// engine's normalizeSlideHtml throws (module-identity-safe instanceof).
export { SlideHtmlError } from './deckHtml.ts';

// ─── Op schemas ──────────────────────────────────────────────────────────────

const attrsSchema = z.record(z.string());

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
    html: z.string().max(200_000).optional(),
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

export const deckOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('update'),
    id: z.string().min(1),
    html: z.string().max(200_000).optional(),
    notes: z
      .string()
      .max(50_000)
      .nullable()
      .optional()
      .describe('Speaker notes HTML; null or empty string removes the notes'),
    hidden: z.boolean().optional(),
    attrs: attrsSchema
      .nullable()
      .optional()
      .describe('Full replacement attrs record (null or {} clears all extra attributes)'),
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
        if (op.attrs !== undefined) {
          if (op.attrs == null || Object.keys(op.attrs).length === 0) {
            delete target.slide.attrs;
          } else {
            target.slide.attrs = { ...op.attrs };
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
          if (spec.attrs && Object.keys(spec.attrs).length > 0) leaf.attrs = { ...spec.attrs };
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
            if (spec.attrs && Object.keys(spec.attrs).length > 0) {
              container.attrs = { ...spec.attrs };
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
    }
  }

  return { deck, applied };
}
