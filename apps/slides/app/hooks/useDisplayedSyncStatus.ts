import { useEffect, useReducer } from 'react';
import { initialSyncDisplay, syncDisplayDeadline, syncDisplayReducer } from '@classmoji/collab';

import type { SyncStatus } from '~/utils/collab/collab';

/**
 * The sync status the header shows: `syncing` only once the exact status has
 * stayed `syncing` for a second (a keystroke's round trip never shows), held
 * briefly once shown; `offline` at once. The exact status keeps driving the
 * leave-page warning and Save version — only the display is debounced.
 */
export function useDisplayedSyncStatus(raw: SyncStatus): SyncStatus {
  const [state, dispatch] = useReducer(syncDisplayReducer, raw, initialSyncDisplay);

  useEffect(() => {
    dispatch({ type: 'raw', raw, now: Date.now() });
  }, [raw]);

  const deadline = syncDisplayDeadline(state);
  useEffect(() => {
    if (deadline === null) return;
    const timer = window.setTimeout(
      () => dispatch({ type: 'tick', now: Math.max(Date.now(), deadline) }),
      Math.max(0, deadline - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [deadline]);

  return state.shown;
}
