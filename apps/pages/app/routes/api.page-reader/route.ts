import { sitePageReaderResponse } from '~/site/pageReaderApi.server.ts';

/**
 * GET /api/page-reader?pageId= — a class-site member's reader payload, after
 * an unlock (`app/site/pageReaderApi.server.ts`). Reachable only on a
 * class-site subdomain, where the host middleware passes it through; 404
 * everywhere else. A resource route (no component): no sign-in redirect.
 */
export const loader = ({ request, context }: { request: Request; context?: unknown }) =>
  sitePageReaderResponse({ request, context });
