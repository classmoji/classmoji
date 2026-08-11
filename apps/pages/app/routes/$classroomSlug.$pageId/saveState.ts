/**
 * saveState.ts — pure decision helpers for the page editor's save/conflict
 * state machine.
 *
 * No React imports: the route component wires these in, and the Playwright
 * runner unit-tests them directly (tests/unit/save-state.spec.ts) without a
 * browser. Extracting the load-bearing decisions here keeps the review
 * findings' fixes (P1 pairing guard, P4 per-page stamping, P9 status race)
 * verifiable in isolation.
 */

import type { ConflictUnit } from '~/components/preview/conflictChooser.ts';

/**
 * The document the editor's next diff-at-save is computed against, bound to the
 * conflict-token sha it represents. Keeping the two together is the P1 fix: a
 * cover write (or any path) that advances the token WITHOUT re-basing this
 * document would otherwise let the ops replay onto the wrong base and silently
 * clobber concurrent edits.
 */
export interface SaveBaseline {
  /** content.json's blob sha this baseline document corresponds to. */
  sha: string | null;
  /** The normalized editor document (JSON string) at that sha. */
  content: string;
}

/**
 * P1 pairing guard: the diff-at-save (ops) path is only trustworthy when the
 * baseline we diff against is EXACTLY the document the conflict token names —
 * the server replays the ops onto `base_sha`, so a mismatch replays onto the
 * wrong base. Any desync forces the whole-document save (always correct).
 */
export function opsPathEligible(
  baseline: SaveBaseline | null,
  token: string | null
): baseline is SaveBaseline & { sha: string } {
  return Boolean(token) && baseline != null && baseline.sha === token;
}

/** The save fetcher's JSON payload shapes this module reasons about. */
export interface SaveFetcherData {
  success?: boolean;
  conflict?: boolean;
  units?: ConflictUnit[];
  autoMerged?: number;
  oursSha?: string | null;
  error?: string;
  code?: string;
  sha?: string;
  merged_content?: unknown;
  merged_with_concurrent?: number;
}

export interface SaveMergeReport {
  units: ConflictUnit[];
  autoMerged: number;
  oursSha: string | null;
}

/**
 * P4: a save exchange belongs to the page whose editor produced it. `fetcher`
 * state survives same-route param navigation, so its data must be read only
 * when the page it was stamped for still matches — otherwise page A's conflict
 * chooser ghosts onto page B and Apply fires a wrong-page save chain.
 */
export function fetcherMatchesPage(stampedPageId: string | null, currentPageId: string): boolean {
  return stampedPageId === currentPageId;
}

/**
 * The save-merge chooser report — derived from the fetcher ONLY when the data
 * was stamped for the current page (P4). A stale cross-page report returns null.
 */
export function deriveSaveMergeReport(
  data: SaveFetcherData | undefined,
  matchesPage: boolean
): SaveMergeReport | null {
  if (!matchesPage) return null;
  if (data?.conflict && data?.units) {
    return {
      units: data.units,
      autoMerged: data.autoMerged ?? 0,
      oursSha: data.oursSha ?? null,
    };
  }
  return null;
}

/**
 * The plain "page changed — reload" banner state: a 409 with NO mergeable
 * report, and only for a fetcher exchange stamped for the current page (P4).
 */
export function deriveSaveConflict(
  data: SaveFetcherData | undefined,
  matchesPage: boolean,
  mergeReport: SaveMergeReport | null
): boolean {
  return matchesPage && Boolean(data?.conflict) && !mergeReport;
}

/**
 * P9: a `code`-bearing refusal that is NOT a conflict (e.g. OPS_BASE_MISMATCH,
 * OPS_MALFORMED) is being auto-recovered by the whole-document fallback effect.
 * The completion effect must keep showing 'saving' for it, not flash 'error'
 * for the multi-second recovery round-trip.
 */
export function isCodeFallbackRefusal(data: SaveFetcherData | undefined): boolean {
  return Boolean(data?.code) && !data?.conflict;
}
