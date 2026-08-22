import {
  Outlet,
  data,
  isRouteErrorResponse,
  useLoaderData,
  useMatches,
  useRouteError,
} from 'react-router';
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from 'react-router';

import { IdentityBar, SiteFooter, SiteNotice } from './chrome.tsx';
import { routeSiteHeaders, siteHeaders } from './headers.server.ts';
import { isMember, publicPathOf, resolveSiteContext } from './tenant.server.ts';
import { signInPathFor } from './returnTo.ts';
import { SITE_STYLES } from './styles.ts';

/**
 * The class-site shell: identity bar, content, footer — and the single place
 * the tenant is resolved for a request.
 *
 * Everything under `/_site/:subdomain` nests here. The loader's only job is to
 * force `resolveSiteContext` to run (memoized on the Request, so the child
 * loader running in parallel shares this exact lookup) and to hand the chrome
 * the two or three strings it needs.
 */

export const loader = async (args: LoaderFunctionArgs) => {
  const { request, params } = args;
  const { site, viewer, memberLinkOrigin } = await resolveSiteContext(args);

  const url = new URL(request.url);
  // The visitor-facing path, not the internal `/_site/...` one the middleware
  // rewrote to — that prefix must never appear in a link or a redirect.
  const publicPath = publicPathOf(url.pathname, params.subdomain!) + url.search;

  return data(
    {
      courseName: site.classroom.name,
      memberName: isMember(viewer) ? viewer.name || viewer.login : null,
      // Always offer a way into the app. Points at the role-agnostic `/app`
      // bridge (not a role-specific dashboard URL) so this link is identical
      // for every viewer and stays safe to embed in the anonymous, cacheable
      // HTML — the bridge resolves the real destination per request.
      //
      // `memberLinkOrigin` is empty on the canonical subdomain, so these stay
      // the relative URLs they have always been. On a custom domain it is the
      // subdomain's absolute origin, because that is where the session lives:
      // a relative `/sign-in` on cs52.me would start an OAuth round trip whose
      // cookie the custom domain can never see.
      appHref: `${memberLinkOrigin}/app`,
      signInHref: viewer.userId ? null : `${memberLinkOrigin}${signInPathFor(publicPath)}`,
    },
    {
      // The shell itself is never the cache decision — the leaf route's
      // headers export wins. This set exists so a leaf that somehow returns
      // nothing still carries the security baseline.
      headers: siteHeaders({ request, cacheable: false, noindex: false }),
    }
  );
};

export const headers: HeadersFunction = args => routeSiteHeaders(args);

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const courseName = data?.courseName;
  return courseName ? [{ title: courseName }] : [{ title: 'Class site' }];
};

const SiteLayout = () => {
  const data = useLoaderData<typeof loader>();

  // The current page's title lives in the leaf route's loader data, not here.
  // page.tsx marks itself with `handle.siteBreadcrumb`; read it (SSR-only, no
  // hydration) so the identity bar can show `{course} › {page}`. Null on the
  // home page and on non-page routes, which collapses the crumb to the name.
  const matches = useMatches();
  const pageMatch = matches.find(
    m => (m.handle as { siteBreadcrumb?: boolean } | undefined)?.siteBreadcrumb
  );
  const pageData = pageMatch?.data as { title?: string; isHomePage?: boolean } | undefined;
  const currentPageTitle = pageData && !pageData.isHomePage ? (pageData.title ?? null) : null;

  return (
    <div className="flex min-h-screen flex-col">
      {/* Inlined rather than imported — see styles.ts for why a route-module
          stylesheet does not reach these pages. */}
      <style dangerouslySetInnerHTML={{ __html: SITE_STYLES }} />
      <IdentityBar
        courseName={data.courseName}
        memberName={data.memberName}
        appHref={data.appHref}
        signInHref={data.signInHref}
        currentPageTitle={currentPageTitle}
      />
      <main className="flex-1">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
};

/**
 * Branded, script-less error states.
 *
 * A missing subdomain and a switched-off site render the same 404 shape on
 * purpose: telling a stranger "this subdomain exists but is disabled" is an
 * enumeration oracle over every course we host.
 */
export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      const unavailable = error.data === 'unavailable';
      return (
        <SiteNotice
          title={unavailable ? 'This site is unavailable' : "There's no site here"}
          message={
            unavailable
              ? 'The instructor has turned this course website off, or the course is no longer running.'
              : 'That address does not point at a Classmoji course website.'
          }
          action={{ href: 'https://classmoji.io', label: 'Go to Classmoji', external: true }}
        />
      );
    }

    if (error.status === 403) {
      return (
        <SiteNotice
          title="You do not have access to this page"
          message={
            typeof error.data === 'string' && error.data
              ? error.data
              : 'This page is limited to members of this class.'
          }
        />
      );
    }

    if (error.status === 503) {
      return (
        <SiteNotice
          title="This page is temporarily unavailable"
          message="The course content could not be loaded right now. Please try again in a few minutes."
        />
      );
    }
  }

  return (
    <SiteNotice
      title="Something went wrong"
      message="This page could not be rendered. Please try again in a few minutes."
    />
  );
}

export default SiteLayout;
