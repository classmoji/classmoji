import { defineMiddleware } from 'astro:middleware';

// Astro adds an image route (/_image) and a server-island route
// (/_server-islands/*) to every site with an adapter. This site renders all of
// its images at build time and has no server islands, so both stay off in
// production. Matching on the route (not the URL) covers every path that
// reaches them; `astro dev` still uses /_image.
const UNUSED_ROUTES = new Set(['/_image', '/_server-islands/[name]']);

// The staging Worker (site.staging.classmoji.io) must stay out of search
// results. Static files get the header from dist/client/_headers
// (astro.config.mjs); this covers what the Worker answers itself. A build-time
// constant only: this file also loads in Node while pages prerender.
const NOINDEX = __CF_BUILD__ && __SITE_ENV__ === 'staging';

function noindex(response: Response): Response {
  if (!NOINDEX) return response;
  try {
    response.headers.set('X-Robots-Tag', 'noindex');
    return response;
  } catch {
    // Immutable headers (a fetched response): copy it.
    const copy = new Response(response.body, response);
    copy.headers.set('X-Robots-Tag', 'noindex');
    return copy;
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  if (import.meta.env.PROD && UNUSED_ROUTES.has(context.routePattern)) {
    return noindex(new Response(null, { status: 404 }));
  }
  return noindex(await next());
});
