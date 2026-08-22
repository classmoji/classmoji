/* eslint-disable import/no-unresolved -- virtual modules resolved by Vite */
import { createRequestHandler } from '@react-router/express';

import { buildSiteLoadContext } from './siteHost.ts';

/**
 * The DEV React Router handler (prod builds its own in server.ts).
 *
 * `getLoadContext` must match server.ts exactly. The custom-domain marker is
 * stamped on the Express request by `rewriteSiteRequests` in the outer server
 * and read back here; wiring it in only one of the two entry points would leave
 * canonical-URL behaviour silently different between dev and production, which
 * is the class of bug nobody finds until it is live.
 *
 * This module is loaded through Vite while the middleware runs under bare node,
 * so the two hold SEPARATE instances of siteHost.ts. That is fine, and is
 * exactly why the marker is a plain string property on the request rather than
 * a Symbol — see CUSTOM_DOMAIN_REQUEST_KEY.
 */
export const app = createRequestHandler({
  // In dev, Vite handles the build via virtual module
  build: () => import('virtual:react-router/server-build'),
  getLoadContext: req => buildSiteLoadContext(req),
});
