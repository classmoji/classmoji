/**
 * Keep a textarea's caret where the person left it when someone else's edit
 * lands in the same Y.Text: map an index through a Yjs text delta.
 */
import type * as Y from 'yjs';
import { textSplice } from '@classmoji/collab';

export type TextDelta = Array<{ retain?: number; insert?: unknown; delete?: number }>;

/** `index` after `delta` was applied to the text it pointed into. */
export function transformIndex(index: number, delta: TextDelta): number {
  let pos = 0; // position in the OLD text
  let shift = 0;
  for (const op of delta) {
    if (pos > index) break;
    if (op.retain !== undefined) {
      pos += op.retain;
    } else if (op.insert !== undefined) {
      const length = typeof op.insert === 'string' ? op.insert.length : 1;
      // Text inserted at or before the caret pushes it right.
      if (pos <= index) shift += length;
    } else if (op.delete !== undefined) {
      const end = pos + op.delete;
      if (end <= index) shift -= op.delete;
      else if (pos < index) shift -= index - pos;
      pos = end;
    }
  }
  return Math.max(0, index + shift);
}

/**
 * Apply what the person typed (`shown` → `next`) to the live text, moved past
 * the remote changes that landed since `shown` was rendered — never a diff
 * against text they did not see (which would delete it).
 */
export function applyNotesEdit(
  text: Y.Text,
  shown: string,
  next: string,
  remoteSince: readonly TextDelta[]
): void {
  const splice = textSplice(shown, next);
  if (!splice) return;
  let start = splice.index;
  let end = splice.index + splice.remove;
  for (const delta of remoteSince) {
    start = transformIndex(start, delta);
    end = transformIndex(end, delta);
  }
  const length = text.length;
  start = Math.min(start, length);
  end = Math.min(Math.max(end, start), length);
  if (end > start) text.delete(start, end - start);
  if (splice.insert) text.insert(start, splice.insert);
}
