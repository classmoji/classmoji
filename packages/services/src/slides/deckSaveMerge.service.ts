/**
 * deckSaveMerge.service.ts — semantic 3-way merge for EDITOR saves
 * (content-tools plan §3b, Phase 7.5).
 *
 * When an editor save's conflict token is stale, the token IS the merge base:
 * it is deck.json's blob sha at the time the editor read the deck, and blob
 * shas are content-addressed (ContentService.getBlobContent — no ref needed).
 * Instead of refusing with "reload, discard your work", the save runs the
 * SAME 3-way semantic merge the preview-accept flow uses:
 *
 *   base   = the deck at the token's blob sha
 *   ours   = current main (fresh read)
 *   theirs = the POSTED document (the editor wrapper parsed + carried meta,
 *            constructed by the caller via slide.service buildEditorDeck)
 *
 * theirs is a BROWSER-serialized DOM read-back while base/ours come from
 * stored generator output, so the engine's equality is tolerant of pure
 * browser serialization (hex→rgb style rewrites, numeric noise, attr
 * requoting — see deckMerge/deckHtml). Slides the editor never touched merge
 * clean instead of raising phantom "edited in both versions" conflicts.
 *
 * Zero true collisions → the merged deck is committed through saveDeck (ONE
 * atomic CAS'd commit: deck.json + regenerated index.html) and the save
 * SUCCEEDS, reporting how many concurrent (main-side) changes were folded in.
 * Genuine same-unit collisions → a structured per-unit report the editor
 * renders in the existing conflict chooser; the client re-submits the same
 * posted content plus per-unit resolutions and the report's ours_sha pin.
 *
 * Fallbacks (throw DeckConflictError → the caller's plain 409 reload flow):
 * base blob unreadable/unparseable, main's deck.json deleted/unreadable, or
 * the CAS retry losing twice. Resolution-validation failures throw
 * PreviewResolutionError with the same codes as the accept flows.
 */

import { ContentService } from '../content/ContentService.ts';
import { canonicalJson } from '../content/merge3.ts';
import { SlideHtmlError, type DeckThemeUrls } from './deckHtml.ts';
import {
  indexResolutions,
  merge3Units,
  PreviewResolutionError,
  splitDeckConflicts,
  type DeckMergeConflict,
  type MergeResolution,
} from './deckMerge.ts';
import { applyDeckOps, DeckOpError, type DeckOp } from './deckOps.ts';
import {
  DeckConflictError,
  resolveSlideRepoContext,
  saveDeck,
  type SlideContentTarget,
} from './slideContent.service.ts';
import type { DeckJson } from './deckTypes.ts';

export interface SaveDeckMergeArgs {
  slide: SlideContentTarget;
  /** The document this save wants to write (posted wrapper + carried meta). */
  theirs: DeckJson;
  /** The editor's conflict token — deck.json's blob sha when the editor read it (the 3-way base). */
  baseSha: string;
  /** Chooser decisions from a prior conflict report (save re-submit). */
  resolutions?: MergeResolution[];
  /**
   * Pin to the conflict report the resolutions were reviewed against (its
   * `ours_sha`). When main's deck.json no longer matches, the save fails with
   * CONTENT_CONFLICT instead of applying reviewed choices to unseen content.
   */
  expectedOursSha?: string;
  message?: string;
  /** Resolver for shared:/custom: theme URLs, called with the MERGED deck. */
  resolveThemeUrls?: (deck: DeckJson) => Promise<DeckThemeUrls | undefined>;
}

