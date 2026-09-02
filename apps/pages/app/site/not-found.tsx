import type { HeadersFunction, LoaderFunctionArgs } from 'react-router';

import { routeSiteHeaders, siteHeaders } from './headers.server.ts';

/**
 * The catch-all inside the class-site shell: any URL on a course site that
 * matches no other route.
 *
 * ── What this fixes ────────────────────────────────────────────────────────
 * `/{pageSlug}` already 404s properly for a slug nobody authored — page.tsx
 * throws a 404 Response and the layout's ErrorBoundary renders the branded
 * notice. But anything with a SECOND segment
 * (`cs52.classmoji.io/dartmouth-cs52-26f/forms/cs52-waitlist`, a real link
 * somebody shared) matched nothing at all, so React Router's built-in 404
 * bubbled past the layout to the ROOT boundary — which rendered "This page is
 * unavailable / Try again in a moment." A mistyped link read as an outage, and
 * "try again" is advice that can never work.
 *
 * Throwing the same 404 as page.tsx puts every unmatched address through the
 * one boundary that already knows how to say "there's nothing here", with the
 * site's CSP and `no-store`/`noindex` headers attached.
 *
 * ── Ranking ────────────────────────────────────────────────────────────────
 * A splat scores LOWEST in React Router's ranking (`splatPenalty`), so it can
 * never shadow its siblings: on `/_site/:subdomain/…`, `forms/*` scores 27 and
 * `:pageSlug` 21 against this route's 16, and the index route outranks it on
 * the bare site root. `tests/unit/site-routes.spec.ts` asserts that against the
 * real route config rather than trusting the arithmetic.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  // Byte-identical to page.tsx's "no such page" refusal: same status, same
  // `error.data`, so the layout's ErrorBoundary renders ONE not-found for both
  // and there is no second copy to keep in sync.
  throw new Response('missing', {
    status: 404,
    headers: siteHeaders({ request, cacheable: false, noindex: true }),
  });
};

export const headers: HeadersFunction = args => routeSiteHeaders(args);

/**
 * Never rendered — the loader always throws — but it must EXIST.
 *
 * React Router's server treats a leaf match whose module exports neither
 * `default` nor `ErrorBoundary` as a resource request: the loader's thrown
 * Response is sent back verbatim, which here would be a bare `text/plain`
 * `missing` body instead of the site's branded 404 document. So this is not a
 * stray export to tidy away into a resource route like `robots.ts`; it is what
 * routes the throw through the layout's boundary.
 *
 * Returning null keeps the page script-less, exactly like the rest of the tree.
 */
const SiteNotFound = () => null;

export default SiteNotFound;
