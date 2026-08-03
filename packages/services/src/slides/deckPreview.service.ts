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
 * nothing merges, the branch is kept, and a structured per-unit report is
 * built by 3-way-walking deck slides (diffDeckUnits: base = merge-base,
 * ours = main, theirs = preview) so the caller resolves semantically.
 *
 * Discard = delete the branch; main untouched.
 */

import getPrisma from '@classmoji/database';
import { ContentService } from '../content/ContentService.ts';
import {
  generateDeckHtml,
  diffDeckUnits,
  type DeckThemeUrls,
  type DeckUnitConflict,
} from './deckHtml.ts';
import {
  DeckConflictError,
  previewBranchName,
  resolveSlideRepoContext,
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
      /** true when a concurrent stacking apply landed after the merge snapshot — the branch was kept, not deleted. */
      preview_kept?: boolean;
      /** Why the preview branch was retained (present iff preview_kept). */
      reason?: string;
    }
  | {
      merged: false;
      conflict: true;
      /** Slides changed on BOTH sides with differing results (deck-unit 3-way walk). */
      units: DeckUnitConflict[];
      /** Present when both sides reordered the root slide sequence differently. */
      order_conflict?: { base: string[]; ours: string[]; theirs: string[] };
      ours_sha: string | null;
      theirs_sha: string | null;
    };

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
 * On a git-level conflict, nothing is merged and nothing is deleted; instead
 * a structured per-unit report is built with diffDeckUnits (base = merge-base
 * deck, ours = main, theirs = preview) so the caller can resolve semantically
 * and re-apply.
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
    // Conflict: build the per-unit report. The branch is left alone so the
    // caller can inspect, re-apply on fresh main, or discard explicitly.
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

    const diff = diffDeckUnits(
      parseDeckForDiff(base?.content),
      parseDeckForDiff(ours?.content),
      parseDeckForDiff(theirs?.content)
    );

    return {
      merged: false,
      conflict: true,
      units: diff.units,
      ...(diff.orderConflict ? { order_conflict: diff.orderConflict } : {}),
      ours_sha: ours?.sha ?? null,
      theirs_sha: theirs?.sha ?? null,
    };
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
