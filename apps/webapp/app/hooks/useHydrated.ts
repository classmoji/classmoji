/**
 * Vendored from remix-utils 7.7.0 (`remix-utils/use-hydrated`) by Sergio
 * Xalambrí, MIT License. Copyright (c) 2021 Sergio Xalambrí.
 */
import { useSyncExternalStore } from 'react';

function subscribe() {
  return () => {};
}

/**
 * Return a boolean indicating if the JS has been hydrated already.
 * When doing Server-Side Rendering, the result will always be false.
 * When doing Client-Side Rendering, the result will always be false on the
 * first render and true from then on. Even if a new component renders it will
 * always start with true.
 *
 * Example: Disable a button that needs JS to work.
 * ```tsx
 * let hydrated = useHydrated();
 * return (
 *   <button type="button" disabled={!hydrated} onClick={doSomethingCustom}>
 *     Click me
 *   </button>
 * );
 * ```
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}
