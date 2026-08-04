/**
 * deckPreview.service.ts — deck preview-branch lifecycle (content-tools plan §3b).
 *
 * Mirrors the pages preview helpers (pageContent.service) for slide decks.
 * One singleton preview branch per deck, named `preview/<content_path>`.
 * Preview branches carry SOURCE FILES ONLY (deck.json — never index.html):
 * saveDeck enforces that on write, and accept regenerates the artifact.
 *
 * Accept = GitHub merge (main ← preview) → on a clean merge, regenerate
 * index.html on main FROM THE MERGED deck.json (CAS'd on its sha via
 * uploadBatch verifyBaseTree) → delete the branch. On a git-level conflict,
 * the semantic 3-way merge takes over (merge3Units: base = merge-base,
 * ours = main, theirs = preview): zero true collisions → the auto-merged deck
 * is committed to main via saveDeck and the branch deleted; genuine
 * collisions → structured per-unit report (branch kept) that the caller
 * resolves via resolveDeckPreviewConflicts or by re-applying.
 *
 * Discard = delete the branch; main untouched.
 */

import getPrisma from '@classmoji/database';
import { ContentService } from '../content/ContentService.ts';
import { generateDeckHtml, type DeckThemeUrls } from './deckHtml.ts';
import {
  indexResolutions,
  merge3Units,
  PreviewResolutionError,
  splitDeckConflicts,
  type DeckMergeConflict,
  type MergeResolution,
} from './deckMerge.ts';
import {
  DeckConflictError,
  previewBranchName,
  resolveSlideRepoContext,
  saveDeck,
  type SlideContentTarget,
} from './slideContent.service.ts';
import type { DeckJson } from './deckTypes.ts';

const THEMES_FOLDER = '.slidesthemes';

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

export interface DeckPreviewStatus {
  exists: boolean;
  /** Commits the preview branch has that main lacks (present iff exists). */
  commits_ahead?: number;
  /** Committer date (ISO) of the oldest preview-only commit — the preview's age. */
  oldest_commit_at?: string;
}

/**
 * Report whether the deck's preview branch exists and how far ahead of main
 * it is. A 404 from the compare (branch absent) → `{ exists: false }`.
 */
