/**
 * One live deck session: the deck's Y.Doc and its Hocuspocus provider,
 * created together, torn down together (one provider per deck, created once —
 * never in render).
 *
 * Not React: `useDeckCollab` creates one per room in an effect and destroys
 * it in the cleanup. The provider comes from an injected factory, so the unit
 * suite drives the lifecycle with a stub.
 *
 * The provider keeps its awareness (never `awareness: null`) with a local
 * `user` state: awareness renews it every 15 s, which is what keeps an idle
 * socket from being dropped (Hocuspocus 4.7 sends no pings).
 */
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import {
  COLLAB_CLOSE_FORBIDDEN,
  COLLAB_CLOSE_RELOAD,
  type CollabLoaderData,
  type CollabTokenPayload,
} from '@classmoji/collab';

import {
  normalizeRejectReason,
  type LiveRejectReason,
  peersFromAwareness,
  type CollabPeer,
  type ProviderStatus,
} from './collab.ts';

/** What the session needs from a provider (HocuspocusProvider satisfies it). */
export interface CollabProviderLike {
  readonly awareness: Awareness | null;
  readonly hasUnsyncedChanges: boolean;
  destroy(): void;
}

export interface CollabProviderArgs {
  url: string;
  name: string;
  document: Y.Doc;
  /** JSON `CollabTokenPayload`. Not a secret: the session cookie authenticates. */
  token: string;
  onSynced(data: { state: boolean }): void;
  onStatus(data: { status: ProviderStatus | string }): void;
  onUnsyncedChanges(data: { number: number }): void;
  onAuthenticationFailed(data: { reason: string }): void;
  /** The socket closed: 4403 = access re-check failed, 4409 = deck closed (reload). */
  onClose(data: { event: { code?: number } | null | undefined }): void;
}

export type CollabProviderFactory = (args: CollabProviderArgs) => CollabProviderLike;

export interface CollabSessionState {
  status: ProviderStatus;
  /** The first sync has completed at least once (the editor may render). */
  hasSynced: boolean;
  synced: boolean;
  unsyncedChanges: number;
  rejected: LiveRejectReason | null;
  /** The server closed the deck under us (flag off, deck deleted): reload the route. */
  reloadRequired: boolean;
  peers: CollabPeer[];
}

export const INITIAL_SESSION_STATE: CollabSessionState = {
  status: 'connecting',
  hasSynced: false,
  synced: false,
  unsyncedChanges: 0,
  rejected: null,
  reloadRequired: false,
  peers: [],
};

const asStatus = (value: unknown): ProviderStatus =>
  value === 'connected' || value === 'disconnected' ? value : 'connecting';

export class DeckCollabSession {
  readonly doc: Y.Doc;
  readonly provider: CollabProviderLike;
  readonly room: string;
  readonly user: CollabLoaderData['user'];
  private state: CollabSessionState = INITIAL_SESSION_STATE;
  private listeners = new Set<() => void>();
  private unsyncedListeners = new Set<(pending: number) => void>();
  private readyListeners = new Set<(ready: boolean) => void>();
  private readyFlag = false;
  private destroyed = false;
  private providerDestroyed = false;
  private readonly onAwarenessChange: () => void;

  constructor(collab: CollabLoaderData, createProvider: CollabProviderFactory) {
    this.room = collab.room;
    this.user = collab.user;
    this.doc = new Y.Doc();
    const token: CollabTokenPayload = { schemaVersion: collab.schemaVersion };

    this.provider = createProvider({
      url: collab.wsUrl,
      name: collab.room,
      document: this.doc,
      token: JSON.stringify(token),
      onSynced: ({ state }) => {
        this.update({ synced: state, ...(state ? { hasSynced: true } : {}) });
        this.setReady(state && this.state.status === 'connected');
      },
      onStatus: ({ status }) => {
        this.update({ status: asStatus(status) });
        if (asStatus(status) !== 'connected') this.setReady(false);
      },
      onUnsyncedChanges: ({ number }) => {
        this.update({ unsyncedChanges: number });
        for (const listener of this.unsyncedListeners) listener(number);
      },
      onAuthenticationFailed: ({ reason }) => this.reject(reason),
      onClose: ({ event }) => {
        if (event?.code === COLLAB_CLOSE_FORBIDDEN) this.reject('forbidden');
        else if (event?.code === COLLAB_CLOSE_RELOAD) {
          this.destroyProvider();
          this.update({ reloadRequired: true, status: 'disconnected' });
        }
      },
    });

    this.onAwarenessChange = () => this.refreshPeers();
    const awareness = this.provider.awareness;
    if (awareness) {
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

  /** Called with the pending-update count whenever it changes. */
  onUnsynced(listener: (pending: number) => void): () => void {
    this.unsyncedListeners.add(listener);
    return () => {
      this.unsyncedListeners.delete(listener);
    };
  }

  /** Connected and synced since the last (re)connect: server state is known. */
  get ready(): boolean {
    return this.readyFlag && !this.providerDestroyed;
  }

  onReady(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  private setReady(ready: boolean) {
    if (this.readyFlag === ready) return;
    this.readyFlag = ready;
    for (const listener of this.readyListeners) listener(ready);
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  get awareness(): Awareness | null {
    return this.providerDestroyed ? null : this.provider.awareness;
  }

  /** Yjs clientIDs currently connected (from awareness). */
  connectedClients(): Set<number> {
    const awareness = this.awareness;
    return new Set(awareness ? awareness.getStates().keys() : []);
  }

  /** Every local update has reached the server. */
  get settled(): boolean {
    return !this.providerDestroyed && !this.provider.hasUnsyncedChanges;
  }

  /** Share the slide this person is on (presence per slide). */
  setCurrentSlide(slideId: string | null): void {
    this.awareness?.setLocalStateField('slide', slideId);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.provider.awareness?.off('change', this.onAwarenessChange);
    this.destroyProvider();
    this.doc.destroy();
    this.listeners.clear();
    this.unsyncedListeners.clear();
    this.readyListeners.clear();
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

  /** The server refused the room: stop the provider (it would retry forever). */
  private reject(reason: unknown) {
    if (this.destroyed) return;
    this.destroyProvider();
    this.setReady(false);
    this.update({ rejected: normalizeRejectReason(reason), status: 'disconnected' });
  }

  private refreshPeers() {
    const awareness = this.provider.awareness;
    if (!awareness || this.destroyed) return;
    this.update({
      peers: peersFromAwareness(
        awareness.getStates() as Map<number, Record<string, unknown>>,
        this.doc.clientID,
        this.user.id
      ),
    });
  }

  private update(patch: Partial<CollabSessionState>) {
    if (this.destroyed) return;
    if (this.state.rejected && patch.status && patch.status !== 'disconnected') return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
