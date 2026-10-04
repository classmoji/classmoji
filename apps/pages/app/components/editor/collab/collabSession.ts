/**
 * One live-editing session: the page's Y.Doc and its Hocuspocus provider,
 * created together, torn down together.
 *
 * Not React: the hook (`useCollabSession.ts`) creates one per room in an
 * effect and destroys it in the cleanup, so a re-render never makes a second
 * document (an open BlockNote issue traces broken undo to recreating them),
 * StrictMode's double effect leaves nothing connected, and navigating to
 * another page closes the old room before the new one opens. The provider is
 * made by an injected factory, so the unit suite drives the whole lifecycle
 * with a stub (tests/unit/collab-session.spec.ts).
 *
 * The provider is created with its awareness (never `awareness: null`) and a
 * local `user` state: awareness renews that state every 15 s, which is the
 * only traffic an idle editor sends, and what keeps an idle socket from
 * being dropped by the proxy (Hocuspocus 4.7 sends no pings).
 */

import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { CollabLoaderData, CollabRejectReason, CollabTokenPayload } from '@classmoji/collab';

import {
  normalizeRejectReason,
  peersFromAwareness,
  type CollabPeer,
  type ProviderStatus,
} from '~/utils/collab.ts';

/** What the session needs from a provider (HocuspocusProvider satisfies it). */
export interface CollabProviderLike {
  readonly awareness: Awareness | null;
  destroy(): void;
}

export interface CollabProviderCallbacks {
  onSynced(data: { state: boolean }): void;
  onStatus(data: { status: ProviderStatus | string }): void;
  onUnsyncedChanges(data: { number: number }): void;
  onAuthenticationFailed(data: { reason: string }): void;
}

export interface CollabProviderArgs extends CollabProviderCallbacks {
  url: string;
  name: string;
  document: Y.Doc;
  /** JSON `CollabTokenPayload`. Not a secret: the session cookie authenticates. */
  token: string;
}

export type CollabProviderFactory = (args: CollabProviderArgs) => CollabProviderLike;

export interface CollabSessionState {
  status: ProviderStatus;
  /** The first sync has completed at least once (the editor may mount). */
  hasSynced: boolean;
  /** The provider currently reports itself in sync. */
  synced: boolean;
  unsyncedChanges: number;
  /** Why the server refused this session, once it has. */
  rejected: CollabRejectReason | null;
  peers: CollabPeer[];
}

export const INITIAL_SESSION_STATE: CollabSessionState = {
  status: 'connecting',
  hasSynced: false,
  synced: false,
  unsyncedChanges: 0,
  rejected: null,
  peers: [],
};

const asStatus = (value: unknown): ProviderStatus =>
  value === 'connected' || value === 'disconnected' ? value : 'connecting';

export class CollabSession {
  readonly doc: Y.Doc;
  readonly provider: CollabProviderLike;
  readonly room: string;
  private state: CollabSessionState = INITIAL_SESSION_STATE;
  private listeners = new Set<() => void>();
  private destroyed = false;
  private providerDestroyed = false;
  private readonly userId: string;
  private readonly onAwarenessChange: () => void;

  constructor(collab: CollabLoaderData, createProvider: CollabProviderFactory) {
    this.room = collab.room;
    this.userId = collab.user.id;
    this.doc = new Y.Doc();
    const token: CollabTokenPayload = { schemaVersion: collab.schemaVersion };

    this.provider = createProvider({
      url: collab.wsUrl,
      name: collab.room,
      document: this.doc,
      token: JSON.stringify(token),
      onSynced: ({ state }) =>
        this.update({ synced: state, ...(state ? { hasSynced: true } : {}) }),
      onStatus: ({ status }) => this.update({ status: asStatus(status) }),
      onUnsyncedChanges: ({ number }) => this.update({ unsyncedChanges: number }),
      onAuthenticationFailed: ({ reason }) => this.reject(reason),
    });

    this.onAwarenessChange = () => this.refreshPeers();
    const awareness = this.provider.awareness;
    if (awareness) {
      // Present before the editor mounts (BlockNote's cursor plugin then keeps
      // the same field up to date), and the state awareness keeps renewing.
      awareness.setLocalStateField('user', {
        id: collab.user.id,
        name: collab.user.name,
        color: collab.user.color,
      });
      awareness.on('change', this.onAwarenessChange);
      this.refreshPeers();
    }
  }

  getState = (): CollabSessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Close the room: provider first (it flushes and leaves awareness), then the doc. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.provider.awareness?.off('change', this.onAwarenessChange);
    this.destroyProvider();
    this.doc.destroy();
    this.listeners.clear();
  }

  private destroyProvider() {
    if (this.providerDestroyed) return;
    this.providerDestroyed = true;
    try {
      this.provider.destroy();
    } catch (error) {
      console.warn('[collab] provider destroy failed:', error);
    }
  }

  /**
   * The server refused the room. The provider would otherwise retry forever,
   * so it is destroyed at once; the route decides what the person sees.
   */
  private reject(reason: unknown) {
    if (this.destroyed) return;
    this.destroyProvider();
    this.update({ rejected: normalizeRejectReason(reason), status: 'disconnected' });
  }

  private refreshPeers() {
    const awareness = this.provider.awareness;
    if (!awareness || this.destroyed) return;
    this.update({
      peers: peersFromAwareness(
        awareness.getStates() as Map<number, Record<string, unknown>>,
        this.doc.clientID,
        this.userId
      ),
    });
  }

  private update(patch: Partial<CollabSessionState>) {
    if (this.destroyed) return;
    // A refused session stays refused: late provider events do not revive it.
    if (this.state.rejected && patch.status && patch.status !== 'disconnected') return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
