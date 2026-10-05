import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/**
 * Fractional indexes for ordering (deck slides): a string key that sorts
 * between its neighbours, so concurrent inserts and moves never renumber
 * other items. Keys compare with plain `<` (code-unit order), never
 * `localeCompare`.
 */

/** A key strictly between `before` and `after` (null = open end). */
export function keyBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}

/** `n` ascending keys strictly between `before` and `after`. */
export function keysBetween(before: string | null, after: string | null, n: number): string[] {
  return generateNKeysBetween(before, after, n);
}

/** `n` ascending keys for a fresh list. */
export function initialKeys(n: number): string[] {
  return generateNKeysBetween(null, null, n);
}

/** Sort comparator for fractional keys. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
