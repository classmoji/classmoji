import type * as Y from 'yjs';

/**
 * The smallest single splice turning `prev` into `next`: common prefix and
 * suffix kept, the middle replaced. Never splits a UTF-16 surrogate pair.
 */
export function textSplice(
  prev: string,
  next: string
): { index: number; remove: number; insert: string } | null {
  if (prev === next) return null;
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  // Do not end the prefix between a high and a low surrogate.
  if (start > 0 && isHighSurrogate(prev.charCodeAt(start - 1))) start--;

  let endPrev = prev.length;
  let endNext = next.length;
  while (
    endPrev > start &&
    endNext > start &&
    prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)
  ) {
    endPrev--;
    endNext--;
  }
  // Do not start the suffix on a low surrogate whose high half is in the middle.
  if (endPrev < prev.length && isLowSurrogate(prev.charCodeAt(endPrev)) && endPrev > start) {
    endPrev++;
    endNext++;
  }
  return { index: start, remove: endPrev - start, insert: next.slice(start, endNext) };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Make a Y.Text equal `next` with one character-level splice, so concurrent
 * edits elsewhere in the text survive. Call inside a transaction.
 */
export function setYText(text: Y.Text, next: string): boolean {
  const splice = textSplice(text.toString(), next);
  if (!splice) return false;
  if (splice.remove > 0) text.delete(splice.index, splice.remove);
  if (splice.insert) text.insert(splice.index, splice.insert);
  return true;
}
