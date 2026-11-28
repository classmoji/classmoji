import type { CollabKind } from '@classmoji/collab';
import { reportError } from '@classmoji/utils/error-report';

import type { CollabAdapter } from './types.ts';

/**
 * Adapter lookup by kind. Each adapter module exports a factory:
 *   page.ts → `export function createPageAdapter(): CollabAdapter<'page'>`
 *   deck.ts → `export function createDeckAdapter(): CollabAdapter<'deck'>`
 *
 * Both are imported lazily, on first use: a module that fails to load makes
 * that kind unavailable — its rooms are refused with a logged reason —
 * without taking the server down. The specifiers are literals so
 * `scripts/check-no-dom-runtime.mjs --entry` follows them into both adapters.
 */
export interface AdapterRegistry {
  get(kind: CollabKind): Promise<CollabAdapter | null>;
}

type Loader = () => Promise<CollabAdapter>;

const DEFAULT_LOADERS: Record<CollabKind, Loader> = {
  page: async () => (await import('./page.ts')).createPageAdapter(),
  deck: async () => (await import('./deck.ts')).createDeckAdapter(),
};

export function createAdapterRegistry(
  overrides: Partial<Record<CollabKind, CollabAdapter | null>> = {}
): AdapterRegistry {
  const loaded = new Map<CollabKind, Promise<CollabAdapter | null>>();

  return {
    get(kind) {
      if (kind in overrides) return Promise.resolve(overrides[kind] ?? null);
      let pending = loaded.get(kind);
      if (!pending) {
        pending = DEFAULT_LOADERS[kind]().catch(err => {
          console.error(`[collab] ${kind} adapter unavailable; ${kind} rooms are refused:`, err);
          reportError(err, { surface: 'collab.adapter_load', tags: { kind } });
          loaded.delete(kind); // try again on the next request
          return null;
        });
        loaded.set(kind, pending);
      }
      return pending;
    },
  };
}
