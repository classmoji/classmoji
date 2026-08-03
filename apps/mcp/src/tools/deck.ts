/**
 * Deck CONTENT tools (content-tools plan Phase 5, §7):
 * deck_outline / deck_get / deck_apply + deck_preview_accept / deck_preview_discard.
 *
 * Token-efficient granular editing of reveal.js decks stored in the
 * per-classroom content repo (`slides/<slug>/deck.json`, with the generated
 * `index.html` artifact alongside): outline → get(ids) → apply(ops) — never
 * whole-document round-trips. Every apply is optimistic-locked on the
 * sha + sha_source the caller last read; a mismatch returns the
 * machine-readable CONTENT_CONFLICT code so clients re-read and retry.
 *
 * Preview branches (§3b): applies to a published deck default to the deck's
 * singleton `preview/<content_path>` branch (drafts commit direct — nobody
 * sees them). Preview branches carry deck.json ONLY; accept = GitHub merge
 * into main + regenerate index.html from the merged deck.json + branch
 * delete. A genuine same-slide conflict returns a structured per-unit report
 * instead of raw conflict markers. Discard = branch delete, main untouched.
 *
 * Tier: TEACHING_TEAM reads; writes add the assertSlideAccess edit-tier
 * sub-gate (OWNER/TEACHER any deck; ASSISTANT own or allow_team_edit).
 * S1: every tool loads the slide WITH its classroom chain and compares
 * classroom_id before touching GitHub (loadSlideInClassroom).
 *
 * Legacy decks (no deck.json yet): loadDeck parses index.html into a deck.
 * Slide ids for un-tagged sections are minted DETERMINISTICALLY here
 * (sequential generator) so ids from deck_outline match a later deck_apply
 * read of the same content state — expected_sha pins that state. Unparseable
 * HTML (DECK_PARSE_FAILED) refuses granular ops with web-editor guidance.
 */

import {
  BUILTIN_THEMES,
  DeckParseError,
  SlideHtmlError,
  acceptDeckPreview,
  discardDeckPreview,
  ensureDeckPreviewBranch,
  getDeckPreviewStatus,
  loadDeck,
  mintSlideId,
  normalizeSlideHtml,
  previewBranchName,
  resolveSharedThemeUrls,
  saveDeck,
  slideService,
  type DeckJson,
  type DeckShaSource,
  type DeckSlide,
} from '@classmoji/services/slides';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
  assertSlideEditable,
  loadSlideInClassroom,
  ok,
  TEACHING_TEAM,
  writeAudit,
  type SlideWithRepoRecord,
} from './shared.ts';

// ─── Shared helpers ──────────────────────────────────────────────────────────

const LEGACY_GUIDANCE =
  "This deck's HTML could not be parsed into a structured deck, so granular slide ops are " +
  'unavailable. Open it once in the web slides editor and save to migrate it.';

/**
 * CONTENT_CONFLICT naming the ref that was compared: when a preview exists,
 * applies stack onto it and the sha must come from a preview read — a stale
 * main sha is the most common mistake, so the message says which re-read fixes it.
 */
function contentConflict(at: 'main' | 'preview' = 'main'): ToolError {
  return new ToolError(
    'invalid_params',
    at === 'preview'
      ? 'Deck changed since you read it — a preview exists and applies stack onto it, so ' +
          "re-read with deck_get at: 'preview' for a fresh sha"
      : 'Deck changed since you read it — call deck_get again for a fresh sha',
    'CONTENT_CONFLICT'
  );
}

/**
 * Deterministic id generator for legacy (index.html-parsed) decks: sections
 * without a data-cm-id get 's1', 's2', … in document order, so two reads of
 * the SAME content state yield the same ids (expected_sha pins the state).
 * Sections that already carry ids keep them.
 */
function legacyIdGen(): () => string {
  let n = 0;
  return () => `s${++n}`;
}

/** Load the deck for a tool call, mapping load failures to tool errors. */
async function loadDeckForTool(
  slide: SlideWithRepoRecord,
  ref?: string
): Promise<Awaited<ReturnType<typeof loadDeck>> | { parseError: string }> {
  try {
    return await loadDeck(slide, {
      skipCache: true,
      ...(ref ? { ref } : {}),
      parseOptions: { idGen: legacyIdGen() },
    });
  } catch (error: unknown) {
    if (error instanceof DeckParseError) {
      return { parseError: error.message };
    }
    if (error instanceof Error && error.message.startsWith('Slide content not found')) {
      throw new ToolError(
        'not_found',
        'Slide content files not found in the content repo — the deck may still be provisioning'
      );
    }
    throw error;
  }
}

