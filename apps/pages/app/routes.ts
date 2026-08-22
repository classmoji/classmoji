import { type RouteConfig, index, layout, prefix, route } from '@react-router/dev/routes';
import { flatRoutes } from '@react-router/fs-routes';

/**
 * Two route trees in one app.
 *
 * `flatRoutes()` keeps owning `app/routes/**` — the editor, the API routes and
 * health, all served from the canonical pages host, all unchanged.
 *
 * The `/_site/:subdomain` subtree is the class-website renderer. It is NOT
 * reachable from the canonical host: `server/siteHost.ts` 404s the prefix on
 * the way in, and only its own internal rewrite ever produces these paths (a
 * request for `cs52.classmoji.io/syllabus` arrives here as
 * `/_site/cs52/syllabus`). The subdomain is a route param rather than
 * per-request server state so every loader gets it through the ordinary
 * React Router plumbing.
 *
 * Static segments outrank `:pageSlug` in React Router's ranking regardless of
 * declaration order, which is what keeps `RESERVED_PAGE_SLUGS`
 * (app / classmoji / sign-in / schedule / robots.txt) from being shadowed by a
 * page that claims one as its slug.
 */
export default [
  ...(await flatRoutes()),

  ...prefix('_site/:subdomain', [
    // A resource route (no component): it answers with text/plain and has no
    // business rendering the site shell.
    route('robots.txt', 'site/robots.ts'),

    layout('site/layout.tsx', [
      index('site/home.tsx'),
      route('sign-in', 'site/sign-in.tsx'),
      route('schedule', 'site/schedule.tsx'),
      route('app', 'site/app.tsx'),
      route(':pageSlug', 'site/page.tsx'),
    ]),
  ]),
] satisfies RouteConfig;
