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

import { blockSummary } from '~/components/preview/conflictChooser.ts';
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

/** Longest slice of a block's text in an order-conflict row. */
const ORDER_SUMMARY_CAP = 80;

/**
 * Text previews for the blocks an order conflict lists (the chooser shows
 * them instead of raw ids): `type: text…`, from the first document that has
 * the block — the live page, then the preview, then the merge-base. Null when
 * there is no order conflict.
 */
export function orderUnitPreviews(
  units: MergeConflictUnit[],
  docs: unknown[][]
): Record<string, { index: number; summary: string }> | null {
  const ids = new Set<string>();
  for (const unit of units) {
    if (unit.reason !== 'order') continue;
    for (const key of ['ours', 'theirs', 'base'] as const) {
      const list = unit[key];
      if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') ids.add(id);
    }
  }
  if (ids.size === 0) return null;
  const previews: Record<string, { index: number; summary: string }> = {};
  for (const id of ids) {
    for (const doc of docs) {
      const index = doc.findIndex(block => Boolean(block) && (block as { id?: unknown }).id === id);
      if (index === -1) continue;
      const { type, text } = blockSummary(doc[index]);
      const shown =
        text.length > ORDER_SUMMARY_CAP ? `${text.slice(0, ORDER_SUMMARY_CAP - 1)}…` : text;
      previews[id] = { index, summary: shown ? `${type}: ${shown}` : type };
      break;
    }
  }
  return previews;
}
