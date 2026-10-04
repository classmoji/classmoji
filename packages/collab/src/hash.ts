/**
 * `@classmoji/collab/hash` — NODE ONLY (node:crypto): the hash a guarded
 * `/ops` call sends in `expect` for each block (page) or slide (deck) it read
 * from `/snapshot`, and that the collab server recomputes inside the live
 * transaction. Not exported from the package root (browser bundles).
 */
import { createHash } from 'node:crypto';

/**
 * Stable JSON: object keys sorted at every level; `undefined` members are
 * dropped (and become `null` inside arrays), exactly as JSON.stringify does,
 * so `{ a: 1, b: undefined }` and `{ a: 1 }` hash alike.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return stableJson((value as { toJSON: () => unknown }).toJSON());
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => (v === undefined || typeof v === 'function' ? 'null' : stableJson(v))).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter(key => record[key] !== undefined && typeof record[key] !== 'function')
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** sha1 hex of the item's stable JSON. */
export function itemHash(item: unknown): string {
  return createHash('sha1').update(stableJson(item)).digest('hex');
}
