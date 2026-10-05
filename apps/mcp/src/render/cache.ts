/**
 * An in-memory LRU of renders, keyed by content address, bounded by BYTES
 * (the MCP runs on small VMs) as well as entries, with a TTL.
 *
 * `live:E.V` and a blob sha name exactly one state of a document, but not
 * everything a render shows: a custom theme file, an uploaded image or an
 * iframe's files live outside the document and can change without a new
 * version. Entries therefore expire (`ttlMs`, 5 min by default), so an
 * outside change shows within that time. Entries are per process: a render
 * served by another MCP instance is simply rendered again.
 *
 * Reads are gated before the cache is consulted (the tool checks the caller
 * may read the deck), so an entry is only ever handed to someone who could
 * have rendered it themselves.
 */

export interface LruCacheOptions<V> {
  /** At most this many entries. */
  maxEntries: number;
  /** At most this many bytes in total (by `sizeOf`); an entry bigger than this is not kept. */
  maxBytes?: number;
  /** An entry's size in bytes (default: 1, i.e. count only). */
  sizeOf?: (value: V) => number;
  /** How long an entry is served (default 5 min). */
  ttlMs?: number;
  now?: () => number;
}

export const RENDER_CACHE_TTL_MS = 5 * 60 * 1000;

interface Slot<V> {
  value: V;
  bytes: number;
  at: number;
}

export class LruCache<V> {
  private readonly map = new Map<string, Slot<V>>();
  private readonly options: LruCacheOptions<V>;
  private total = 0;
  // No parameter property: the MCP runs on Node's type stripping, which
  // refuses TypeScript-only runtime syntax.
  constructor(options: LruCacheOptions<V>) {
    this.options = options;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private drop(key: string): void {
    const slot = this.map.get(key);
    if (!slot) return;
    this.map.delete(key);
    this.total -= slot.bytes;
  }

  get(key: string): V | undefined {
    const slot = this.map.get(key);
    if (slot === undefined) return undefined;
    if (this.now() - slot.at > (this.options.ttlMs ?? RENDER_CACHE_TTL_MS)) {
      this.drop(key);
      return undefined;
    }
    // Refresh recency (not age).
    this.map.delete(key);
    this.map.set(key, slot);
    return slot.value;
  }

  /**
   * `keepAge`: an entry that only grows (more images of the same render)
   * keeps the age it had, so the TTL still counts from the first render.
   */
  set(key: string, value: V, options: { keepAge?: boolean } = {}): void {
    const prior = this.map.get(key);
    this.drop(key);
    const bytes = this.options.sizeOf ? this.options.sizeOf(value) : 1;
    const maxBytes = this.options.maxBytes ?? Number.POSITIVE_INFINITY;
    if (bytes > maxBytes) return;
    const at = options.keepAge && prior ? prior.at : this.now();
    this.map.set(key, { value, bytes, at });
    this.total += bytes;
    while (this.map.size > this.options.maxEntries || this.total > maxBytes) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  /** Bytes held (by `sizeOf`). */
  get bytes(): number {
    return this.total;
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}

/** Heap bytes of a string (V8 keeps base64/ASCII one byte per char; be generous). */
export const stringBytes = (value: string): number => value.length + 64;
