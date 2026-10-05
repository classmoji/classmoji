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
 * Tier — read and write are split ON PURPOSE, and the split is the policy:
 *   READ  (deck_outline / deck_get) — TEACHING_TEAM, no further sub-gate. Any
 *         OWNER/TEACHER/ASSISTANT of the classroom may read any of its decks,
 *         drafts included. This is NOT an oversight: the same rule is what the
 *         shared web gate applies for viewing (assertSlideAccess, view tier in
 *         auth/server.ts) and what list_slides lists. Adding assertSlideEditable
 *         to the read tools would narrow reading to the deck's creator — please
 *         do not "fix" it that way.
 *   WRITE (deck_apply / deck_preview_accept / deck_preview_discard) — the same
 *         TEACHING_TEAM entry gate PLUS the assertSlideEditable sub-gate:
 *         OWNER/TEACHER any deck; ASSISTANT own decks or allow_team_edit only.
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
  DeckParseError,
  acceptDeckPreview,
  discardDeckPreview,
  ensureDeckPreviewBranch,
  getDeckPreviewStatus,
  loadDeck,
  previewBranchName,
  resolveDeckPreviewConflicts,
  resolveSharedThemeUrls,
  saveDeck,
  slideService,
  splitDeckConflicts,
  type DeckJson,
  type DeckShaSource,
  type DeckSlide,
  type MergeResolution,
} from '@classmoji/services/slides';
// The op engine is imported via its OWN subpath (not `…/slides`) so test
// mocks of `@classmoji/services/slides` leave the real engine in place —
// op semantics in the deck tool tests stay genuine.
import {
  DeckOpError,
  SlideHtmlError,
  applyDeckOps,
  deckOpSchema,
  ensureSlideBlockIds,
  findSlide,
  prepareDeckOps,
  readSlideBlocks,
  type DeckOp,
  type SlideBlockInfo,
} from '@classmoji/services/slides/ops';
import type { SnapshotResponse } from '@classmoji/collab';
import { ContentService } from '@classmoji/services';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  CollabRequestError,
  actorFor,
  checkpointFields,
  fetchSnapshot,
  liveStateFor,
  requireLiveEnv,
  liveSha,
  liveReadError,
  liveWriteError,
  notifyPreviewChanged,
  parseLiveVersion,
  postMergePreview,
  postOps,
  type CollabEnv,
  type SnapshotViewer,
} from '../collab/client.ts';
import { assertLivePin, expectSinceFor, splitInsertedIds } from '../collab/liveCheck.ts';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../mcp/registry.ts';
import { renderAfterDeckApply } from './render.ts';
import {
  assertSlideEditable,
  loadSlideInClassroom,
  mapSemanticMergeError,
  ok,
  TEACHING_TEAM,
  writeAudit,
  type SlideWithRepoRecord,
} from './shared.ts';

// ─── Shared helpers ──────────────────────────────────────────────────────────