export type SaveDeckMergeResult =
  | {
      merged: true;
      /** deck.json's new blob sha — the editor's fresh conflict token. */
      sha: string;
      commit: string;
      /** The regenerated index.html (the editor's savedContent CDN-lag workaround). */
      html: string;
      /** Unit-level changes (both sides) that merged without a conflict. */
      auto_merged: number;
      /** Concurrent (main-side) unit changes folded into this save — the toast count. */
      concurrent: number;
      /**
       * The client must remount its live editor from `html` (adopt the
       * committed document). True whenever the committed deck differs from the
       * client's intended document (base+ops) — concurrent reorders / cross-
       * stack moves / deck-meta changes fold in with `concurrent === 0` — OR
       * the server minted new insert ids the id-less DOM never carried. Gates
       * the remount on a FULL comparison, not the unit counter (mirrors the
       * pages twin's `document`-adoption rule).
       */
      adoption_required: boolean;
    }
  | {
      merged: false;
      conflict: true;
      /**
       * ONLY the true collisions: per-slide conflicts, per-stack child-order
       * sentinels (`__order__:<stackId>`), and `__meta__`.
       */
      units: DeckMergeConflict[];
      /** Present when both sides reordered the root slide sequence differently. */
      order_conflict?: { base: string[]; ours: string[]; theirs: string[] };
      auto_merged: number;
      /** Main's deck.json sha the report was built from — the resolution pin. */
      ours_sha: string;
    };

/** Strict deck.json parse — anything unusable is null (callers fall back). */
function parseDeckStrict(content: string): DeckJson | null {
  try {
    const parsed = JSON.parse(content) as DeckJson;
    if (parsed?.version === 1 && Array.isArray(parsed.slides)) return parsed;
  } catch {
    // Malformed — the caller falls back to the plain conflict flow.
  }
  return null;
}

type SlideRepoContext = ReturnType<typeof resolveSlideRepoContext>;
type OursRead = Awaited<ReturnType<typeof ContentService.getContent>>;

/**
 * Base = the deck at the editor's token (content-addressed blob read). A
 * failed or unparseable base read means no trustworthy 3-way exists — the
 * caller falls back to the plain conflict flow rather than merging against a
 * guessed base.
 */
async function readBaseDeck(ctx: SlideRepoContext, baseSha: string): Promise<DeckJson | null> {
  let baseFile: { content: string } | null = null;
  try {
    baseFile = await ContentService.getBlobContent({
      gitOrganization: ctx.gitOrganization,
      repo: ctx.repo,
      sha: baseSha,
    });
  } catch (error: unknown) {
    console.warn(
      `[deckSaveMerge] Base blob read failed for ${ctx.repo}@${baseSha}:`,
      error instanceof Error ? error.message : String(error)
    );
  }
  return baseFile ? parseDeckStrict(baseFile.content) : null;
}

/** Fresh-main deck.json read. skipCache REQUIRED — this read pins the CAS sha. */
function readOursDeckFile(ctx: SlideRepoContext, deckPath: string): Promise<OursRead> {
  return ContentService.getContent({
    gitOrganization: ctx.gitOrganization,
    repo: ctx.repo,
    path: deckPath,
    skipCache: true,
  });
}

interface RunDeckMergeSaveArgs {
  slide: SlideContentTarget;
  deckPath: string;
  ctx: SlideRepoContext;
  baseDeck: DeckJson;
  theirs: DeckJson;
  chosen: ReturnType<typeof indexResolutions> | null;
  expectedOursSha?: string;
  message?: string;
  resolveThemeUrls?: (deck: DeckJson) => Promise<DeckThemeUrls | undefined>;
  /** Attempt-0 read of main's deck.json (prefetched in parallel with the base). */
  firstOurs: OursRead;
  /**
   * The server minted new slide ids while materializing `theirs` (an insert
   * op). Those ids never appear in the editor's id-less DOM, so the client
   * MUST adopt the committed document even when the canonical compare matches
   * (base == ours). Mirrors the pages twin forcing adoption on any re-mint.
   */
  forceAdoption?: boolean;
}

/** Compact human summary of applied chooser choices, appended to a merge commit. */
function resolutionSummary(chosen: ReturnType<typeof indexResolutions>): string {
  const count = Object.keys(chosen).length;
  if (count === 0) return '';
  return ` — resolved ${count} conflict${count === 1 ? '' : 's'}`;
}

