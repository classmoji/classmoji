import { redirect } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import { siteFormsBridgePath } from '~/utils/formsPaths.ts';
import { siteHeaders } from './headers.server.ts';
import { resolveSiteContext } from './tenant.server.ts';
import { pagesUrl } from './env.server.ts';

/**
 * `/forms/…` on a class-site host — the short-link bridge.
 *
 * An instructor shares `cs52.classmoji.io/forms/cs52-waitlist`, because that is
 * the address of the course and nobody wants to paste a pages-host URL onto a
 * slide. The form itself is served from the canonical pages host at
 * `/{classroomSlug}/forms/{formSlug}`, and this route is the 302 between them.
 *
 * ── Why a redirect and not the form ────────────────────────────────────────
 * The `_site` tree is script-less SSR by design: a course site ships no
 * hydration payload, and its Content-Security-Policy says so. A form is the
 * opposite — a hydrated React route with client validation, a fetcher, and a
 * delivery poll. Serving it here would mean either lifting the site's script
 * rules for every tenant hostname, or maintaining a second, non-interactive
 * renderer for the same form. One hop to the surface that already exists is
 * cheaper than both, and it puts every submission on ONE origin, which is what
 * the submission origin check and the magic-link cookie both assume.
 *
 * Modelled on `site/app.tsx`, the other one-domain bridge, and like it never
 * cacheable and never indexed: the destination is derived per request and the
 * canonical URL of a form is the one it redirects to.
 *
 * A RESOURCE route (no component), like `robots.ts`: it has nothing to render
 * and no reason to run the site layout's loader for a response that is a
 * `Location` header.
 *
 * The bridge lives exactly as long as the site does. A disabled, archived or
 * unpublished site 404s here, because `resolveSiteContext` refuses it — a short
 * link is part of the site, not a second door around it.
 */
export const loader = async (args: LoaderFunctionArgs) => {
  const { request, params } = args;
  // Resolved before the shape check, and re-read from the database rather than
  // trusted from the routing snapshot, for the same reason every other site
  // loader does it: a hostname re-pointed at another classroom must never send
  // a visitor to the previous tenant's form.
  const { site } = await resolveSiteContext(args);
  const headers = siteHeaders({ request, cacheable: false, noindex: true });

  const path = siteFormsBridgePath(params['*'] ?? '');
  if (!path) return new Response('Not found', { status: 404, headers });

  // The query string is carried VERBATIM. `/verify?token=…` is the magic link
  // itself: a bridge that dropped the search would turn every emailed link on a
  // class-site host into an expired-link page.
  const { search } = new URL(request.url);

  return redirect(`${pagesUrl()}/${site.classroom.slug}/forms/${path}${search}`, {
    status: 302,
    headers,
  });
};
