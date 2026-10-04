import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { CollabLoaderData } from '@classmoji/collab';

import { playableMediaUrl } from '~/utils/mediaClient';
import {
  DeckCollabSession,
  INITIAL_SESSION_STATE,
  type CollabProviderFactory,
  type CollabSessionState,
} from '~/utils/collab/session';
import { DeckBridge, type BridgeUiState } from '~/utils/collab/DeckBridge';

/** The real provider: Hocuspocus 4.7, one socket per deck. */
export const hocuspocusProviderFactory: CollabProviderFactory = ({
  url,
  name,
  document,
  token,
  onSynced,
  onStatus,
  onUnsyncedChanges,
  onAuthenticationFailed,
}) =>
  new HocuspocusProvider({
    url,
    name,
    document,
    token,
    onSynced,
    onStatus,
    onUnsyncedChanges,
    onAuthenticationFailed,
  });

const noopSubscribe = () => () => {};
const initialState = () => INITIAL_SESSION_STATE;

export const EMPTY_BRIDGE_STATE: BridgeUiState = {
  locks: {},
  heldSlideId: null,
  currentSlideId: null,
  revision: 0,
};

export interface UseDeckCollabArgs {
  collab: CollabLoaderData | null;
  /** Open the room (the first time the person starts editing). */
  active: boolean;
  slideId: string;
  mediaScope: { host: string | null | undefined; classroomId: string | null | undefined };
  notify(message: string): void;
}

/**
 * The live session for a deck and its editor bridge, or nulls outside collab
 * mode / before the room is opened. One provider per deck, created in an
 * effect (never in render) and destroyed in its cleanup; keyed by the room,
 * so a new epoch closes the old room first.
 */
export function useDeckCollab({ collab, active, slideId, mediaScope, notify }: UseDeckCollabArgs) {
  const [pair, setPair] = useState<{ session: DeckCollabSession; bridge: DeckBridge } | null>(null);
  const [bridgeState, setBridgeState] = useState<BridgeUiState>(EMPTY_BRIDGE_STATE);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const scopeRef = useRef(mediaScope);
  scopeRef.current = mediaScope;

  const room = collab?.room ?? null;
  const wsUrl = collab?.wsUrl ?? null;

  useEffect(() => {
    if (!collab || !room || !wsUrl || !active) return;
    const session = new DeckCollabSession(collab, hocuspocusProviderFactory);
    const bridge = new DeckBridge({
      session,
      mediaScope: scopeRef.current,
      resolveMedia: async refs => {
        const urls = await Promise.all(refs.map(ref => playableMediaUrl(slideId, ref)));
        return new Map(refs.map((ref, i) => [ref, urls[i]]));
      },
      notify: message => notifyRef.current(message),
      onState: setBridgeState,
    });
    setPair({ session, bridge });
    return () => {
      bridge.destroy();
      session.destroy();
      setPair(current => (current?.session === session ? null : current));
      setBridgeState(EMPTY_BRIDGE_STATE);
    };
    // The room (deck + epoch) and the server identify the session; the user
    // and schema version are fixed for a loaded route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, wsUrl, active, slideId]);

  const session = pair && !pair.session.isDestroyed ? pair.session : null;
  const state: CollabSessionState = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getState ?? initialState,
    initialState
  );
  return { session, bridge: session ? (pair?.bridge ?? null) : null, state, bridgeState };
}