/**
 * Save an editor's posted deck over a stale conflict token by 3-way semantic
 * merge (see the module doc for the full contract).
 *
 * @throws {DeckConflictError} fallback to the plain 409 reload flow (base
 *   unreadable, main's deck.json gone, or the CAS retry lost twice).
 * @throws {PreviewResolutionError} CONTENT_CONFLICT (ours pin stale) /
 *   NOTHING_TO_RESOLVE / UNRESOLVED_CONFLICTS / UNKNOWN_RESOLUTIONS /
 *   DUPLICATE_RESOLUTIONS / INVALID_RESOLUTIONS.
 */
export async function saveDeckWithMerge({
  slide,
  theirs,
  baseSha,
  resolutions,
  expectedOursSha,
  message,
  resolveThemeUrls,
}: SaveDeckMergeArgs): Promise<SaveDeckMergeResult> {
  const ctx = resolveSlideRepoContext(slide);
  const deckPath = `${slide.content_path}/deck.json`;

  // The base blob and the first fresh-main read are independent GitHub
  // round-trips — fetched in parallel (save-latency win).
  const [baseDeck, firstOurs] = await Promise.all([
    readBaseDeck(ctx, baseSha),
    readOursDeckFile(ctx, deckPath),
  ]);
  if (!baseDeck) {
    throw new DeckConflictError('Deck changed since it was read — re-read before saving');
  }

  const chosen = resolutions ? indexResolutions(resolutions) : null;
  return runDeckMergeSave({
    slide,
    deckPath,
    ctx,
    baseDeck,
    theirs,
    chosen,
    expectedOursSha,
    message,
    resolveThemeUrls,
    firstOurs,
  });
}

/**
 * The shared merge→commit loop: 3-way merge against fresh main, resolution
 * validation, conflict reporting, and the CAS'd saveDeck commit with ONE
 * retry on a mid-commit race. `firstOurs` (prefetched by the entry points)
 * serves attempt 0; a retry re-reads main.
 */
