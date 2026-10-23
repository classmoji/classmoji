/**
 * The document's CSP nonce, provided by entry.server.tsx around the whole
 * render (so the root ErrorBoundary has it too, even when the root loader
 * threw). Undefined in the browser: browsers hide the nonce attribute once
 * the policy applies, and nothing rendered after hydration needs one.
 */

import { createContext, useContext } from 'react';

export const NonceContext = createContext<string | undefined>(undefined);

export function useNonce(): string | undefined {
  return useContext(NonceContext);
}
