/**
 * What each agent was shown of each live document, as hashes — the state
 * behind the `/ops` `expect_since` check (an agent's pin `live:<epoch>.<version>`
 * judged per block/slide HERE, on the one stateful collab server, so it does
 * not matter which MCP machine served the read and which the apply).
 *
 * A view is recorded when `/snapshot` is called with a viewer (an agent's
 * read; renders and the MCP's own pre-apply read pass none) and after each
 * `/ops` call (the agent's view of the version its write left: see
 * `viewAfterWrite`). A `/cover` set records none (it shows the caller no block). Keyed by viewer (user id + agent session) + kind +
 * doc + epoch + version, so one agent's view never stands in for another's
 * read. Rules, as the MCP's cache had them: between two reads of one version
 * the FIRST is kept (a later read can never weaken a pin), a read replaces a
 * view an apply left (re-reading clears a refusal that view caused), and an
 * apply never replaces anything. Process memory only: 30 min TTL, LRU,
 * capped by bytes. After a restart every older pin is answered
 * `unknown-version` (one re-read).
 */
import { viewBytes, type ItemView } from '@classmoji/collab/hash';

const TTL_MS = 30 * 60 * 1000;
/** Bytes of hashes kept across all views (a 100-block view is ~25 KB). */
const MAX_BYTES = 32 * 1024 * 1024;

export type ViewOrigin = 'read' | 'apply';

interface Entry {
  view: ItemView;
  origin: ViewOrigin;
  at: number;
  bytes: number;
}

export interface ViewKey {
  /** The caller's user id. */
  userId: string;
  /** The caller's agent session (Mcp-Session-Id), when it has one. */
  session?: string | null;
  kind: string;
  docId: string;
  epoch: number;
  version: number;
}

export class AgentViews {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private readonly options: { ttlMs?: number; maxBytes?: number; now?: () => number };

  // No parameter property: the server runs on Node's type stripping, which
  // refuses TypeScript-only runtime syntax.
  constructor(options: { ttlMs?: number; maxBytes?: number; now?: () => number } = {}) {
    this.options = options;
  }

  private get ttl() {
    return this.options.ttlMs ?? TTL_MS;
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private static key(k: ViewKey): string {
    return [k.userId, k.session ?? '', k.kind, k.docId, `${k.epoch}.${k.version}`].join('\u0000');
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  /** Record `view` under `key` (see the rules above). */
  remember(key: ViewKey, view: ItemView, origin: ViewOrigin): void {
    const k = AgentViews.key(key);
    const now = this.now();
    const existing = this.entries.get(k);
    if (existing && now - existing.at <= this.ttl) {
      const replaces = existing.origin === 'apply' && origin === 'read';
      if (!replaces) {
        // Kept as first recorded, but alive again: a re-read extends its life.
        existing.at = now;
        this.entries.delete(k);
        this.entries.set(k, existing);
        return;
      }
    }
    this.drop(k);
    const bytes = viewBytes(view) + k.length * 2;
    const max = this.options.maxBytes ?? MAX_BYTES;
    if (bytes > max) return;
    this.entries.set(k, { view, origin, at: now, bytes });
    this.bytes += bytes;
    while (this.bytes > max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  /** The view recorded under `key`, or null (never recorded, expired or evicted). */
  recall(key: ViewKey): ItemView | null {
    const k = AgentViews.key(key);
    const entry = this.entries.get(k);
    if (!entry) return null;
    if (this.now() - entry.at > this.ttl) {
      this.drop(k);
      return null;
    }
    // Recency for the LRU, without touching `at` (the TTL counts from the read).
    this.entries.delete(k);
    this.entries.set(k, entry);
    return entry.view;
  }

  /** Bytes held now (tests, diagnostics). */
  get size(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.bytes };
  }
}

const stores = new WeakMap<object, AgentViews>();

/** The store of one collab server (keyed by its runtime; one per process in production). */
export function agentViewsFor(runtime: object): AgentViews {
  let store = stores.get(runtime);
  if (!store) {
    store = new AgentViews();
    stores.set(runtime, store);
  }
  return store;
}