async function runDeckMergeSave({
  slide,
  deckPath,
  ctx,
  baseDeck,
  theirs,
  chosen,
  expectedOursSha,
  message,
  resolveThemeUrls,
  firstOurs,
  forceAdoption,
}: RunDeckMergeSaveArgs): Promise<SaveDeckMergeResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // Ours = fresh main (attempt 0 uses the prefetched parallel read).
    const ours = attempt === 0 ? firstOurs : await readOursDeckFile(ctx, deckPath);

    // Re-checked every attempt: a CAS-loss retry re-reads main, and choices
    // reviewed against one report must not silently apply to newer content.
    if (expectedOursSha && (ours?.sha ?? null) !== expectedOursSha) {
      throw new PreviewResolutionError(
        'The deck changed since the conflict report these choices were made against — ' +
          'save again for a fresh report',
        'CONTENT_CONFLICT'
      );
    }

    const oursDeck = ours ? parseDeckStrict(ours.content) : null;
    if (!ours || !oursDeck) {
      // deck.json deleted or unreadable on main: no CAS anchor, no 3-way.
      throw new DeckConflictError('deck.json no longer exists — re-read the deck before saving');
    }

    if (chosen) {
      // The resolutions must exactly cover the CURRENT conflict set (same
      // validation as resolveDeckPreviewConflicts).
      const current = merge3Units(baseDeck, oursDeck, theirs);
      const conflictIds = new Set(current.conflicts.map(conflict => conflict.id));
      if (conflictIds.size === 0) {
        throw new PreviewResolutionError(
          'Nothing to resolve — the save now merges cleanly; save again without resolutions',
          'NOTHING_TO_RESOLVE'
        );
      }
      const missing = [...conflictIds].filter(id => !(id in chosen));
      if (missing.length > 0) {
        throw new PreviewResolutionError(
          `Every conflict needs a choice — missing: ${missing.join(', ')}`,
          'UNRESOLVED_CONFLICTS',
          missing
        );
      }
      const unknown = Object.keys(chosen).filter(id => !conflictIds.has(id));
      if (unknown.length > 0) {
        throw new PreviewResolutionError(
          `Not current conflict ids: ${unknown.join(', ')} — save again for the current report`,
          'UNKNOWN_RESOLUTIONS',
          unknown
        );
      }
    }

    const merge = merge3Units(baseDeck, oursDeck, theirs, chosen ? { resolutions: chosen } : {});
    if (merge.conflicts.length > 0) {
      if (chosen) {
        throw new Error(
          `Resolution pass left conflicts standing (${merge.conflicts.map(c => c.id).join(', ')}) — this is a bug`
        );
      }
      const { units, orderConflict } = splitDeckConflicts(merge.conflicts);
      return {
        merged: false,
        conflict: true,
        units,
        ...(orderConflict ? { order_conflict: orderConflict } : {}),
        auto_merged: merge.autoMerged,
        ours_sha: ours.sha,
      };
    }

    // Concurrent (main-side) changes folded into this save: a theirs-less
    // merge (theirs = base) counts exactly the units ours changed vs base.
    const concurrent = merge3Units(baseDeck, oursDeck, baseDeck).autoMerged;

    // Adoption signal (the client's remount gate): the committed document must
    // replace whatever the editor DOM holds whenever it differs from the
    // client's intended document (theirs = base+ops) — NOT merely when the
    // `concurrent` unit-content counter is nonzero. A main-side reorder, a
    // cross-stack move, or a deck-meta change folds in with concurrent 0, and
    // server-minted insert ids (forceAdoption) never appear in the id-less DOM
    // at all. A FULL canonical compare (order, children placement, meta, ids)
    // catches every one; the counter stays only for the toast.
    const adoptionRequired =
      forceAdoption === true || canonicalJson(merge.merged) !== canonicalJson(theirs);

    // Commit message: mark the git record when this save actually folded a
    // concurrent change or applied a chooser resolution (the routes no longer
    // override the default, so a plain save stays 'Update slides: <title>').
    const commitMessage =
      message ??
      (chosen
        ? `Update slides (merged): ${slide.title}${resolutionSummary(chosen)}`
        : concurrent > 0
          ? `Update slides (merged): ${slide.title}`
          : `Update slides: ${slide.title}`);

    const themeUrls = await resolveThemeUrls?.(merge.merged);
    try {
      const saved = await saveDeck({
        slide,
        deck: merge.merged,
        expectedSha: ours.sha,
        shaSource: 'deck',
        message: commitMessage,
        ...(themeUrls ? { themeUrls } : {}),
      });
      return {
        merged: true,
        sha: saved.sha,
        commit: saved.commit,
        html: saved.html,
        auto_merged: merge.autoMerged,
        concurrent,
        adoption_required: adoptionRequired,
      };
    } catch (error: unknown) {
      if (!(error instanceof DeckConflictError) || attempt === 1) throw error;
      // Main moved mid-commit — one retry re-runs the 3-way against fresh ours.
    }
  }
  /* c8 ignore next */
  throw new Error('unreachable');
}

// ─────────────────────────────────────────────────────────────────────────────
// saveDeckFromOps — the editor's ops-shaped save (diff-at-save client)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 409 — the posted ops do not apply to the deck at the base token (an unknown
 * slide id, an insert/move anchor that does not exist in the base — e.g. the
 * anchor slide was never in that base — or an op the engine refuses). The
 * client's contract: fall back to the whole-document 7.5 save ONCE; nothing
 * was written.
 */
export class DeckOpsBaseMismatchError extends Error {
  status = 409 as const;
  code = 'OPS_BASE_MISMATCH' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeckOpsBaseMismatchError';
  }
}

