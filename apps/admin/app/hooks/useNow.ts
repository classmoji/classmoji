import { useSyncExternalStore } from 'react';
import { useRouteLoaderData } from 'react-router';

import type { loader as rootLoader } from '~/root';

const subscribe = () => () => {};

/**
 * "Now", for render code that measures how long ago something happened.
 *
 * The server renders a page and the browser renders it again to hydrate it.
 * They read the clock a moment apart, so "59 min" on the server can be
 * "1 hour" in the browser; that text mismatch makes React throw the server
 * HTML away and re-render the whole document on the client. So while
 * hydrating, this returns the instant the server rendered at (the root
 * loader's `now`); on every render after that, the browser's clock.
 * useSyncExternalStore re-renders callers once hydration is done, so the
 * times freshen right away.
 */
export const useNow = (): Date => {
  const serverNow = useRouteLoaderData<typeof rootLoader>('root')?.now;
  const hydrating = useSyncExternalStore(
    subscribe,
    () => false,
    () => true
  );
  return hydrating && serverNow !== undefined ? new Date(serverNow) : new Date();
};
