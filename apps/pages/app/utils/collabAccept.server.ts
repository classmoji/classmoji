/**
 * Accepting a preview into a LIVE page: the pure halves.
 *
 * In a classroom that edits pages live, main is only the last checkpoint —
 * the page is the live document. An accept therefore sends the preview and
 * the page as it was when the preview started (its merge-base) to the collab
 * server's `merge-preview`, which runs the three-way merge against the live
 * document INSIDE its own transaction and applies the result id-aware. Nothing
 * is planned here from a snapshot: a snapshot is stale the moment it is read,
 * and ops planned from it would undo whatever was typed in between.
 *
 * Tested on its own in tests/unit/collab-accept.spec.ts.
 */

import { CollabRequestError } from '~/utils/collabEnv.server.ts';

export type MergeChoice = 'ours' | 'theirs';

export interface MergeResolution {
  id: string;
  choose: MergeChoice;
}

export interface MergeConflictUnit {
  id: string;
  [key: string]: unknown;
}

/** Page content in the snapshot shape the collab server takes. */
export interface PageContentBody {
  blocks: unknown[];
  coverImage: { url: string; position: number } | null;
}

/** The chooser's picks, as the merge takes them; malformed entries are dropped. */
export function resolutionList(
  resolutions: Array<{ id?: unknown; choose?: unknown }> | null | undefined
): MergeResolution[] {
  const out: MergeResolution[] = [];
  const seen = new Set<string>();
  for (const entry of resolutions ?? []) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) continue;
    if (entry.choose !== 'ours' && entry.choose !== 'theirs') continue;
    seen.add(entry.id);
    out.push({ id: entry.id, choose: entry.choose });
  }
  return out;
}

export type MergePreviewFailure =
  | { kind: 'conflict'; units: MergeConflictUnit[] }
  | { kind: 'failed'; status: number; message: string };

/**
 * What a refused `merge-preview` means for the person: a conflict report for
 * the chooser (409 `{ error: 'conflicts', conflicts }`, nothing applied), or a
 * failure with a sentence. Anything else rethrows.
 */
export function mergePreviewFailure(error: unknown): MergePreviewFailure {
  if (!(error instanceof CollabRequestError)) throw error;
  const body = error.body as { error?: unknown; conflicts?: unknown } | null;
  if (error.status === 409 && body?.error === 'conflicts' && Array.isArray(body.conflicts)) {
    return {
      kind: 'conflict',
      units: body.conflicts.filter(
        (unit): unit is MergeConflictUnit =>
          Boolean(unit) && typeof (unit as { id?: unknown }).id === 'string'
      ),
    };
  }
  if (error.status === 0) {
    return {
      kind: 'failed',
      status: 503,
      message: 'Couldn’t reach live editing. Try again.',
    };
  }
  return {
    kind: 'failed',
    status: 502,
    message: 'The preview could not be merged into the live page. Try again.',
  };
}