export interface SaveDeckFromOpsArgs {
  slide: SlideContentTarget;
  /** Granular ops the editor derived by diffing its DOM against its base snapshot. */
  ops: DeckOp[];
  /** The editor's conflict token — deck.json's blob sha the ops were diffed against. */
  baseSha: string;
  /** Chooser decisions from a prior conflict report (save re-submit with the SAME ops). */
  resolutions?: MergeResolution[];
  /** Pin to the conflict report the resolutions were reviewed against (its `ours_sha`). */
  expectedOursSha?: string;
  message?: string;
  /** Resolver for shared:/custom: theme URLs, called with the MERGED deck. */
  resolveThemeUrls?: (deck: DeckJson) => Promise<DeckThemeUrls | undefined>;
}

/**
 * Save an editor's OPS over its base token: `theirs = applyDeckOps(base, ops)`
 * — op ids and anchors resolve against the BASE deck — then the exact same
 * 3-way merge → clean commit / conflict report / resolutions flow as
 * saveDeckWithMerge. Untouched slides never ride in the request, so they can
 * never phantom-conflict: a concurrent save to OTHER slides auto-merges by
 * construction, with no equality tolerance involved.
 *
 * Op html/notes route through the same normalizeSlideHtml canonicalization
 * the MCP deck_apply path uses (inside applyDeckOps), so ops-built documents
 * match editor whole-document saves byte-for-byte.
 *
 * @throws {DeckOpsBaseMismatchError} the ops don't apply to the base (unknown
 *   id/anchor, engine-refused op) — the client falls back to the whole-doc save.
 * @throws {DeckConflictError} fallback to the plain 409 reload flow (base
 *   blob unreadable/unparseable, main's deck.json gone, CAS retry lost twice).
 * @throws {PreviewResolutionError} same codes as saveDeckWithMerge.
 */
export async function saveDeckFromOps({
  slide,
  ops,
  baseSha,
  resolutions,
  expectedOursSha,
  message,
  resolveThemeUrls,
}: SaveDeckFromOpsArgs): Promise<SaveDeckMergeResult> {
  const ctx = resolveSlideRepoContext(slide);
  const deckPath = `${slide.content_path}/deck.json`;

  // Same parallel reads as saveDeckWithMerge (base blob + first fresh main).
  const [baseDeck, firstOurs] = await Promise.all([
    readBaseDeck(ctx, baseSha),
    readOursDeckFile(ctx, deckPath),
  ]);
  if (!baseDeck) {
    throw new DeckConflictError('Deck changed since it was read — re-read before saving');
  }

  // Materialize theirs by replaying the ops on the base. Anything the engine
  // cannot resolve against THIS base (unknown ids, missing anchors, refused
  // ops) is a base mismatch — the client retries as a whole-document save.
  // NOTE: editor diffs never emit set_theme (theme changes take the whole-doc
  // path, which owns the buildEditorDeck merge rules), so no starterCustomCss
  // option is passed here.
  let theirs: DeckJson;
  // Any insert op mints fresh server-side ids the editor's DOM never carried
  // (SlideToolbar.createNewSlide emits id-less <section>s); the client must
  // then adopt the committed document or its next diff re-deletes+re-inserts
  // the slide, churning the id and manufacturing bogus delete_vs_edit
  // conflicts. Count the mints so runDeckMergeSave can force adoption.
  let mintedIds = 0;
  try {
    const result = applyDeckOps(baseDeck, ops);
    theirs = result.deck;
    mintedIds = result.applied.reduce(
      (n, entry) =>
        entry.op === 'insert' ? n + ((entry.ids as string[] | undefined)?.length ?? 0) : n,
      0
    );
  } catch (error: unknown) {
    if (error instanceof DeckOpError || error instanceof SlideHtmlError) {
      throw new DeckOpsBaseMismatchError(`Ops do not apply to the base deck: ${error.message}`);
    }
    throw error;
  }

  const chosen = resolutions ? indexResolutions(resolutions) : null;
  return runDeckMergeSave({
    slide,
    deckPath,
    ctx,
    baseDeck,
    theirs,
    chosen,
    expectedOursSha,
    message,
    resolveThemeUrls,
    firstOurs,
    forceAdoption: mintedIds > 0,
  });
}
