import { createContext, RouterContextProvider, type RouterContext } from 'react-router';

import type { SiteLoadContext } from './siteHost.ts';

/**
 * The React Router context the host middleware's marker travels in.
 *
 * React Router hands loaders a `RouterContextProvider`, and a value in it is
 * found by the identity of its key. Two copies of this module run in one
 * process: the server entry's (server.ts in production, server/app.ts in dev),
 * which builds the context, and the app's own (app/site/tenant.server.ts, inside
 * the server build), which reads it. So the key is kept on `globalThis`, and
 * both copies use the same one.
 *
 * Loaded by server.ts under `node --experimental-strip-types`, like siteHost.ts:
 * type-only imports besides `react-router`. It lives in server/ because the
 * production image copies that directory and not app/.
 */
const KEY = Symbol.for('classmoji.pages.siteLoadContext');
const registry = globalThis as unknown as Record<
  symbol,
  RouterContext<SiteLoadContext> | undefined
>;

export const siteLoadContext: RouterContext<SiteLoadContext> = (registry[KEY] ??=
  createContext<SiteLoadContext>({ customDomain: null, siteSubdomain: null }));

/** `getLoadContext`'s answer for a request whose marker is `value`. */
export function siteRouterContext(value: SiteLoadContext): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(siteLoadContext, value);
  return context;
}
