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
  findSlide,
  type DeckOp,
} from '@classmoji/services/slides/ops';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
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
    'structure is managed via ops). To create a vertical stack, insert a slide with ' +
    "children (child slides, one nesting level) instead of html; the response's applied " +
    'entry reports the minted container and child ids.',
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
      .array(deckOpSchema)
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
      ({ deck: newDeck, applied } = applyDeckOps(loaded.deck, args.ops, {
        starterCustomCss: slideService.STARTER_CUSTOM_CSS,
      }));
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

interface DeckPreviewAcceptArgs extends DeckPreviewArgs {
  resolutions?: MergeResolution[];
  expected_ours_sha?: string;
  expected_theirs_sha?: string;
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
    'merged slides with deck_apply and accept again, or deck_preview_discard.',
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
          'applying reviewed choices to unseen content. Only meaningful with resolutions.'
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