export const LEGACY_GUIDANCE =
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
export async function loadDeckForTool(
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
export function previewReadRef(
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

// ─── Live editing (classrooms with collab_enabled) ───────────────────────────

const LIVE_UNCONFIGURED_NOTE =
  'The live editing service is not configured here, so this is the last saved version from ' +
  "git — it may be behind the live deck. Live edits are refused; mode: 'preview' still works.";

const LIVE_FALLBACK_NOTE =
  'The live editing service did not answer, so this is the last saved version from git — it ' +
  "may be behind the live deck. Live edits fail until the service is back; mode: 'preview' " +
  'still works.';

/**
 * The live deck for a read, or why the read falls back to git: `note` when
 * the service is down (said in the result), none for a deck the live service
 * cannot hold (unparseable HTML, no content yet) — git then answers as today.
 */
export async function readLiveDeck(
  env: CollabEnv | null,
  slide: SlideWithRepoRecord,
  viewer: SnapshotViewer | null
): Promise<{ snapshot: SnapshotResponse<'deck'> } | { fallbackNote: string | null }> {
  if (!env) return { fallbackNote: LIVE_UNCONFIGURED_NOTE };
  try {
    // An agent's read (viewer) is remembered by the live service for its pin;
    // a render passes null, so a picture never stands in for a read.
    const snapshot = await fetchSnapshot(env, 'deck', slide.id, viewer);
    return { snapshot };
  } catch (error) {
    if (error instanceof CollabRequestError) {
      if (error.unavailable) {
        console.warn('[mcp] Live deck snapshot unavailable, reading git:', error.message);
        return { fallbackNote: LIVE_FALLBACK_NOTE };
      }
      if (error.code === 'unparseable-deck' || error.code === 'content-missing') {
        return { fallbackNote: null };
      }
      if (error.status === 404)
        throw new ToolError('not_found', 'Slide not found in this classroom');
      throw liveReadError(error, 'deck');
    }
    throw error;
  }
}

/** The head fields of a live read (same keys and order as a git read). */
function liveDeckHead(slide: SlideWithRepoRecord, snapshot: SnapshotResponse<'deck'>) {
  const deck = snapshot.content;
  return {
    slide_id: slide.id,
    format: 'deck',
    sha: liveSha(snapshot.epoch, snapshot.version),
    sha_source: 'live',
    version: snapshot.version,
    epoch: snapshot.epoch,
    live: { open_now: snapshot.live },
    ...checkpointFields(snapshot),
    at: 'main',
    theme: deck.theme,
    ...(deck.themeDark ? { theme_dark: deck.themeDark } : {}),
    code_theme: deck.codeTheme,
    ...(deck.codeThemeDark ? { code_theme_dark: deck.codeThemeDark } : {}),
    slide_count: countSlides(deck.slides),
  };
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

// ─── Blocks ──────────────────────────────────────────────────────────────────

/** Block types the block ops build and agents edit by id. */
const AGENT_BLOCK_TYPES = new Set(['html', 'svg', 'iframe']);

/**
 * A slide's blocks as agents see them: html, svg and iframe blocks, and any
 * block with an id. `content` adds each one's decoded source / svg / src.
 * A block made before block ids is listed under the id the op engine derives
 * for it (ensureSlideBlockIds), so block_update / block_delete can name it;
 * the write then stores that id.
 */
function agentBlocks(html: string | undefined, content: boolean): SlideBlockInfo[] {
  if (!html || !html.includes('sl-block')) return [];
  const stored = readSlideBlocks(html, { content: false });
  let withIds: SlideBlockInfo[];
  try {
    withIds = readSlideBlocks(ensureSlideBlockIds(html), { content });
  } catch {
    // html the normalizer refuses: list what is stored, as a read always did.
    withIds = [];
  }
  // Same blocks, same order: only the missing ids differ.
  if (withIds.length !== stored.length) {
    return readSlideBlocks(html, { content }).filter(
      block => block.id !== null || AGENT_BLOCK_TYPES.has(block.type)
    );
  }
  return withIds.filter(
    (_block, i) => stored[i].id !== null || AGENT_BLOCK_TYPES.has(stored[i].type)
  );
}

/**
 * deck_get's copy of a slide: `blocks` (decoded) on any slide that has some.
 * A NEW object — the slide may be a cached live snapshot, which must stay as
 * the read returned it.
 */
function slideWithBlocks(slide: DeckSlide): DeckSlide & { blocks?: SlideBlockInfo[] } {
  const blocks = agentBlocks(slide.html, true);
  return {
    ...slide,
    ...(slide.children ? { children: slide.children.map(slideWithBlocks) } : {}),
    ...(blocks.length > 0 ? { blocks } : {}),
  };
}

interface DeckOutlineEntry {
  id: string;
  /** Dotted position, '4' or '4.2' (vertical-stack children). */
  index: string;
  preview: string;
  hidden: boolean;
  has_notes: boolean;
  /** html / svg / iframe blocks (and any block with an id): id, type, box. */
  blocks?: SlideBlockInfo[];
  children?: DeckOutlineEntry[];
}

function outlineEntry(slide: DeckSlide, index: string): DeckOutlineEntry {
  const blocks = agentBlocks(slide.html, false);
  const entry: DeckOutlineEntry = {
    id: slide.id,
    index,
    preview: slideTextPreview(slide.html),
    hidden: slide.hidden === true,
    has_notes: slide.notes != null && slide.notes !== '',
    ...(blocks.length > 0 ? { blocks } : {}),
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
    "'4.2' for vertical stacks, ≤80-char text preview, hidden, has_notes, blocks: id/type/box of " +
    'html, svg and iframe blocks) plus theme info, the ' +
    'content sha + sha_source, and pending-preview status. Start here, then fetch only the ' +
    'slides you need with deck_get (slide_ids) and edit them with deck_apply — never ' +
    "round-trip whole decks. Pass at: 'preview' to outline the pending preview instead of main. " +
    "In a classroom with live editing, main is the live deck and sha is its version ('live:E.V').",
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
    // No assertSlideEditable here, deliberately: reading a deck is a
    // teaching-team right (view tier), while editing it stays with the
    // creator / allow_team_edit. See the read-vs-write note in the file header.
    const slide = await loadSlideInClassroom(args.slide_id, ctx);
    const status = await getDeckPreviewStatus(slide);
    const ref = previewReadRef(slide, args.at ?? 'main', status);

    // Live editing: 'main' is the live deck, read from the collab server.
    const liveState = liveStateFor(slide.classroom);
    let fallback: Record<string, unknown> = {};
    if (liveState && !ref) {
      const live = await readLiveDeck(liveState.env, slide, ctx.viewer);
      if ('snapshot' in live) {
        const { slide_id, ...head } = liveDeckHead(slide, live.snapshot);
        return ok({
          slide_id,
          title: slide.title,
          ...head,
          preview: previewPayload(status),
          slides: outlineSlides(live.snapshot.content.slides),
        });
      }
      if (live.fallbackNote) fallback = { live_unavailable: true, note: live.fallbackNote };
    }

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
        ...fallback,
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
      ...fallback,
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
    "Pass at: 'preview' to read the pending preview branch. In a classroom with live editing, " +
    "main is the live deck and sha is its version ('live:E.V', sha_source 'live'). A slide's " +
    'blocks list its html/svg/iframe blocks with source, svg or src decoded.',
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
    // No assertSlideEditable here, deliberately: reading a deck is a
    // teaching-team right (view tier), while editing it stays with the
    // creator / allow_team_edit. See the read-vs-write note in the file header.
    const slide = await loadSlideInClassroom(args.slide_id, ctx);
    const status = await getDeckPreviewStatus(slide);
    const ref = previewReadRef(slide, args.at ?? 'main', status);

    // Live editing: 'main' is the live deck, read from the collab server.
    const liveState = liveStateFor(slide.classroom);
    let fallback: Record<string, unknown> = {};
    if (liveState && !ref) {
      const live = await readLiveDeck(liveState.env, slide, ctx.viewer);
      if ('snapshot' in live) {
        return ok(
          selectSlides(liveDeckHead(slide, live.snapshot), live.snapshot.content, args.slide_ids)
        );
      }
      if (live.fallbackNote) fallback = { live_unavailable: true, note: live.fallbackNote };
    }

    const loaded = await loadDeckForTool(slide, ref);
    if ('parseError' in loaded) {
      return ok({
        slide_id: slide.id,
        format: 'legacy_html',
        sha: null,
        parse_error: loaded.parseError,
        message: LEGACY_GUIDANCE,
        ...fallback,
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

    return ok({ ...selectSlides(base, deck, args.slide_ids), ...fallback });
  },
};

/** deck_get's payload: `head`, then the requested slides (or the whole deck). */
function selectSlides(
  head: Record<string, unknown>,
  deck: DeckJson,
  slideIds: string[] | undefined
): Record<string, unknown> {
  if (slideIds?.length) {
    const selected: DeckSlide[] = [];
    for (const id of slideIds) {
      const found = findSlide(deck.slides, id);
      if (!found) {
        throw new ToolError(
          'invalid_params',
          `Unknown slide id '${id}' — call deck_outline for current ids`
        );
      }
      selected.push(found.slide);
    }
    return { ...head, slides: selected.map(slideWithBlocks) };
  }
  return {
    ...head,
    ...(deck.config ? { config: deck.config } : {}),
    ...(deck.customCss != null ? { custom_css: deck.customCss } : {}),
    slides: deck.slides.map(slideWithBlocks),
  };
}

// ─── deck_apply ──────────────────────────────────────────────────────────────

interface DeckApplyArgs {
  classroom: string;
  slide_id: string;
  expected_sha?: string;
  sha_source?: DeckShaSource | 'live';
  ops: DeckOp[];
  commit?: 'preview' | 'direct';
  mode?: 'live' | 'preview';
  render?: boolean;
}

/**
 * deck_apply in live mode: the ops go into the live deck through the collab
 * server, as the caller (peers see them as `<name> (agent)`). `expected_sha`
 * is the live version a read returned; a stale one is refused. The ops are
 * replayed on the snapshot here first so a bad id or html is reported
 * plainly; a slide a person is editing refuses the whole call (409).
 */
/**
 * The live ids for one insert's applied entry: `flat` is the server's list
 * for that op — each new slide, then a new stack's children — in the order
 * the entry lists them. `rename` maps the entry's local ids to the live ones.
 * Null when they do not line up.
 */
function liveInsertIds(
  entry: Record<string, unknown>,
  flat: string[]
): { ids: string[]; children: Record<string, string[]>; rename: Map<string, string> } | null {
  const localIds = Array.isArray(entry.ids) ? (entry.ids as string[]) : [];
  const localChildren = (entry.children ?? {}) as Record<string, string[]>;
  const ids: string[] = [];
  const children: Record<string, string[]> = {};
  const rename = new Map<string, string>();
  let at = 0;
  for (const local of localIds) {
    const top = flat[at++];
    if (top === undefined) return null;
    ids.push(top);
    rename.set(local, top);
    const kids = localChildren[local] ?? [];
    if (kids.length > 0) children[top] = [];
    for (const kid of kids) {
      const id = flat[at++];
      if (id === undefined) return null;
      children[top].push(id);
      rename.set(kid, id);
    }
  }
  return at === flat.length ? { ids, children, rename } : null;
}

async function applyDeckLive(
  env: CollabEnv,
  slide: SlideWithRepoRecord,
  args: DeckApplyArgs,
  ctx: ToolContext
) {
  assertLivePin('deck', args.expected_sha, args.ops);
  let snapshot: SnapshotResponse<'deck'>;
  try {
    // The dry run's base, not an agent read: nothing is remembered.
    snapshot = await fetchSnapshot(env, 'deck', slide.id);
  } catch (error) {
    throw liveWriteError(error, 'deck');
  }
  const since = expectSinceFor('deck', args.expected_sha, snapshot);

  let newDeck: DeckJson;
  let applied: Array<Record<string, unknown>>;
  try {
    ({ deck: newDeck, applied } = applyDeckOps(snapshot.content, args.ops, {
      starterCustomCss: slideService.STARTER_CUSTOM_CSS,
    }));
  } catch (error: unknown) {
    if (error instanceof DeckOpError || error instanceof SlideHtmlError) {
      throw new ToolError('invalid_params', error.message);
    }
    throw error;
  }
  const hasInsert = applied.some(entry => entry.op === 'insert');

  // Only what the ops depend on must still be as the agent was shown it
  // (slide order for a reorder, the theme for set_theme): the server judges
  // that inside the live transaction.
  const actor = await actorFor(ctx);
  let response: Awaited<ReturnType<typeof postOps>>;
  try {
    response = await postOps(env, 'deck', slide.id, args.ops, actor, since);
  } catch (error) {
    throw liveWriteError(error, 'deck', { expectedSha: args.expected_sha });
  }
  const { version } = response;
  const epoch = response.epoch ?? snapshot.epoch;
  const insertedIds = splitInsertedIds(args.ops, response.insertedIds);

  // Inserted slides carry the ids the LIVE deck gave them, never this dry
  // run's (random) ones; a new stack's children too.
  applied = applied.map((entry, i) => {
    if (entry.op !== 'insert') return entry;
    const { ids: _ids, children: _children, ...rest } = entry;
    const live = insertedIds ? liveInsertIds(entry, insertedIds[i]) : null;
    if (!live) return rest;
    return {
      ...rest,
      ids: live.ids,
      ...(Object.keys(live.children).length > 0 ? { children: live.children } : {}),
    };
  });

  const hasDestructiveOps = args.ops.some(op => op.op === 'delete');
  await writeAudit(ctx, {
    resource_type: 'SLIDES',
    resource_id: slide.id,
    action: 'UPDATE',
    data: {
      tool: 'deck_apply',
      ops: applied,
      ...(args.expected_sha ? { expected_sha: args.expected_sha } : {}),
      new_sha: liveSha(epoch, version),
      // Distinct per write: two applies inside the audit's 5 s window both stay.
      value: liveSha(epoch, version),
      committed_to: 'live',
      ...(hasDestructiveOps ? { prior_slide_count: countSlides(snapshot.content.slides) } : {}),
    } as Prisma.InputJsonValue,
  });

  return ok({
    success: true,
    new_sha: liveSha(epoch, version),
    sha_source: 'live',
    version,
    committed_to: 'live',
    slide_count: countSlides(newDeck.slides),
    applied,
    ...(!insertedIds && Array.isArray(response.insertedIds) && response.insertedIds.length > 0
      ? { inserted_ids: response.insertedIds }
      : {}),
    ...(hasInsert && !insertedIds
      ? { note: 'The live deck named the inserted slides; call deck_outline for their ids.' }
      : {}),
  });
}

/**
 * Where staff review a deck's preview: the slides app renders the preview
 * branch at `/<slideId>?preview=1` with the changed slides outlined.
 * SLIDES_URL is read at call time; outside production it defaults to the
 * local slides app. Null in production without SLIDES_URL (no link then).
 */
function deckPreviewUrl(slide: SlideWithRepoRecord): string | null {
  const base =
    process.env.SLIDES_URL?.trim() ||
    (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:6500');
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(slide.id)}?preview=1`;
}

export const deckApplyTool: ToolDefinition<DeckApplyArgs> = {
  name: 'deck_apply',
  annotations: { destructive: true, openWorld: true },
  title: 'Apply deck edits',
  description:
    'Applies granular slide operations (update / insert / move / delete / reorder / set_theme) ' +
    'to a deck. Pass expected_sha (+ sha_source) from deck_get or deck_outline, or your last ' +
    'new_sha; CONTENT_CONFLICT means that sha is stale or unknown — re-read. ' +
    "In live mode it is the version ('live:E.V'), required except for pure inserts (their " +
    'new_sha covers only what they add); edits ' +
    'elsewhere do not block you, but ops on slides someone changed since are refused ' +
    '(BLOCK_CHANGED, ids named). ' +
    "mode: 'live' edits the deck itself (with live editing on, people in the editor see it at " +
    "once, and a slide someone is editing refuses the call); mode: 'preview' stages the edits " +
    "— students never see them — for review as rendered slides at the result's preview_url " +
    'with changed slides highlighted, then deck_preview_accept. Default: live for drafts, ' +
    'preview for published decks. Use preview for big edits: many slides, restructuring, ' +
    'rewrites. When a preview already ' +
    "exists, preview applies STACK onto it and expected_sha must come from a read at: 'preview' " +
    "(main's sha will conflict). Slide html/notes must not contain <section> tags (slide " +
    'structure is managed via ops). To create a vertical stack, insert a slide with ' +
    "children (child slides, one nesting level) instead of html; the response's applied " +
    "entry reports the new ids, a new stack's child ids included. " +
    'render: true also returns images + the overflow report of the slides changed (see deck_render).',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    slide_id: z.string().uuid().describe('Slide deck id'),
    expected_sha: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Content sha from the last deck_get/deck_outline read (optimistic lock). Required ' +
          "except for pure inserts in live mode, where it is the version ('live:E.V') and " +
          'protects edits people made since your read to the slides your ops touch'
      ),
    sha_source: z
      .enum(['deck', 'legacy_html', 'live'])
      .optional()
      .describe("Where the sha came from, as reported by deck_get/outline (default 'deck')"),
    ops: z
      .array(deckOpSchema)
      .min(1)
      .max(25)
      .describe(
        'Slide operations, applied sequentially (later ops see earlier effects). ' +
          'block_add / block_update / block_delete edit one html, svg or iframe block of a slide'
      ),
    mode: z
      .enum(['live', 'preview'])
      .optional()
      .describe(
        "'live' edits the deck itself; 'preview' stages the edits for review. Default: live " +
          'for drafts, preview for published decks. Takes precedence over commit'
      ),
    commit: z
      .enum(['preview', 'direct'])
      .optional()
      .describe(
        "Older name for mode: 'preview', or 'direct' (= live). " +
          'Default: preview for published decks, direct for drafts'
      ),
    render: z
      .boolean()
      .optional()
      .describe('Also return images + overflow of the changed slides (default false)'),
  },
  handler: async (args, ctx) => {
    const result = await applyDeckEdits(args, ctx);
    return args.render ? renderAfterDeckApply(result, args.slide_id, ctx) : result;
  },
};

/** deck_apply itself; `render: true` is layered on by the handler above. */
async function applyDeckEdits(rawArgs: DeckApplyArgs, ctx: ToolContext): Promise<ToolResult> {
  const slide = await loadSlideInClassroom(rawArgs.slide_id, ctx);
  await assertSlideEditable(slide, ctx);

  // Block ops leave here ready to apply anywhere: a new block's id is fixed
  // now (the dry run, the live server and the replay must name the same
  // block), and iframe srcs are resolved against the deck folder.
  const org = slide.classroom.git_organization?.login;
  const repo = slide.classroom.content_repo;
  const args: DeckApplyArgs = {
    ...rawArgs,
    ops: prepareDeckOps(
      rawArgs.ops,
      org && repo ? { org, repo, contentPath: slide.content_path } : null
    ),
  };

  // Live editing: 'live' goes into the live deck through the collab server;
  // git main is only its checkpoint and is never written here.
  const liveState = liveStateFor(slide.classroom);
  const commit =
    args.mode !== undefined ? (args.mode === 'live' ? 'direct' : 'preview') : args.commit;

  // §3b default routing: published decks preview, drafts direct.
  const committedTo: 'main' | 'preview' =
    (commit ?? (slide.is_draft === false ? 'preview' : 'direct')) === 'preview'
      ? 'preview'
      : 'main';

  if (liveState && committedTo === 'main') {
    return applyDeckLive(requireLiveEnv(liveState), slide, args, ctx);
  }
  if (!args.expected_sha) {
    throw new ToolError(
      'invalid_params',
      'expected_sha is required — pass the sha from deck_get or deck_outline'
    );
  }
  // A live read's version stands in for main's sha when a NEW preview is
  // cut from main: the agent read the live deck, which has no git sha.
  const liveRead =
    liveState !== null &&
    (args.sha_source === 'live' || parseLiveVersion(args.expected_sha) !== null);
  const shaSource = (args.sha_source ?? 'deck') as DeckShaSource;

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

  // Stacking onto a preview needs the preview's own sha, never a live one.
  if (liveRead && loadRef) throw contentConflict('preview');
  const expectedSha = liveRead ? loaded.sha : args.expected_sha;
  const expectedSource = liveRead ? loaded.sha_source : shaSource;

  // Optimistic lock (tool-level): the sha AND source the caller read must
  // still describe the file we loaded. saveDeck re-verifies both inside the
  // git operation (true CAS), so a racer between here and the commit still
  // surfaces as a 409, never a clobber.
  if (loaded.sha !== expectedSha || loaded.sha_source !== expectedSource) {
    throw contentConflict(conflictAt);
  }

  const priorSlideCount = countSlides(loaded.deck.slides);

  let newDeck: DeckJson;
  let applied: Array<Record<string, unknown>>;
  try {
    ({ deck: newDeck, applied } = applyDeckOps(loaded.deck, args.ops, {
      starterCustomCss: slideService.STARTER_CUSTOM_CSS,
    }));
  } catch (error: unknown) {
    if (error instanceof DeckOpError || error instanceof SlideHtmlError) {
      throw new ToolError(
        'invalid_params',
        liveRead && error instanceof DeckOpError
          ? `${error.message}. A preview starts from the last saved version, which may not ` +
              "have slides added in the last minute yet — retry shortly or use mode: 'live'."
          : error.message
      );
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
      expectedSha: expectedSha ?? args.expected_sha,
      shaSource: expectedSource,
      message: `deck_apply: ${slide.title}`,
      ...(committedTo === 'preview' ? { branch: previewBranchName(slide.content_path) } : {}),
      ...(themeUrls ? { themeUrls } : {}),
    });
  } catch (error: unknown) {
    if ((error as { status?: number }).status === 409) {
      // The branch was created by THIS apply and the save failed — delete
      // the fresh (empty) branch so it doesn't strand the deck in preview
      // mode with no pending edits. Best-effort.
      //
      // BUT re-check first: a concurrent apply (the racer that got the 422
      // "already exists" from ensureDeckPreviewBranch) may have committed to
      // the branch between our creation and this failed save. Deleting it
      // then would silently discard that writer's commits — so skip the
      // discard when the branch moved past main (same ahead_by guard the
      // Phase 7 accept paths use).
      if (createdPreviewBranch) {
        try {
          const status = await getDeckPreviewStatus(slide);
          if (status.exists && (status.commits_ahead ?? 0) > 0) {
            console.warn(
              `[deck_apply] Preview branch gained ${status.commits_ahead} concurrent ` +
                'commit(s) after creation — keeping it instead of discarding after the ' +
                'failed save.'
            );
          } else {
            await discardDeckPreview(slide);
          }
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
      // Distinct per write: two applies inside the audit's 5 s window both stay.
      value: saved.sha,
      commit_sha: saved.commit,
      committed_to: committedTo,
      ...(hasDestructiveOps ? { prior_slide_count: priorSlideCount } : {}),
    } as Prisma.InputJsonValue,
  });

  // Open live editors refresh their pending-preview banner.
  if (committedTo === 'preview') await notifyPreviewChanged(slide.classroom, 'deck', slide.id);

  const previewUrl = committedTo === 'preview' ? deckPreviewUrl(slide) : null;
  return ok({
    success: true,
    new_sha: saved.sha,
    // deck.json now exists on the written branch — future applies key on it.
    sha_source: 'deck',
    committed_to: committedTo,
    ...(previewUrl ? { preview_url: previewUrl } : {}),
    slide_count: countSlides(newDeck.slides),
    applied,
  });
}

// ─── deck_preview_accept ─────────────────────────────────────────────────────

interface DeckPreviewArgs {
  classroom: string;
  slide_id: string;
}

interface DeckPreviewAcceptArgs extends DeckPreviewArgs {
  resolutions?: MergeResolution[];
  expected_ours_sha?: string;
  expected_theirs_sha?: string;
}

/**
 * deck_preview_accept in live mode. The collab server runs the three-way
 * merge (base = the preview's merge-base with main, ours = the live deck,
 * theirs = the preview) inside the live transaction and applies it id-aware;
 * conflicts apply nothing and come back as the usual report, a slide a person
 * is editing refuses the accept. The branch is deleted only once it landed.
 */
async function acceptDeckPreviewLive(
  env: CollabEnv,
  slide: SlideWithRepoRecord,
  args: DeckPreviewAcceptArgs,
  ctx: ToolContext
) {
  const branch = previewBranchName(slide.content_path);
  const comparison = await ContentService.compareBranches({
    gitOrganization: slide.classroom.git_organization as never,
    repo: slide.classroom.content_repo ?? '',
    base: 'main',
    head: branch,
  });
  if (!comparison) {
    throw new ToolError('invalid_params', 'No pending preview for this deck — nothing to accept');
  }
  const [theirs, base] = await Promise.all([
    loadDeckForTool(slide, branch),
    comparison.merge_base_sha ? loadDeckForTool(slide, comparison.merge_base_sha) : null,
  ]);
  if ('parseError' in theirs) throw new ToolError('invalid_params', LEGACY_GUIDANCE);
  // Without the deck as it was when the preview started there is no telling
  // the preview's edits from what the live deck gained since.
  if (!base || 'parseError' in base) {
    throw new ToolError(
      'invalid_params',
      'This preview can no longer be merged into the live deck — discard it with ' +
        'deck_preview_discard and make the change again'
    );
  }
  if (
    args.resolutions?.length &&
    args.expected_theirs_sha &&
    args.expected_theirs_sha !== theirs.sha
  ) {
    throw new ToolError(
      'invalid_params',
      'The preview changed since that conflict report — call deck_preview_accept again ' +
        'without resolutions for a fresh report',
      'CONTENT_CONFLICT'
    );
  }

  const actor = await actorFor(ctx);
  let outcome;
  try {
    outcome = await postMergePreview(env, 'deck', slide.id, {
      base: base.deck,
      theirs: theirs.deck,
      ...(args.resolutions?.length
        ? { resolutions: args.resolutions.map(({ id, choose }) => ({ id, choose })) }
        : {}),
      actor,
    });
  } catch (error) {
    throw liveWriteError(error, 'deck', { previewHint: false });
  }

  if (!outcome.applied) {
    const { units, orderConflict } = splitDeckConflicts(
      outcome.conflicts as unknown as Parameters<typeof splitDeckConflicts>[0]
    );
    await writeAudit(ctx, {
      resource_type: 'SLIDES',
      resource_id: slide.id,
      action: 'UPDATE',
      data: {
        tool: 'deck_preview_accept',
        outcome: 'conflict',
        committed_to: 'live',
        conflict_unit_ids: units.map(unit => unit.id),
        ...(orderConflict ? { order_conflict: true } : {}),
        theirs_sha: theirs.sha,
      } as Prisma.InputJsonValue,
    });
    const conflictCount = units.length + (orderConflict ? 1 : 0);
    return ok({
      conflict: true,
      units,
      ...(orderConflict ? { order_conflict: orderConflict } : {}),
      ...(outcome.autoMerged !== undefined ? { auto_merged: outcome.autoMerged } : {}),
      ours_sha: 'live',
      theirs_sha: theirs.sha,
      message:
        `${conflictCount} conflict(s) between the live deck (ours) and the preview (theirs) ` +
        'need a decision; nothing was applied. Call deck_preview_accept again with resolutions ' +
        "(one {id, choose: 'ours'|'theirs'} per conflict id — include '__order__' if " +
        "order_conflict is present), passing this report's theirs_sha as expected_theirs_sha; " +
        'the live side is re-merged at that moment. Or deck_preview_discard to drop the preview.',
    });
  }

  // Delete the branch only if it is still exactly what was merged: a commit
  // that landed on it during the accept would otherwise be lost unseen.
  let previewKept: string | null = null;
  try {
    const nowAt = await ContentService.compareBranches({
      gitOrganization: slide.classroom.git_organization as never,
      repo: slide.classroom.content_repo ?? '',
      base: 'main',
      head: branch,
    });
    if (nowAt && nowAt.head_sha !== comparison.head_sha) {
      previewKept =
        'The preview is merged into the live deck, but new edits landed on it during the ' +
        'accept, so it was kept with them — review it and accept again, or discard it.';
    } else if (nowAt) {
      await discardDeckPreview(slide);
    }
  } catch (error) {
    console.warn('[deck_preview_accept] Merged live but could not delete the preview:', error);
    previewKept =
      'The preview is merged into the live deck, but its branch could not be deleted — ' +
      'call deck_preview_discard to remove it.';
  }
  await notifyPreviewChanged(slide.classroom, 'deck', slide.id);

  await writeAudit(ctx, {
    resource_type: 'SLIDES',
    resource_id: slide.id,
    action: 'UPDATE',
    data: {
      tool: 'deck_preview_accept',
      outcome: 'merged',
      committed_to: 'live',
      semantic: true,
      new_version: outcome.version,
      ...(args.resolutions?.length
        ? { resolutions: args.resolutions.map(({ id, choose }) => ({ id, choose })) }
        : {}),
      ...(previewKept ? { preview_kept: true } : {}),
    } as unknown as Prisma.InputJsonValue,
  });
  return ok({
    success: true,
    merged: true,
    committed_to: 'live',
    version: outcome.version,
    ...(args.resolutions?.length ? { resolved: args.resolutions } : {}),
    ...(previewKept ? { preview_kept: true, message: previewKept } : {}),
  });
}

export const deckPreviewAcceptTool: ToolDefinition<DeckPreviewAcceptArgs> = {
  name: 'deck_preview_accept',
  annotations: { destructive: false, openWorld: true },
  title: 'Accept a deck preview',
  description:
    "Publishes a deck's pending preview: merges the preview branch into main, regenerates the " +
    'index.html artifact from the merged deck.json, and deletes the branch. Non-overlapping ' +
    'edits merge automatically (git first, then a per-slide semantic 3-way merge — the result ' +
    'reports semantic: true with the auto_merged count when that layer kicked in). Only genuine ' +
    'same-unit collisions stop the accept: you get a report of just those units (ours = main, ' +
    'theirs = preview, base) plus auto_merged. A top-level slide-order conflict is reported ' +
    "separately as order_conflict — resolve it via the '__order__' id (unlike " +
    "page_preview_accept, which lists '__order__' inside units). To finish, either call this " +
    'tool again with ' +
    'resolutions — one {id, choose: ours|theirs} per reported conflict id (ours = keep the live ' +
    "main version, theirs = keep the preview's), passing the report's ours_sha/theirs_sha as " +
    'expected_ours_sha/expected_theirs_sha to pin your choices to the state you reviewed — or ' +
    're-read fresh main with deck_get, re-apply ' +
    'merged slides with deck_apply and accept again, or deck_preview_discard. With live ' +
    'editing on, the preview merges into the live deck (ours = live) and a conflict applies ' +
    'nothing.',
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    slide_id: z.string().uuid().describe('Slide deck id'),
    resolutions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            choose: z.enum(['ours', 'theirs']),
          })
          .strict()
      )
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Per-conflict choices from a prior conflict report: ours = keep main's (live) version, " +
          "theirs = keep the preview's. Must cover EVERY reported conflict id — slide ids plus " +
          "the sentinels '__order__' (slide order), '__order__:<stackId>' (a stack's child " +
          "order), and '__meta__' (theme/config). Omit to attempt a plain accept."
      ),
    expected_ours_sha: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Pass the ours_sha from the conflict report your resolutions answer. If main's deck " +
          'changed since that report, the accept fails with CONTENT_CONFLICT instead of ' +
          'applying reviewed choices to unseen content. Only meaningful with resolutions. ' +
          "With live editing on it is not checked (the report says 'live'): the live deck " +
          'is re-merged atomically when the accept runs.'
      ),
    expected_theirs_sha: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Pass the theirs_sha from the conflict report your resolutions answer (same staleness ' +
          'pin for the preview side). Only meaningful with resolutions.'
      ),
  },
  handler: async (args, ctx) => {
    const slide = await loadSlideInClassroom(args.slide_id, ctx);
    await assertSlideEditable(slide, ctx);

    const status = await getDeckPreviewStatus(slide);
    if (!status.exists) {
      throw new ToolError('invalid_params', 'No pending preview for this deck — nothing to accept');
    }

    // Live editing: the preview merges into the live deck, not main.
    const liveState = liveStateFor(slide.classroom);
    if (liveState) return acceptDeckPreviewLive(requireLiveEnv(liveState), slide, args, ctx);

    // ── Resolutions path: apply chooser decisions to the conflicted merge ──
    if (args.resolutions?.length) {
      let result;
      try {
        result = await resolveDeckPreviewConflicts(slide, {
          resolutions: args.resolutions,
          resolveThemeUrls: deck => resolveSharedThemeUrls(slide, deck),
          ...(args.expected_ours_sha ? { expectedOursSha: args.expected_ours_sha } : {}),
          ...(args.expected_theirs_sha ? { expectedTheirsSha: args.expected_theirs_sha } : {}),
        });
      } catch (error: unknown) {
        throw mapSemanticMergeError(error, 'deck_preview_accept');
      }
      await notifyPreviewChanged(slide.classroom, 'deck', slide.id);

      await writeAudit(ctx, {
        resource_type: 'SLIDES',
        resource_id: slide.id,
        action: 'UPDATE',
        data: {
          tool: 'deck_preview_accept',
          outcome: 'merged',
          semantic: true,
          resolutions: args.resolutions.map(({ id, choose }) => ({ id, choose })),
          auto_merged: result.auto_merged,
          new_sha: result.sha,
          html_regenerated: result.html_regenerated,
          ...(result.preview_kept ? { preview_kept: true, reason: result.reason } : {}),
        } as unknown as Prisma.InputJsonValue,
      });
      return ok({
        success: true,
        merged: true,
        semantic: true,
        resolved: args.resolutions,
        auto_merged: result.auto_merged,
        new_sha: result.sha,
        html_regenerated: result.html_regenerated,
        ...(result.preview_kept ? { preview_kept: true, reason: result.reason } : {}),
      });
    }

    let result;
    try {
      result = await acceptDeckPreview(slide, {
        resolveThemeUrls: deck => resolveSharedThemeUrls(slide, deck),
      });
    } catch (error: unknown) {
      throw mapSemanticMergeError(error, 'deck_preview_accept');
    }

    if (result.merged) {
      await notifyPreviewChanged(slide.classroom, 'deck', slide.id);

      await writeAudit(ctx, {
        resource_type: 'SLIDES',
        resource_id: slide.id,
        action: 'UPDATE',
        data: {
          tool: 'deck_preview_accept',
          outcome: 'merged',
          new_sha: result.sha,
          html_regenerated: result.html_regenerated,
          ...(result.semantic ? { semantic: true, auto_merged: result.auto_merged } : {}),
          ...(result.preview_kept ? { preview_kept: true, reason: result.reason } : {}),
        } as Prisma.InputJsonValue,
      });
      return ok({
        success: true,
        merged: true,
        new_sha: result.sha,
        html_regenerated: result.html_regenerated,
        ...(result.semantic ? { semantic: true, auto_merged: result.auto_merged } : {}),
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
        auto_merged: result.auto_merged,
        ours_sha: result.ours_sha,
        theirs_sha: result.theirs_sha,
      } as Prisma.InputJsonValue,
    });

    const conflictCount = result.units.length + (result.order_conflict ? 1 : 0);
    return ok({
      conflict: true,
      units: result.units,
      ...(result.order_conflict ? { order_conflict: result.order_conflict } : {}),
      auto_merged: result.auto_merged,
      ours_sha: result.ours_sha,
      theirs_sha: result.theirs_sha,
      message:
        `${result.auto_merged} change(s) auto-merge cleanly; ${conflictCount} conflict(s) need ` +
        'a decision. Resolve by calling deck_preview_accept again with resolutions ' +
        "(one {id, choose: 'ours'|'theirs'} per conflict id — include '__order__' if " +
        "order_conflict is present; ours = main, theirs = preview), passing this report's " +
        'ours_sha/theirs_sha as expected_ours_sha/expected_theirs_sha — or re-read fresh main ' +
        'with deck_get, re-apply merged slides with deck_apply and accept again, or ' +
        'deck_preview_discard to drop the preview.',
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
    await notifyPreviewChanged(slide.classroom, 'deck', slide.id);

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