/** Humanize the preview's age from its oldest commit date (e.g. '3h', '2d'). */
function humanizeAge(oldestCommitAt: string | undefined): string | undefined {
  if (!oldestCommitAt) return undefined;
  const ms = Date.now() - new Date(oldestCommitAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Outline/tool payload for the preview state. */
function previewPayload(status: {
  exists: boolean;
  commits_ahead?: number;
  oldest_commit_at?: string;
}) {
  if (!status.exists) return { exists: false };
  const age = humanizeAge(status.oldest_commit_at);
  return {
    exists: true,
    commits_ahead: status.commits_ahead ?? 0,
    ...(age ? { age } : {}),
    ...(status.oldest_commit_at ? { oldest_commit_at: status.oldest_commit_at } : {}),
  };
}

/**
 * Resolve the ref to read for an `at` argument. `at: 'preview'` requires the
 * preview branch to exist; reads then target it (API-path only — the CDN and
 * students always see main).
 */
function previewReadRef(
  slide: SlideWithRepoRecord,
  at: 'main' | 'preview',
  status: { exists: boolean }
): string | undefined {
  if (at !== 'preview') return undefined;
  if (!status.exists) {
    throw new ToolError(
      'invalid_params',
      "No preview branch exists for this deck — at: 'preview' requires a pending preview " +
        "(create one with deck_apply commit: 'preview')"
    );
  }
  return previewBranchName(slide.content_path);
}

// ─── Slide text previews ─────────────────────────────────────────────────────

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** Flattened plain-text preview of a slide's html, truncated to ≤80 chars. */
function slideTextPreview(html: string | undefined): string {
  if (!html) return '';
  const text = html
    // Opaque payloads (sandpack JSON, styles) must not leak into previews.
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, m => ENTITY_MAP[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

interface DeckOutlineEntry {
  id: string;
  /** Dotted position, '4' or '4.2' (vertical-stack children). */
  index: string;
  preview: string;
  hidden: boolean;
  has_notes: boolean;
  children?: DeckOutlineEntry[];
}

function outlineEntry(slide: DeckSlide, index: string): DeckOutlineEntry {
  const entry: DeckOutlineEntry = {
    id: slide.id,
    index,
    preview: slideTextPreview(slide.html),
    hidden: slide.hidden === true,
    has_notes: slide.notes != null && slide.notes !== '',
  };
  if (slide.children && slide.children.length > 0) {
    entry.children = slide.children.map((child, j) => outlineEntry(child, `${index}.${j + 1}`));
  }
  return entry;
}

function outlineSlides(slides: DeckSlide[]): DeckOutlineEntry[] {
  return slides.map((slide, i) => outlineEntry(slide, String(i + 1)));
}

/** Total slide count, stack children included. */
function countSlides(slides: DeckSlide[]): number {
  let count = 0;
  for (const slide of slides) {
    count += 1;
    if (slide.children) count += slide.children.length;
  }
  return count;
}

/** Find a slide by id (top level or one stack level down, per Reveal). */
function findSlide(
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

function collectIds(slides: DeckSlide[], out = new Set<string>()): Set<string> {
  for (const slide of slides) {
    out.add(slide.id);
    if (slide.children) collectIds(slide.children, out);
  }
  return out;
}

// ─── deck_outline ────────────────────────────────────────────────────────────

interface DeckOutlineArgs {
  classroom: string;
  slide_id: string;
  at?: 'main' | 'preview';
}

export const deckOutlineTool: ToolDefinition<DeckOutlineArgs> = {
  name: 'deck_outline',
  title: 'Outline a slide deck',
  description:
    "Returns a compact outline of a deck's slides: one entry per slide (id, index like '4' or " +
    "'4.2' for vertical stacks, ≤80-char text preview, hidden, has_notes) plus theme info, the " +
    'content sha + sha_source, and pending-preview status. Start here, then fetch only the ' +
    'slides you need with deck_get (slide_ids) and edit them with deck_apply — never ' +
    "round-trip whole decks. Pass at: 'preview' to outline the pending preview instead of main.",
  scope: 'read',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    slide_id: z.string().uuid().describe('Slide deck id'),
    at: z
      .enum(['main', 'preview'])
      .optional()
      .describe("Read target: 'main' (default) or the pending preview branch"),
  },
  handler: async (args, ctx) => {
    const slide = await loadSlideInClassroom(args.slide_id, ctx);
    const status = await getDeckPreviewStatus(slide);
    const ref = previewReadRef(slide, args.at ?? 'main', status);

    const loaded = await loadDeckForTool(slide, ref);
    if ('parseError' in loaded) {
      return ok({
        slide_id: slide.id,
        title: slide.title,
        format: 'legacy_html',
        sha: null,
        parse_error: loaded.parseError,
        preview: previewPayload(status),
        slide_count: 0,
        slides: [],
        message: LEGACY_GUIDANCE,
      });
    }

    const { deck } = loaded;
    return ok({
      slide_id: slide.id,
      title: slide.title,
      format: loaded.sha_source === 'deck' ? 'deck' : 'legacy_html',
      sha: loaded.sha,
      sha_source: loaded.sha_source,
      at: args.at ?? 'main',
      theme: deck.theme,
      ...(deck.themeDark ? { theme_dark: deck.themeDark } : {}),
      code_theme: deck.codeTheme,
      ...(deck.codeThemeDark ? { code_theme_dark: deck.codeThemeDark } : {}),
      slide_count: countSlides(deck.slides),
      preview: previewPayload(status),
      slides: outlineSlides(deck.slides),
      ...(loaded.warnings?.length ? { warnings: loaded.warnings } : {}),
    });
  },
};

// ─── deck_get ────────────────────────────────────────────────────────────────

interface DeckGetArgs {
  classroom: string;
  slide_id: string;
  slide_ids?: string[];
  at?: 'main' | 'preview';
}

export const deckGetTool: ToolDefinition<DeckGetArgs> = {
  name: 'deck_get',
  title: 'Get deck slides',
  description:
    'Returns full slide objects (html, notes, hidden, attrs, children) for a deck, with stable ' +
    'ids. Pass slide_ids (from deck_outline) to fetch only specific slides — preferred on ' +
    'large decks. Omitting slide_ids returns the whole deck incl. config and custom CSS. The ' +
    'returned sha + sha_source are the expected_sha/sha_source for a subsequent deck_apply. ' +
    "Pass at: 'preview' to read the pending preview branch.",
  scope: 'read',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    slide_id: z.string().uuid().describe('Slide deck id'),
    slide_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .optional()
      .describe('Specific slide ids to fetch (≤20, from deck_outline); omit for the whole deck'),
    at: z
      .enum(['main', 'preview'])
      .optional()
      .describe("Read target: 'main' (default) or the pending preview branch"),
  },
  handler: async (args, ctx) => {
    const slide = await loadSlideInClassroom(args.slide_id, ctx);
    const status = await getDeckPreviewStatus(slide);
    const ref = previewReadRef(slide, args.at ?? 'main', status);

    const loaded = await loadDeckForTool(slide, ref);
    if ('parseError' in loaded) {
      return ok({
        slide_id: slide.id,
        format: 'legacy_html',
        sha: null,
        parse_error: loaded.parseError,
        message: LEGACY_GUIDANCE,
      });
    }

    const { deck } = loaded;
    const base = {
      slide_id: slide.id,
      format: loaded.sha_source === 'deck' ? 'deck' : 'legacy_html',
      sha: loaded.sha,
      sha_source: loaded.sha_source,
      at: args.at ?? 'main',
      theme: deck.theme,
      ...(deck.themeDark ? { theme_dark: deck.themeDark } : {}),
      code_theme: deck.codeTheme,
      ...(deck.codeThemeDark ? { code_theme_dark: deck.codeThemeDark } : {}),
      slide_count: countSlides(deck.slides),
    };

    if (args.slide_ids?.length) {
      const selected: DeckSlide[] = [];
      for (const id of args.slide_ids) {
        const found = findSlide(deck.slides, id);
        if (!found) {
          throw new ToolError(
            'invalid_params',
            `Unknown slide id '${id}' — call deck_outline for current ids`
          );
        }
        selected.push(found.slide);
      }
      return ok({ ...base, slides: selected });
    }

    return ok({
      ...base,
      ...(deck.config ? { config: deck.config } : {}),
      ...(deck.customCss != null ? { custom_css: deck.customCss } : {}),
      slides: deck.slides,
    });
  },
};

// ─── deck_apply ──────────────────────────────────────────────────────────────

const attrsSchema = z.record(z.string());

const positionSchema = z.union([
  z.object({ after: z.string().min(1) }).strict(),
  z.object({ at: z.enum(['start', 'end']) }).strict(),
]);

const newSlideSchema = z
  .object({
    html: z.string().max(200_000),
    notes: z.string().max(50_000).optional(),
    hidden: z.boolean().optional(),
    attrs: attrsSchema.optional(),
  })
  .strict();

const opSchema = z.discriminatedUnion('op', [
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

type DeckOp = z.infer<typeof opSchema>;

/** Typed error for deck op failures (unknown ids, bad positions, bad values). */
class DeckOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeckOpError';
  }
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
 * Apply a sequence of deck operations. Pure — returns a new deck, input
 * untouched. Ops are applied sequentially, so later ops see earlier ops'
 * effects. Ids are matched at the top level and one stack level down.
 * EVERY incoming html/notes fragment rounds through normalizeSlideHtml
 * (SlideHtmlError propagates — stray <section> tags are rejected).
 */
function applyDeckOps(
  currentDeck: DeckJson,
  ops: DeckOp[]
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
        const used = collectIds(deck.slides);
        const inserted: DeckSlide[] = op.slides.map(spec => {
          let id = mintSlideId();
          while (used.has(id)) id = mintSlideId(); // re-mint collisions
          used.add(id);
          const next: DeckSlide = { id, html: normalizeSlideHtml(spec.html) };
          if (spec.notes != null && spec.notes !== '') {
            next.notes = normalizeSlideHtml(spec.notes);
          }
          if (spec.hidden) next.hidden = true;
          if (spec.attrs && Object.keys(spec.attrs).length > 0) next.attrs = { ...spec.attrs };
          return next;
        });
        insertSlidesAt(deck, inserted, op.position, 'insert');
        applied.push({ op: 'insert', count: inserted.length, ids: inserted.map(s => s.id) });
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
          if (deck.customCss === slideService.STARTER_CUSTOM_CSS) {
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

interface DeckApplyArgs {
  classroom: string;
  slide_id: string;
  expected_sha: string;
  sha_source?: DeckShaSource;
  ops: DeckOp[];
  commit?: 'preview' | 'direct';
}

export const deckApplyTool: ToolDefinition<DeckApplyArgs> = {
  name: 'deck_apply',
  annotations: { destructive: true, openWorld: true },
  title: 'Apply deck edits',
  description:
    'Applies granular slide operations (update / insert / move / delete / reorder / set_theme) ' +
    'to a deck in one commit. Requires expected_sha (+ sha_source) from deck_get or ' +
    'deck_outline; a CONTENT_CONFLICT error means the deck changed — re-read for a fresh sha. ' +
    "Published decks default to commit: 'preview' (a preview branch students never see — " +
    "review at the deck's ?preview=1 URL, then deck_preview_accept); drafts default to " +
    "commit: 'direct'. Pass commit explicitly to override either way. When a preview already " +
    "exists, applies STACK onto it and expected_sha must come from a read at: 'preview' " +
    "(main's sha will conflict). Slide html/notes must not contain <section> tags (slide " +
    'structure is managed via ops).',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    slide_id: z.string().uuid().describe('Slide deck id'),
    expected_sha: z
      .string()
      .min(1)
      .describe('Content sha from the last deck_get/deck_outline read (optimistic lock)'),
    sha_source: z
      .enum(['deck', 'legacy_html'])
      .optional()
      .describe("Which file the sha came from, as reported by deck_get/outline (default 'deck')"),
    ops: z
      .array(opSchema)
      .min(1)
      .max(25)
      .describe('Slide operations, applied sequentially (later ops see earlier effects)'),
    commit: z
      .enum(['preview', 'direct'])
      .optional()
      .describe(
        "Where to commit: 'preview' (singleton preview branch) or 'direct' (main). " +
          'Default: preview for published decks, direct for drafts'
      ),
  },
  handler: async (args, ctx) => {
    const slide = await loadSlideInClassroom(args.slide_id, ctx);
    await assertSlideEditable(slide, ctx);

    const shaSource: DeckShaSource = args.sha_source ?? 'deck';

    // §3b default routing: published decks preview, drafts direct.
    const committedTo: 'main' | 'preview' =
      (args.commit ?? (slide.is_draft === false ? 'preview' : 'direct')) === 'preview'
        ? 'preview'
        : 'main';

    // Stacking: when a preview already exists and we're committing to it,
    // load FROM it so this apply builds on the pending changes.
    let loadRef: string | undefined;
    if (committedTo === 'preview') {
      const status = await getDeckPreviewStatus(slide);
      if (status.exists) {
        loadRef = previewBranchName(slide.content_path);
      }
    }

    const loaded = await loadDeckForTool(slide, loadRef);
    if ('parseError' in loaded) {
      throw new ToolError('invalid_params', LEGACY_GUIDANCE);
    }

    // Which ref the sha was compared against — names the right re-read in
    // CONTENT_CONFLICT messages (stacking reads target the preview branch).
    const conflictAt: 'main' | 'preview' = loadRef ? 'preview' : 'main';

    // Optimistic lock (tool-level): the sha AND source the caller read must
    // still describe the file we loaded. saveDeck re-verifies both inside the
    // git operation (true CAS), so a racer between here and the commit still
    // surfaces as a 409, never a clobber.
    if (loaded.sha !== args.expected_sha || loaded.sha_source !== shaSource) {
      throw contentConflict(conflictAt);
    }

    const priorSlideCount = countSlides(loaded.deck.slides);

    let newDeck: DeckJson;
    let applied: Array<Record<string, unknown>>;
    try {
      ({ deck: newDeck, applied } = applyDeckOps(loaded.deck, args.ops));
    } catch (error: unknown) {
      if (error instanceof DeckOpError || error instanceof SlideHtmlError) {
        throw new ToolError('invalid_params', error.message);
      }
      throw error;
    }

    let createdPreviewBranch = false;
    if (committedTo === 'preview') {
      // Create the branch from main's current HEAD when absent (no-op when
      // stacking on an existing preview).
      const ensured = await ensureDeckPreviewBranch(slide);
      createdPreviewBranch = ensured.created;
    }

    // Shared-theme URLs are caller-resolved (the engine never calls services
    // itself); builtin/custom themes need none.
    const themeUrls = await resolveSharedThemeUrls(slide, newDeck);

    let saved: { sha: string; commit: string };
    try {
      saved = await saveDeck({
        slide,
        deck: newDeck,
        expectedSha: args.expected_sha,
        shaSource,
        message: `deck_apply: ${slide.title}`,
        ...(committedTo === 'preview' ? { branch: previewBranchName(slide.content_path) } : {}),
        ...(themeUrls ? { themeUrls } : {}),
      });
    } catch (error: unknown) {
      if ((error as { status?: number }).status === 409) {
        // The branch was created by THIS apply and the save failed — delete
        // the fresh (empty) branch so it doesn't strand the deck in preview
        // mode with no pending edits. Best-effort.
        if (createdPreviewBranch) {
          try {
            await discardDeckPreview(slide);
          } catch (cleanupError: unknown) {
            console.warn(
              '[deck_apply] Failed to clean up the freshly created preview branch:',
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            );
          }
        }
        throw contentConflict(conflictAt);
      }
      throw error;
    }

    const hasDestructiveOps = args.ops.some(op => op.op === 'delete');

    await writeAudit(ctx, {
      resource_type: 'SLIDES',
      resource_id: slide.id,
      action: 'UPDATE',
      data: {
        tool: 'deck_apply',
        ops: applied,
        expected_sha: args.expected_sha,
        new_sha: saved.sha,
        commit_sha: saved.commit,
        committed_to: committedTo,
        ...(hasDestructiveOps ? { prior_slide_count: priorSlideCount } : {}),
      } as Prisma.InputJsonValue,
    });

    return ok({
      success: true,
      new_sha: saved.sha,
      // deck.json now exists on the written branch — future applies key on it.
      sha_source: 'deck',
      committed_to: committedTo,
      slide_count: countSlides(newDeck.slides),
      applied,
    });
  },
};

// ─── deck_preview_accept ─────────────────────────────────────────────────────

interface DeckPreviewArgs {
  classroom: string;
  slide_id: string;
}

export const deckPreviewAcceptTool: ToolDefinition<DeckPreviewArgs> = {
  name: 'deck_preview_accept',
  annotations: { destructive: false, openWorld: true },
  title: 'Accept a deck preview',
  description:
    "Publishes a deck's pending preview: merges the preview branch into main (git auto-merges " +
    'non-overlapping edits), regenerates the index.html artifact from the merged deck.json, ' +
    'and deletes the branch. On a genuine same-slide conflict nothing merges — you get a ' +
    'per-slide report (ours = main, theirs = preview, base); re-read fresh main with deck_get, ' +
    're-apply the resolved slides, then accept again or discard.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    slide_id: z.string().uuid().describe('Slide deck id'),
  },
  handler: async (args, ctx) => {
    const slide = await loadSlideInClassroom(args.slide_id, ctx);
    await assertSlideEditable(slide, ctx);

    const status = await getDeckPreviewStatus(slide);
    if (!status.exists) {
      throw new ToolError('invalid_params', 'No pending preview for this deck — nothing to accept');
    }

    const result = await acceptDeckPreview(slide, {
      resolveThemeUrls: deck => resolveSharedThemeUrls(slide, deck),
    });

    if (result.merged) {
      await writeAudit(ctx, {
        resource_type: 'SLIDES',
        resource_id: slide.id,
        action: 'UPDATE',
        data: {
          tool: 'deck_preview_accept',
          outcome: 'merged',
          new_sha: result.sha,
          html_regenerated: result.html_regenerated,
          ...(result.preview_kept ? { preview_kept: true, reason: result.reason } : {}),
        } as Prisma.InputJsonValue,
      });
      return ok({
        success: true,
        merged: true,
        new_sha: result.sha,
        html_regenerated: result.html_regenerated,
        ...(result.preview_kept
          ? {
              preview_kept: true,
              message:
                'New changes arrived during accept — the preview branch was retained with the ' +
                `newer edits (${result.reason ?? 'concurrent apply'}). Review and accept again, ` +
                'or discard.',
            }
          : {}),
      });
    }

    await writeAudit(ctx, {
      resource_type: 'SLIDES',
      resource_id: slide.id,
      action: 'UPDATE',
      data: {
        tool: 'deck_preview_accept',
        outcome: 'conflict',
        conflict_unit_ids: result.units.map(unit => unit.id),
        ...(result.order_conflict ? { order_conflict: true } : {}),
        ours_sha: result.ours_sha,
        theirs_sha: result.theirs_sha,
      } as Prisma.InputJsonValue,
    });

    return ok({
      conflict: true,
      units: result.units,
      ...(result.order_conflict ? { order_conflict: result.order_conflict } : {}),
      ours_sha: result.ours_sha,
      theirs_sha: result.theirs_sha,
      message:
        'The preview conflicts with newer changes on main. Re-read fresh main with deck_get, ' +
        'merge each conflicted slide (ours = main, theirs = preview), re-apply with deck_apply, ' +
        'then accept again — or deck_preview_discard to drop the preview.',
    });
  },
};

// ─── deck_preview_discard ────────────────────────────────────────────────────

export const deckPreviewDiscardTool: ToolDefinition<DeckPreviewArgs> = {
  name: 'deck_preview_discard',
  annotations: { destructive: true, openWorld: true },
  title: 'Discard a deck preview',
  description:
    "Deletes a deck's pending preview branch, permanently dropping its uncommitted edits. " +
    'Main is untouched. Safe to call when no preview exists (reports it was already gone).',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    slide_id: z.string().uuid().describe('Slide deck id'),
  },
  handler: async (args, ctx) => {
    const slide = await loadSlideInClassroom(args.slide_id, ctx);
    await assertSlideEditable(slide, ctx);

    const result = await discardDeckPreview(slide);

    await writeAudit(ctx, {
      resource_type: 'SLIDES',
      resource_id: slide.id,
      action: 'DELETE',
      data: {
        tool: 'deck_preview_discard',
        existed: result.existed,
      } as Prisma.InputJsonValue,
    });

    return ok({
      success: true,
      discarded: true,
      ...(result.existed ? {} : { note: 'Preview branch was already gone' }),
    });
  },
};
