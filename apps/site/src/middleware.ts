import { defineMiddleware } from 'astro:middleware';

// Astro adds an image route (/_image) and a server-island route
// (/_server-islands/*) to every site with an adapter. This site renders all of
// its images at build time and has no server islands, so both stay off in
// production. Matching on the route (not the URL) covers every path that
// reaches them; `astro dev` still uses /_image.
const UNUSED_ROUTES = new Set(['/_image', '/_server-islands/[name]']);

export const onRequest = defineMiddleware((context, next) => {
  if (import.meta.env.PROD && UNUSED_ROUTES.has(context.routePattern)) {
    return new Response(null, { status: 404 });
  }
  return next();
});
