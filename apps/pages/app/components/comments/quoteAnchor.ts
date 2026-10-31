import { countQuoteOccurrences, quoteOccurrenceIndex } from '@classmoji/page-schema/sections';

/**
 * Where a comment's quote sits in its block's text (plan D1). Pure, no DOM.
 *
 * The rule is page-schema's (`blockText`, `quoteOccurrenceIndex`), which the
 * server checks new quotes with, so the browser finds exactly what the server
 * accepted:
 *
 * - a block's text is its own inline content (no children), a hard break as
 *   "\n", a table's cells joined by one space, a locked section's title;
 * - quote and text are compared whitespace-normalized (every run of
 *   whitespace is one space);
 * - `quoteOccurrence` is the 0-based index among ALL matches, overlapping
 *   ones included ("aa" in "aaa" occurs at 0 and at 1);
 * - a quote not found at that index is not drawn ("text changed"); it is
 *   never re-anchored to another match.
 *
 * This module maps between offsets in the RAW text (what the document holds)
 * and that normalized comparison.
 */

const SPACE = /\s/u;

/**
 * `text` normalized as page-schema does, with, for each normalized character,
 * the raw range it stands for (a whitespace run is one character).
 */
function normalizedMap(text: string) {
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (SPACE.test(text[i])) {
      let j = i + 1;
      while (j < text.length && SPACE.test(text[j])) j++;
      starts.push(i);
      ends.push(j);
      i = j;
    } else {
      starts.push(i);
      ends.push(i + 1);
      i++;
    }
  }
  return { starts, ends };
}

/** The normalized index of raw offset `offset` (the character it falls in). */
function normalizedIndexOf(text: string, offset: number): number {
  const { starts, ends } = normalizedMap(text);
  for (let i = 0; i < starts.length; i++) if (offset < ends[i]) return i;
  return starts.length;
}

/**
 * The `occurrence`-th match of `quote` in `text`, as RAW offsets `[start, end)`,
 * or null when there is none.
 */
export function findQuote(
  text: string,
  quote: string,
  occurrence: number
): { start: number; end: number } | null {
  const index = quoteOccurrenceIndex(text, quote, occurrence);
  if (index < 0) return null;
  const needle = quote.replace(/\s+/gu, ' ');
  const { starts, ends } = normalizedMap(text);
  const last = index + needle.length - 1;
  if (last >= ends.length) return null;
  return { start: starts[index], end: ends[last] };
}

/**
 * The occurrence index for a quote selected at raw offset `start` in `text`:
 * the match that begins there (0 when, unexpectedly, none does).
 */
export function occurrenceAt(text: string, quote: string, start: number): number {
  const target = normalizedIndexOf(text, start);
  const total = countQuoteOccurrences(text, quote);
  for (let occurrence = 0; occurrence < total; occurrence++) {
    const index = quoteOccurrenceIndex(text, quote, occurrence);
    if (index === target) return occurrence;
    if (index < 0 || index > target) break;
  }
  return 0;
}

/**
 * The quote for a selection `[start, end)` in `text`: trimmed of surrounding
 * whitespace and cut to `max` characters (cut at the end, so the quote still
 * starts where the selection does). Null when nothing but whitespace is left.
 */
export function quoteForSelection(
  text: string,
  start: number,
  end: number,
  max: number
): { quote: string; start: number } | null {
  let from = Math.max(0, Math.min(start, end));
  let to = Math.min(text.length, Math.max(start, end));
  while (from < to && SPACE.test(text[from])) from++;
  while (to > from && SPACE.test(text[to - 1])) to--;
  if (to <= from) return null;
  if (to - from > max) {
    to = from + max;
    // Never split a surrogate pair at the cut.
    const last = text.charCodeAt(to - 1);
    if (last >= 0xd800 && last <= 0xdbff) to--;
    while (to > from && SPACE.test(text[to - 1])) to--;
  }
  return { quote: text.slice(from, to), start: from };
}