export async function getDeckPreviewStatus(slide: SlideContentTarget): Promise<DeckPreviewStatus> {
  const { gitOrganization, repo } = resolveSlideRepoContext(slide);
  const comparison = await ContentService.compareBranches({
    gitOrganization,
    repo,
    base: 'main',
    head: previewBranchName(slide.content_path),
  });
  if (!comparison) {
    return { exists: false };
  }
  const oldest = comparison.commits[0]?.date;
  return {
    exists: true,
    commits_ahead: comparison.ahead_by,
    ...(oldest ? { oldest_commit_at: oldest } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Create / extend
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure the deck's preview branch exists, creating it from main's current
 * HEAD when absent. Existing branches are left untouched (stacking — a
 * multi-step agent session accumulates commits on one preview).
 *
 * Main's HEAD sha comes from comparing main against itself (the compare
 * payload's base commit), avoiding a separate refs read.
 */
export async function ensureDeckPreviewBranch(
  slide: SlideContentTarget
): Promise<{ branch: string; created: boolean }> {
  const { gitOrganization, repo } = resolveSlideRepoContext(slide);
  const branch = previewBranchName(slide.content_path);

  const existing = await ContentService.compareBranches({
    gitOrganization,
    repo,
    base: 'main',
    head: branch,
  });
  if (existing) {
    return { branch, created: false };
  }

  const main = await ContentService.compareBranches({
    gitOrganization,
    repo,
    base: 'main',
    head: 'main',
  });
  if (!main) {
    throw new Error(`Cannot resolve main HEAD for ${repo} — repository has no main branch?`);
  }

  try {
    await ContentService.createBranch({ gitOrganization, repo, branch, fromSha: main.base_sha });
  } catch (error: unknown) {
    // Creation race: a concurrent apply created the branch between our probe
    // and this call. GitHub answers 422 "Reference already exists" — treat as
    // exists (the stacking semantics the probe would have chosen).
    const { status, message } = error as { status?: number; message?: string };
    if (status === 422 && message?.includes('already exists')) {
      return { branch, created: false };
    }
    throw error;
  }
  return { branch, created: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Accept
// ─────────────────────────────────────────────────────────────────────────────

export type AcceptDeckPreviewResult =
  | {
      merged: true;
      /** Merged deck.json's blob sha on main — the fresh expected_sha for future applies (null when unreadable). */
      sha: string | null;
      /** false when regeneration was skipped (concurrent writer already regenerated, or merged deck unreadable). */
      html_regenerated: boolean;
      /** Present when the git merge conflicted but the semantic 3-way auto-merge committed the result. */
      semantic?: true;
      /** Changes auto-merged by the semantic layer (present iff semantic). */
      auto_merged?: number;
      /** true when a concurrent stacking apply landed after the merge snapshot — the branch was kept, not deleted. */
      preview_kept?: boolean;
      /** Why the preview branch was retained (present iff preview_kept). */
      reason?: string;
    }
  | {
      merged: false;
      conflict: true;
      /**
       * ONLY the true collisions (everything else auto-merges on accept):
       * per-slide conflicts, per-stack child-order conflicts
       * (`__order__:<stackId>`), and the `__meta__` sentinel.
       */
      units: DeckMergeConflict[];
      /** Present when both sides reordered the root slide sequence differently (conflict id `__order__`). */
      order_conflict?: { base: string[]; ours: string[]; theirs: string[] };
      /** Changes the semantic layer can merge without a decision. */
      auto_merged: number;
      ours_sha: string | null;
      theirs_sha: string | null;
    };

/** Result of resolveDeckPreviewConflicts: the resolved merge committed to main. */
export interface ResolveDeckPreviewResult {
  merged: true;
  semantic: true;
  /** The new deck.json blob sha on main — the fresh expected_sha. */
  sha: string | null;
  html_regenerated: true;
  auto_merged: number;
  /** The applied choices, echoed for auditing. */
  resolved: MergeResolution[];
  preview_kept?: boolean;
  reason?: string;
}

/** Parse a deck.json body into a DeckJson; malformed/missing → empty deck (diff-only use). */
function parseDeckForDiff(content: string | null | undefined): DeckJson {
  const empty: DeckJson = { version: 1, theme: 'white', codeTheme: 'github', slides: [] };
  if (!content) return empty;
  try {
    const parsed = JSON.parse(content) as DeckJson;
    if (parsed?.version === 1 && Array.isArray(parsed.slides)) return parsed;
  } catch {
    // Malformed JSON — treat as empty for diff purposes
  }
  return empty;
}

/**
 * STRICT parse for the merge BASE: null when the deck.json is missing or
 * unparseable. Unlike parseDeckForDiff, the base is NEVER degraded to an empty
 * deck — see baseDeckUnavailable for why.
 */
function parseBaseDeckStrict(content: string | null | undefined): DeckJson | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as DeckJson;
    if (parsed?.version === 1 && Array.isArray(parsed.slides)) return parsed;
  } catch {
    // Malformed — reported as unavailable by the caller.
  }
  return null;
}

/**
 * Accept the deck's preview: merge the preview branch into main via the
 * GitHub merge API, regenerate the index.html artifact on main from the
 * MERGED deck.json, then delete the branch — unless a concurrent stacking
 * apply landed on the branch after the merge snapshot, in which case the
 * branch is KEPT (deleting it would discard the newer edits) and the result
 * carries `preview_kept: true` with a reason.
 *
 * Regeneration mechanics (§3b): the merged deck.json is read from main with
 * skipCache, rendered via generateDeckHtml (theme URLs come from the caller's
 * `resolveThemeUrls` — the service never resolves themes itself), and written
 * as a single-file uploadBatch whose verifyBaseTree hook pins deck.json's
 * merged sha — a concurrent saveDeck between merge and regenerate surfaces as
 * a conflict instead of clobbering, and since that concurrent save already
 * regenerated the artifact itself, the accept simply skips regeneration.
 *
 * On a git-level conflict, the semantic 3-way merge (merge3Units) takes over:
 * zero true collisions → the auto-merged deck is committed to main and the
 * branch deleted (result carries `semantic: true`); genuine collisions →
 * structured per-unit report (branch kept) with ONLY the units needing a
 * decision plus the auto_merged count.
 */
export async function acceptDeckPreview(
  slide: SlideContentTarget,
  {
    resolveThemeUrls,
  }: {
    /** Resolver for shared:/custom: theme URLs, called with the MERGED deck. */
    resolveThemeUrls?: (deck: DeckJson) => Promise<DeckThemeUrls | undefined>;
  } = {}
): Promise<AcceptDeckPreviewResult> {
  const { gitOrganization, repo } = resolveSlideRepoContext(slide);
  const branch = previewBranchName(slide.content_path);
  const deckPath = `${slide.content_path}/deck.json`;
  const htmlPath = `${slide.content_path}/index.html`;

  const result = await ContentService.mergeBranch({
    gitOrganization,
    repo,
    base: 'main',
    head: branch,
    message: `Accept slides preview: ${slide.title}`,
  });

  if (!result.merged) {
    // Git-level conflict: run the semantic 3-way merge (Phase 7). Zero true
    // collisions → the auto-merged deck is committed to main (saveDeck: CAS'd
    // on main's pre-write deck.json sha, artifact regenerated in the same
    // atomic batch) and the branch is deleted; genuine collisions →
    // structured report with only the units that need a decision, branch kept.
    return acceptDeckSemanticFallback(slide, resolveThemeUrls);
  }

  // Clean merge: regenerate the artifact on main from the merged deck.json.
  // The deck is read at the MERGE COMMIT sha when available — a deterministic
  // ref immune to GitHub's eventually-consistent branch reads (a plain main
  // read, even with skipCache, can serve a pre-merge deck right after the
  // merge). 204 no-op merges have no merge commit; fall back to a fresh main
  // read (skipCache REQUIRED — the read pins the CAS sha).
  const readDeckFile = (ref?: string) =>
    ContentService.getContent({
      gitOrganization,
      repo,
      path: deckPath,
      ...(ref ? { ref } : { skipCache: true }),
    });

  const parseDeck = (content: string): DeckJson | null => {
    try {
      const parsed = JSON.parse(content) as DeckJson;
      if (parsed?.version === 1 && Array.isArray(parsed.slides)) return parsed;
    } catch {
      // Malformed — reported by the caller.
    }
    return null;
  };

  // Render + commit the artifact, CAS-pinned on the deck.json sha it was
  // generated from: if a concurrent save moves deck.json, the write aborts
  // (DeckConflictError) instead of publishing a stale artifact.
  const regenerateFrom = async (deck: DeckJson, pinnedSha: string): Promise<void> => {
    const themeUrls = await resolveThemeUrls?.(deck);
    const html = generateDeckHtml(deck, {
      title: slide.title,
      themeUrls,
      includeNotes: true,
    });
    await ContentService.uploadBatch({
      gitOrganization,
      repo,
      files: [{ path: htmlPath, content: html, encoding: 'utf-8' as const }],
      branch: 'main',
      message: `Regenerate slides artifact: ${slide.title}`,
      verifyBaseTree: async ({ getFileSha }) => {
        const current = await getFileSha(deckPath);
        if (current !== pinnedSha) {
          throw new DeckConflictError(
            'deck.json changed while regenerating the artifact — the artifact must be generated from the current deck'
          );
        }
      },
    });
  };

  let mergedSha: string | null = null;
  let htmlRegenerated = false;
  const mergedFile = await readDeckFile(result.sha);
  if (mergedFile) {
    mergedSha = mergedFile.sha;
    const deck = parseDeck(mergedFile.content);
    if (deck) {
      try {
        await regenerateFrom(deck, mergedFile.sha);
        htmlRegenerated = true;
      } catch (error: unknown) {
        if (!(error instanceof DeckConflictError)) throw error;
        // A concurrent writer moved deck.json between the merge and this
        // regenerate. Retry ONCE against fresh main (regenerating from the
        // fresh deck is idempotent even if that writer already regenerated);
        // a second conflict means writes are actively racing — skip, the last
        // writer's own save regenerates.
        console.warn(`[deckPreview] ${error.message} — retrying against fresh main`);
        try {
          const freshFile = await readDeckFile();
          const freshDeck = freshFile ? parseDeck(freshFile.content) : null;
          if (freshFile && freshDeck) {
            await regenerateFrom(freshDeck, freshFile.sha);
            mergedSha = freshFile.sha;
            htmlRegenerated = true;
          } else {
            console.error(
              `[deckPreview] Fresh deck.json at ${deckPath} is unreadable on retry — artifact NOT regenerated`
            );
          }
        } catch (retryError: unknown) {
          if (!(retryError instanceof DeckConflictError)) throw retryError;
          console.warn(
            `[deckPreview] ${retryError.message} — skipping regeneration (the concurrent save regenerated it)`
          );
        }
      }
    } else {
      console.error(
        `[deckPreview] Merged deck.json at ${deckPath} is unreadable — artifact NOT regenerated`
      );
    }
  } else {
    // Preview never wrote deck.json (nothing but the branch point) — the
    // merge was a no-op for content; there is nothing to regenerate.
    console.warn(`[deckPreview] No deck.json on main after merge for ${deckPath}`);
  }

  // Concurrent-stacking guard: a stacking apply may have committed to the
  // preview branch AFTER the merge snapshot GitHub used. If the branch now has
  // commits main lacks, deleting it would silently discard those edits — keep
  // the branch and report it. (A compare failure also keeps the branch:
  // stranding a preview is recoverable, deleting fresh commits is not.)
  let previewKept = false;
  let keptReason: string | undefined;
  try {
    const after = await ContentService.compareBranches({
      gitOrganization,
      repo,
      base: 'main',
      head: branch,
    });
    if (after && after.ahead_by > 0) {
      previewKept = true;
      keptReason = `Preview branch gained ${after.ahead_by} new commit(s) during accept — retained with the newer edits`;
    } else if (after) {
      await ContentService.deleteBranch({ gitOrganization, repo, branch });
    }
    // after === null → branch already gone (concurrent discard) — nothing to delete.
  } catch (error: unknown) {
    previewKept = true;
    keptReason = 'Could not verify the preview branch was fully merged — retained for safety';
    console.warn(
      `[deckPreview] Post-merge branch check failed for ${repo}/${branch}:`,
      error instanceof Error ? error.message : String(error)
    );
  }

  // The accept published changes to main — bump updated_at like saveDeck does.
  if (slide.id) {
    try {
      await getPrisma().slide.update({
        where: { id: slide.id },
        data: { updated_at: new Date() },
      });
    } catch (error: unknown) {
      console.error('[deckPreview] Failed to bump slide.updated_at after accept:', error);
    }
  }

  return {
    merged: true,
    sha: mergedSha,
    html_regenerated: htmlRegenerated,
    ...(previewKept ? { preview_kept: true, reason: keptReason } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Semantic merge on accept (Phase 7)
// ─────────────────────────────────────────────────────────────────────────────

type ThemeUrlResolver = (deck: DeckJson) => Promise<DeckThemeUrls | undefined>;
type ContentRead = Awaited<ReturnType<typeof ContentService.getContent>>;

interface DeckThreeWay {
  comparison: Awaited<ReturnType<typeof ContentService.compareBranches>>;
  ours: ContentRead;
  theirs: ContentRead;
  base: ContentRead;
}

/** Read the 3-way (ours = fresh main, theirs = the preview branch, base = merge-base). */
async function readDeckThreeWay(slide: SlideContentTarget): Promise<DeckThreeWay> {
  const { gitOrganization, repo } = resolveSlideRepoContext(slide);
  const branch = previewBranchName(slide.content_path);
  const deckPath = `${slide.content_path}/deck.json`;

  const comparison = await ContentService.compareBranches({
    gitOrganization,
    repo,
    base: 'main',
    head: branch,
  });
  const [ours, theirs, base] = await Promise.all([
    ContentService.getContent({ gitOrganization, repo, path: deckPath, skipCache: true }),
    ContentService.getContent({ gitOrganization, repo, path: deckPath, ref: branch }),
    comparison?.merge_base_sha
      ? ContentService.getContent({
          gitOrganization,
          repo,
          path: deckPath,
          ref: comparison.merge_base_sha,
        })
      : Promise.resolve(null),
  ]);
  return { comparison, ours, theirs, base };
}

/**
 * Commit a semantically merged deck to main via saveDeck (ONE atomic commit:
 * deck.json + regenerated index.html, CAS'd on main's pre-write deck.json sha
 * through both the pre-check and the verifyBaseTree hook), then delete the
 * preview branch — unless the branch's deck.json moved past the `theirs` we
 * merged (a concurrent stacking apply), in which case it is kept. Note:
 * `compareBranches.ahead_by` cannot make that call here — the semantic commit
 * is a NEW commit on main, so the branch's commits are never git-ancestors;
 * the branch's blob sha vs the merged theirs sha is the reliable signal.
 */
async function commitSemanticDeckMerge(
  slide: SlideContentTarget,
  deck: DeckJson,
  {
    oursSha,
    theirsSha,
    resolveThemeUrls,
  }: { oursSha: string; theirsSha: string | null; resolveThemeUrls?: ThemeUrlResolver }
): Promise<{ sha: string; preview_kept?: boolean; reason?: string }> {
  const { gitOrganization, repo } = resolveSlideRepoContext(slide);
  const branch = previewBranchName(slide.content_path);
  const deckPath = `${slide.content_path}/deck.json`;

  const themeUrls = await resolveThemeUrls?.(deck);
  const saved = await saveDeck({
    slide,
    deck,
    expectedSha: oursSha,
    shaSource: 'deck',
    message: `Accept slides preview (auto-merged): ${slide.title}`,
    ...(themeUrls ? { themeUrls } : {}),
  });

  // TOCTOU note: this guard is a compare-THEN-delete — a stacking apply can
  // still land on the branch between the getMeta read and the deleteBranch
  // call below, and would be discarded with the branch. Accepted: GitHub's
  // refs DELETE has no precondition (no CAS delete), so the window cannot be
  // closed API-side; the guard shrinks it from the whole merge duration to
  // one request round-trip, and an apply racing an in-flight accept has no
  // ordering guarantee either way.
  let previewKept = false;
  let reason: string | undefined;
  try {
    const branchMeta = await ContentService.getMeta({
      gitOrganization,
      repo,
      path: deckPath,
      ref: branch,
      skipCache: true,
    });
    if (branchMeta && theirsSha && branchMeta.sha !== theirsSha) {
      previewKept = true;
      reason = 'Preview branch gained new edits during accept — retained with the newer changes';
    } else {
      try {
        await ContentService.deleteBranch({ gitOrganization, repo, branch });
      } catch (error: unknown) {
        const status = (error as { status?: number }).status;
        if (status !== 404 && status !== 422) throw error; // already gone is fine
      }
    }
  } catch (error: unknown) {
    previewKept = true;
    reason = 'Could not verify the preview branch was unchanged — retained for safety';
    console.warn(
      `[deckPreview] Post-merge branch check failed for ${repo}/${branch}:`,
      error instanceof Error ? error.message : String(error)
    );
  }

  return { sha: saved.sha, ...(previewKept ? { preview_kept: true, reason } : {}) };
}

/**
 * Typed refusal for the main-file-deleted degenerate: without main's
 * deck.json there is no sha to CAS the commit on, so committing would be an
 * unguarded write over whatever deleted it.
 */
function mainDeckMissing(): PreviewResolutionError {
  return new PreviewResolutionError(
    "Main's deck.json was deleted while this preview was pending — discard the preview " +
      'or re-apply it as a fresh deck',
    'MAIN_CONTENT_MISSING'
  );
}

/**
 * Typed refusal for a missing/unparseable merge BASE. Preview branches always
 * fork from main, so a git-conflicting accept has a real merge base with a
 * real deck.json — if that read is empty or malformed, degrading it to an
 * empty deck would treat every slide as "added on both sides": the preview's
 * deletions get resurrected and legacy add/add decks (both sides materialized
 * deck.json after the fork point) duplicate wholesale. There is no trustworthy
 * 3-way, so refuse rather than commit — mirroring the 7.5 editor-save
 * readBaseDeck refusal. Reuses MAIN_CONTENT_MISSING (the existing "content the
 * merge needs is gone → re-apply or discard" code); no new code is invented.
 */
function baseDeckUnavailable(): PreviewResolutionError {
  return new PreviewResolutionError(
    'The merge base is unavailable (deck.json was missing or unreadable at the fork point) — ' +
      're-apply your changes onto the current deck or discard the preview',
    'MAIN_CONTENT_MISSING'
  );
}

/** The accept path taken when the git merge reports a conflict. */
async function acceptDeckSemanticFallback(
  slide: SlideContentTarget,
  resolveThemeUrls?: ThemeUrlResolver
): Promise<AcceptDeckPreviewResult> {
  const threeWay = await readDeckThreeWay(slide);
  const { theirs, base } = threeWay;
  let ours = threeWay.ours;
  // A trustworthy 3-way needs a real merge base — never degrade a missing or
  // unparseable base to an empty deck and commit (S3).
  const baseDeck = parseBaseDeckStrict(base?.content);
  if (!baseDeck) throw baseDeckUnavailable();
  const theirsDeck = parseDeckForDiff(theirs?.content);

  const report = (merge: ReturnType<typeof merge3Units>): AcceptDeckPreviewResult => {
    const { units, orderConflict } = splitDeckConflicts(merge.conflicts);
    return {
      merged: false,
      conflict: true,
      units,
      ...(orderConflict ? { order_conflict: orderConflict } : {}),
      auto_merged: merge.autoMerged,
      ours_sha: ours?.sha ?? null,
      theirs_sha: theirs?.sha ?? null,
    };
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    // Main's deck.json vanished (deleted while the preview was pending):
    // never commit without a CAS precondition, and never return an empty
    // conflict report the caller cannot act on — refuse with a typed error.
    if (!ours?.sha) throw mainDeckMissing();

    const merge = merge3Units(baseDeck, parseDeckForDiff(ours.content), theirsDeck);
    if (merge.conflicts.length > 0) {
      return report(merge);
    }
    try {
      const committed = await commitSemanticDeckMerge(slide, merge.merged, {
        oursSha: ours.sha,
        theirsSha: theirs?.sha ?? null,
        resolveThemeUrls,
      });
      return {
        merged: true,
        semantic: true,
        html_regenerated: true,
        auto_merged: merge.autoMerged,
        ...committed,
      };
    } catch (error: unknown) {
      if (!(error instanceof DeckConflictError) || attempt === 1) throw error;
      // Main moved while we were auto-merging — one retry against fresh main.
      const { gitOrganization, repo } = resolveSlideRepoContext(slide);
      ours = await ContentService.getContent({
        gitOrganization,
        repo,
        path: `${slide.content_path}/deck.json`,
        skipCache: true,
      });
    }
  }
  /* c8 ignore next */
  throw new Error('unreachable');
}

/**
 * Apply chooser decisions to a conflicted deck accept: re-runs the 3-way
 * merge, requires the resolutions to exactly cover the current conflict set
 * (`ours` = keep main's version, `theirs` = keep the preview's; sentinels:
 * `__order__` for the top-level order, `__order__:<stackId>` for a stack's
 * child order, `__meta__` for deck-level theme/config collisions), commits
 * the resolved merge to main exactly like a semantic accept (saveDeck: CAS +
 * artifact regeneration), and deletes the branch.
 *
 * @param options.expectedOursSha - pin the resolution to the conflict report
 *   the choices were made against (the report's `ours_sha`). When provided
 *   and main's deck.json no longer matches, the resolve fails with
 *   CONTENT_CONFLICT instead of applying reviewed choices to unseen content.
 * @param options.expectedTheirsSha - same pin for the preview side
 *   (the report's `theirs_sha`).
 *
 * @throws {PreviewResolutionError} NO_PREVIEW / NOTHING_TO_RESOLVE /
 *   UNRESOLVED_CONFLICTS / UNKNOWN_RESOLUTIONS / DUPLICATE_RESOLUTIONS /
 *   INVALID_RESOLUTIONS / CONTENT_CONFLICT / MAIN_CONTENT_MISSING.
 */
export async function resolveDeckPreviewConflicts(
  slide: SlideContentTarget,
  {
    resolutions,
    resolveThemeUrls,
    expectedOursSha,
    expectedTheirsSha,
  }: {
    resolutions: MergeResolution[];
    resolveThemeUrls?: ThemeUrlResolver;
    expectedOursSha?: string;
    expectedTheirsSha?: string;
  }
): Promise<ResolveDeckPreviewResult> {
  if (!resolutions?.length) {
    throw new PreviewResolutionError(
      'No resolutions supplied — pass one {id, choose} per conflict',
      'UNRESOLVED_CONFLICTS'
    );
  }
  const chosen = indexResolutions(resolutions);

  const threeWay = await readDeckThreeWay(slide);
  if (!threeWay.comparison) {
    throw new PreviewResolutionError(
      'No pending preview for this deck — nothing to resolve',
      'NO_PREVIEW'
    );
  }
  const { theirs, base } = threeWay;
  let ours = threeWay.ours;
  // Same base-availability guard as the accept path (S3): no trustworthy 3-way
  // without a real merge base — refuse instead of resolving against an empty one.
  const baseDeck = parseBaseDeckStrict(base?.content);
  if (!baseDeck) throw baseDeckUnavailable();
  const theirsDeck = parseDeckForDiff(theirs?.content);

  if (expectedTheirsSha && (theirs?.sha ?? null) !== expectedTheirsSha) {
    throw new PreviewResolutionError(
      'The preview changed since the conflict report these choices were made against — ' +
        're-run accept for a fresh report',
      'CONTENT_CONFLICT'
    );
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    // Re-checked every attempt: a CAS-loss retry re-reads main, and choices
    // pinned to the reviewed report must not silently apply to newer content.
    if (expectedOursSha && (ours?.sha ?? null) !== expectedOursSha) {
      throw new PreviewResolutionError(
        'The live deck changed since the conflict report these choices were made against — ' +
          're-run accept for a fresh report',
        'CONTENT_CONFLICT'
      );
    }
    if (!ours?.sha) throw mainDeckMissing();

    const oursDeck = parseDeckForDiff(ours.content);
    const current = merge3Units(baseDeck, oursDeck, theirsDeck);
    const conflictIds = new Set(current.conflicts.map(conflict => conflict.id));
    if (conflictIds.size === 0) {
      throw new PreviewResolutionError(
        'Nothing to resolve — the preview now merges cleanly; accept it without resolutions',
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
        `Not current conflict ids: ${unknown.join(', ')} — re-run accept for the current report`,
        'UNKNOWN_RESOLUTIONS',
        unknown
      );
    }

    const resolved = merge3Units(baseDeck, oursDeck, theirsDeck, { resolutions: chosen });
    if (resolved.conflicts.length > 0) {
      throw new Error(
        `Resolution pass left conflicts standing (${resolved.conflicts.map(c => c.id).join(', ')}) — this is a bug`
      );
    }

    try {
      const committed = await commitSemanticDeckMerge(slide, resolved.merged, {
        oursSha: ours.sha,
        theirsSha: theirs?.sha ?? null,
        resolveThemeUrls,
      });
      return {
        merged: true,
        semantic: true,
        html_regenerated: true,
        auto_merged: resolved.autoMerged,
        resolved: resolutions,
        ...committed,
      };
    } catch (error: unknown) {
      if (!(error instanceof DeckConflictError) || attempt === 1) throw error;
      // Main moved under us — re-read, re-validate the conflict set, retry once.
      const { gitOrganization, repo } = resolveSlideRepoContext(slide);
      ours = await ContentService.getContent({
        gitOrganization,
        repo,
        path: `${slide.content_path}/deck.json`,
        skipCache: true,
      });
    }
  }
  /* c8 ignore next */
  throw new Error('unreachable');
}

// ─────────────────────────────────────────────────────────────────────────────
// Discard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discard the deck's preview branch (delete it; main is untouched).
 * 404-tolerant: an already-gone branch reports `existed: false` instead of
 * throwing (GitHub answers 422 "Reference does not exist" — some proxies 404).
 */
export async function discardDeckPreview(
  slide: SlideContentTarget
): Promise<{ discarded: true; existed: boolean }> {
  const { gitOrganization, repo } = resolveSlideRepoContext(slide);
  const branch = previewBranchName(slide.content_path);

  try {
    await ContentService.deleteBranch({ gitOrganization, repo, branch });
    return { discarded: true, existed: true };
  } catch (error: unknown) {
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 422) {
      return { discarded: true, existed: false };
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared-theme URL resolution (services-side, for MCP callers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve `shared:*` theme URLs for a deck via ContentService — the
 * services-side twin of apps/slides' getThemeUrls (same file layout, same
 * root-relative `/content/...` proxy URLs, so no base URL is needed).
 *
 * Read-path semantics: a resolve failure must not mutate the deck — returns
 * undefined and generateDeckHtml renders without theme links (with a warning).
 * Builtin and `custom:*` themes need no resolution (custom themes are loaded
 * dynamically by the viewer).
 */
export async function resolveSharedThemeUrls(
  slide: SlideContentTarget,
  deck: DeckJson
): Promise<DeckThemeUrls | undefined> {
  if (!deck.theme?.startsWith('shared:')) return undefined;
  const themeName = deck.theme.slice('shared:'.length);
  const { gitOrganization, repo } = resolveSlideRepoContext(slide);
  const themePath = `${THEMES_FOLDER}/${themeName}`;
  const baseUrl = `/content/${gitOrganization.login}/${repo}/${themePath}`;

  try {
    const manifestFile = await ContentService.getContent({
      gitOrganization,
      repo,
      path: `${themePath}/theme.json`,
    });
    if (!manifestFile) {
      throw new Error(`theme.json not found for shared theme '${themeName}'`);
    }
    const manifest = JSON.parse(manifestFile.content) as { bodyClasses?: unknown };

    // Prefer the v2 lib bundle when it exists (parity with getThemeUrls).
    const v2 = await ContentService.getMeta({
      gitOrganization,
      repo,
      path: `${themePath}/lib/offline-v2.css`,
    });
    const libCssFile = v2 ? 'lib/offline-v2.css' : 'lib/offline-v1.css';

    const custom = await ContentService.getMeta({
      gitOrganization,
      repo,
      path: `${themePath}/custom-theme.css`,
    });

    return {
      libCssUrl: `${baseUrl}/${libCssFile}`,
      customThemeUrl: custom ? `${baseUrl}/custom-theme.css` : null,
      bodyClasses: typeof manifest.bodyClasses === 'string' ? manifest.bodyClasses : '',
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[deckPreview] Could not resolve shared theme '${themeName}':`, message);
    return undefined;
  }
}
