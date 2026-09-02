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
 * (app / classmoji / sign-in / schedule / forms / robots.txt) from being
 * shadowed by a page that claims one as its slug.
 *
 * The `/:classroomSlug/forms` subtree is declared here too, with its modules
 * under `app/forms/**`, for the same reason the site tree is: it must NOT
 * inherit the `$classroomSlug` layout that `flatRoutes` builds from
 * `app/routes/`. That layout loads the classroom's page list and wraps
 * everything beneath it in `PagesSidebar` — chrome a form builder does not want
 * and a public fill page must never show. Naming a flat file
 * `$classroomSlug_.forms` would escape it as well, but only for as long as
 * every future contributor remembers the trailing underscore; living outside
 * `app/routes/` makes the escape structural and visible in one file. The same
 * static-beats-dynamic ranking keeps `/cs52/forms` from matching the page-view
 * route, and `forms/new` ahead of `forms/:formSlug`.
 */
export default [
  ...(await flatRoutes()),

  route(':classroomSlug/forms', 'forms/admin/list.tsx', [
    // The new-form drawer renders into the list's `<Outlet />`, so the table
    // stays on screen behind it.
    route('new', 'forms/admin/new.tsx'),
  ]),
  route(':classroomSlug/forms/:formSlug/edit', 'forms/admin/builder.tsx'),
  route(':classroomSlug/forms/:formSlug/responses', 'forms/admin/responses.tsx'),
  // A resource route (no component): it answers with text/csv and has no
  // business rendering anything. Static `responses` outranks `:formSlug`, and
  // `RESERVED_FORM_SLUGS` refuses `responses` at create, so neither of these can
  // ever be shadowed by a real form.
  route(':classroomSlug/forms/:formSlug/responses/export', 'forms/admin/responsesExport.ts'),

  // The public fill surfaces, exempted from the root login redirect (see
  // app/utils/formsPaths.ts). Placeholders until the renderer lands; they are
  // declared NOW so the routing skeleton and the gate are settled together
  // rather than the exemption arriving ahead of the routes it describes.
  route(':classroomSlug/forms/:formSlug', 'forms/fill/fill.tsx'),
  route(':classroomSlug/forms/:formSlug/verify', 'forms/fill/verify.tsx'),
  // A resource route (no component): the fill page polls it for a bounce on the
  // send it just caused. It answers JSON, takes NO address, and is keyed only
  // on the HttpOnly watch cookie — see the module for why that is what keeps it
  // from being a mailbox oracle. Static `delivery` outranks `:formSlug`.
  route(':classroomSlug/forms/:formSlug/delivery', 'forms/fill/delivery.ts'),

  ...prefix('_site/:subdomain', [
    // A resource route (no component): it answers with text/plain and has no
    // business rendering the site shell.
    route('robots.txt', 'site/robots.ts'),

    // The short-link bridge: `cs52.classmoji.io/forms/waitlist` 302s to the
    // canonical host's `/{classroomSlug}/forms/waitlist`. A resource route for
    // the same reason robots.txt is one — it answers with a `Location` header,
    // so there is nothing for the site layout to wrap. Outside the layout it
    // also skips that loader's page-index query on a response nobody renders.
    // Static `forms` outranks `:pageSlug`, and `forms` is in
    // RESERVED_PAGE_SLUGS so no page can hold the segment either.
    route('forms/*', 'site/forms.ts'),

    layout('site/layout.tsx', [
      index('site/home.tsx'),
      route('sign-in', 'site/sign-in.tsx'),
      route('schedule', 'site/schedule.tsx'),
      route('app', 'site/app.tsx'),
      route(':pageSlug', 'site/page.tsx'),

      // Everything else on a course site. Inside the layout ON PURPOSE: the
      // shell's ErrorBoundary is the only thing that renders a branded 404, and
      // without this route a two-segment address matched nothing and fell all
      // the way to the ROOT boundary's generic "try again in a moment".
      //
      // A splat carries `splatPenalty` and therefore always ranks LAST, so it
      // cannot shadow a sibling: `forms/*`, `:pageSlug`, the static segments and
      // the index all outrank it. Asserted in `tests/unit/site-routes.spec.ts`.
      route('*', 'site/not-found.tsx'),
    ]),
  ]),
] satisfies RouteConfig;
