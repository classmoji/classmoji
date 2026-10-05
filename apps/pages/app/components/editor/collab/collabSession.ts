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
import {
  AgentTouchTracker,
  COLLAB_CLOSE_FORBIDDEN,
  COLLAB_CLOSE_RELOAD,
  type AgentTouch,
  type CollabLoaderData,
  type CollabTokenPayload,
} from '@classmoji/collab';

import {
  normalizeRejectReason,
  parseStatelessMessage,
  peersFromAwareness,
  type CollabPeer,
  type LiveCheckpoint,
  type LiveRefusal,
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
  /**
   * The socket closed. 4403: the server's periodic re-check refused access;
   * 4409: the room was closed (flag off, page deleted) and the route reloads.
   */
  onClose(data: { event: { code?: number; reason?: string } | null | undefined }): void;
  /** A stateless message from the server (JSON payload). */
  onStateless(data: { payload: string }): void;
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
  /**
   * This browser made edits the server has not acknowledged yet (counted from
   * the document's own updates, so edits made while offline count too).
   */
  localUnsynced: boolean;
  /** Why the session ended, once it has. */
  rejected: LiveRefusal | null;
  peers: CollabPeer[];
  /** Blocks an agent just inserted or changed, while their mark shows (agentTouch.ts). */
  agentTouches: AgentTouch[];
  /** When the session was opened (ms since epoch). */
  openedAt: number;
  /** The last checkpoint message this session received, numbered as it arrives. */
  lastCheckpoint: (LiveCheckpoint & { seq: number }) | null;
  /**
   * The document changed (here or anywhere else) since the room's last
   * successful checkpoint message, or since the first sync when none came yet.
   */
  editedSinceCheckpoint: boolean;
  /** Title/width changed outside the document, numbered as it arrives. */
  pageMeta: { title?: string; width?: number; seq: number } | null;
  /** Numbered each time the page's pending preview was created, changed or removed. */
  previewChangedSeq: number;
}

export const INITIAL_SESSION_STATE: CollabSessionState = {
  status: 'connecting',
  hasSynced: false,
  synced: false,
  unsyncedChanges: 0,
  localUnsynced: false,
  rejected: null,
  peers: [],
  agentTouches: [],
  openedAt: 0,
  lastCheckpoint: null,
  editedSinceCheckpoint: false,
  pageMeta: null,
  previewChangedSeq: 0,
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
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly touches: AgentTouchTracker;
  private touchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    collab: CollabLoaderData,
    createProvider: CollabProviderFactory,
    now: () => number = () => Date.now()
  ) {
    this.touches = new AgentTouchTracker(now);
    this.room = collab.room;
    this.userId = collab.user.id;
    this.doc = new Y.Doc();
    this.state = { ...INITIAL_SESSION_STATE, openedAt: Date.now() };
    const token: CollabTokenPayload = { schemaVersion: collab.schemaVersion };

    this.provider = createProvider({
      url: collab.wsUrl,
      name: collab.room,
      document: this.doc,
      token: JSON.stringify(token),
      onSynced: ({ state }) =>
        this.update({ synced: state, ...(state ? { hasSynced: true } : {}) }),
      onStatus: ({ status }) => {
        const next = asStatus(status);
        // The provider never reports `synced: false`; a dropped socket is it.
        this.update(next === 'connected' ? { status: next } : { status: next, synced: false });
      },
      onUnsyncedChanges: ({ number }) =>
        this.update({
          unsyncedChanges: number,
          // Everything sent has been acknowledged on a live connection.
          ...(number === 0 && this.state.status === 'connected' && this.state.synced
            ? { localUnsynced: false }
            : {}),
        }),
      onAuthenticationFailed: ({ reason }) => this.reject(reason),
      // The server re-checks access every minute and closes the socket with
      // 4403 when it fails. That is a close, not an auth message: without
      // this the provider would just reconnect while the editor stayed
      // editable over a document that may never sync again.
      onStateless: ({ payload }) => this.receive(payload),
      onClose: ({ event }) => {
        if (event?.code === COLLAB_CLOSE_FORBIDDEN) this.reject('forbidden');
        else if (event?.code === COLLAB_CLOSE_RELOAD) {
          // The close reason is `reload` or the refusal behind it; a reseeded
          // room is a stale one (reloads only with nothing unsynced here).
          if (event.reason === 'stale-epoch') this.reject('stale-epoch');
          else this.end('reload');
        }
      },
    });

    // Any change after the first sync is one GitHub does not have yet. Local
    // edits: every document update that did not come from the provider
    // (remote updates carry the provider as their origin).
    this.onDocUpdate = (_update, origin) => {
      if (this.destroyed) return;
      if (this.state.hasSynced && !this.state.editedSinceCheckpoint) {
        this.update({ editedSinceCheckpoint: true });
      }
      if (origin === this.provider) return;
      if (!this.state.localUnsynced) this.update({ localUnsynced: true });
    };
    this.doc.on('update', this.onDocUpdate);

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
    if (this.touchTimer) clearTimeout(this.touchTimer);
    this.touchTimer = null;
    this.provider.awareness?.off('change', this.onAwarenessChange);
    this.doc.off('update', this.onDocUpdate);
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
  private seq = 0;

  /** A stateless message: a checkpoint result, or the page's title/width. */
  private receive(payload: string) {
    const message = parseStatelessMessage(payload);
    if (!message || this.destroyed) return;
    this.seq += 1;
    if (message.type === 'checkpoint') {
      const { type: _type, ...checkpoint } = message;
      this.update({
        lastCheckpoint: { ...checkpoint, seq: this.seq },
        // A saved page is GitHub's copy again; a failed run changes nothing.
        ...(checkpoint.error ? {} : { editedSinceCheckpoint: false }),
      });
    } else if (message.type === 'preview-changed') {
      this.update({ previewChangedSeq: this.seq });
    } else {
      const { type: _type, ...meta } = message;
      this.update({ pageMeta: { ...meta, seq: this.seq } });
    }
  }

  private reject(reason: unknown) {
    this.end(normalizeRejectReason(reason));
  }

  private end(refusal: LiveRefusal) {
    if (this.destroyed || this.state.rejected) return;
    this.destroyProvider();
    this.update({ rejected: refusal, status: 'disconnected', synced: false });
  }

  private refreshPeers() {
    const awareness = this.provider.awareness;
    if (!awareness || this.destroyed) return;
    const states = awareness.getStates() as Map<number, Record<string, unknown>>;
    // Awareness changes on every caret move: the touches are only replaced
    // (and the stylesheet regenerated) when a new agent batch arrives.
    const touched = this.touches.update(states, this.doc.clientID);
    this.update({
      peers: peersFromAwareness(states, this.doc.clientID, this.userId),
      ...(touched ? { agentTouches: this.touches.touches() } : {}),
    });
    if (touched) this.scheduleTouchExpiry();
  }

  /** Drop each agent touch when it expires (its fade has finished by then). */
  private scheduleTouchExpiry() {
    if (this.touchTimer) clearTimeout(this.touchTimer);
    this.touchTimer = null;
    const next = this.touches.nextExpiryIn();
    if (next === null || this.destroyed) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      if (this.destroyed) return;
      if (this.touches.sweep()) this.update({ agentTouches: this.touches.touches() });
      this.scheduleTouchExpiry();
    }, next + 20);
  }

  private update(patch: Partial<CollabSessionState>) {
    if (this.destroyed) return;
    // A refused session stays refused: late provider events do not revive it.
    if (this.state.rejected && patch.status && patch.status !== 'disconnected') return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
