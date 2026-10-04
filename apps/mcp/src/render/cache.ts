/**
 * An in-memory LRU of renders, keyed by content address.
 *
 * `live:E.V` and a blob sha both name exactly one state of a document, so a
 * render of (doc, version, slide, size) never goes stale — it only stops being
 * asked for. Entries are per process: a render served by another MCP instance
 * is simply rendered again.
 *
 * Reads are gated before the cache is consulted (the tool checks the caller
 * may read the deck), so an entry is only ever handed to someone who could
 * have rendered it themselves.
 */

export class LruCache<V> {
  private readonly map = new Map<string, V>();
  private readonly max: number;
  // No parameter property: the MCP runs on Node's type stripping, which
  // refuses TypeScript-only runtime syntax.
  constructor(max: number) {
    this.max = max;
  }

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
