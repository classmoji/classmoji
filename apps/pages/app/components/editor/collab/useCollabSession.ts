import { useEffect, useState, useSyncExternalStore } from 'react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { CollabLoaderData } from '@classmoji/collab';

import {
  CollabSession,
  INITIAL_SESSION_STATE,
  type CollabProviderFactory,
  type CollabSessionState,
} from './collabSession.ts';

/** The real provider: Hocuspocus 4.7, one socket per page. */
export const hocuspocusProviderFactory: CollabProviderFactory = ({
  url,
  name,
  document,
  token,
  onSynced,
  onStatus,
  onUnsyncedChanges,
  onAuthenticationFailed,
  onClose,
  onStateless,
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
    onClose: ({ event }) => onClose({ event }),
    onStateless: ({ payload }) => onStateless({ payload }),
  });

const noopSubscribe = () => () => {};
const initialState = () => INITIAL_SESSION_STATE;

/**
 * The live session for a page, or null outside collab mode (and for the first
 * render, before the effect has opened the room — the server render never
 * opens one).
 *
 * Keyed by the room name: a new page or a new epoch closes the old room and
 * opens the new one. Created in an effect and destroyed in its cleanup, so a
 * render never creates a document and StrictMode's double effect leaves
 * nothing connected.
 */
export function useCollabSession(
  collab: CollabLoaderData | null,
  createProvider: CollabProviderFactory = hocuspocusProviderFactory
): { session: CollabSession | null; state: CollabSessionState } {
  const [session, setSession] = useState<CollabSession | null>(null);
  const room = collab?.room ?? null;
  const wsUrl = collab?.wsUrl ?? null;

  useEffect(() => {
    if (!collab || !room || !wsUrl) {
      setSession(null);
      return;
    }
    const created = new CollabSession(collab, createProvider);
    setSession(created);
    return () => {
      created.destroy();
      setSession(current => (current === created ? null : current));
    };
    // The room (page + epoch) and the server identify the session; the user
    // and schema version are fixed for a loaded route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, wsUrl, createProvider]);

  const state = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getState ?? initialState,
    initialState
  );
  return { session: session && !session.isDestroyed ? session : null, state };
}
