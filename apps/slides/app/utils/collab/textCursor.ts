/**
 * Keep a textarea's caret where the person left it when someone else's edit
 * lands in the same Y.Text: map an index through a Yjs text delta.
 */
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
