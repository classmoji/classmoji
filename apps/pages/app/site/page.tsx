import { data, redirect, useLoaderData } from 'react-router';
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from 'react-router';

import { CoverImage, EditPagePill } from './chrome.tsx';
import { routeSiteHeaders, siteHeaders } from './headers.server.ts';
import { isMember, isStaff, publicPathOf, resolveSiteContext } from './tenant.server.ts';
import {
  describeFromHtml,
  renderPageForViewer,
  siteArticleWidthClass,
  type SitePageRow,
} from './pageRender.server.ts';
import { pagesUrl } from './env.server.ts';
import { signInPathFor } from './returnTo.ts';
import { ClassmojiService } from '~/utils/db.server.ts';

/**
 * `/{pageSlug}` — one authored page, rendered as static HTML.
 *
 * The three refusals are deliberately different responses, because they are
 * three different situations for the person reading:
 *
 *  - **not a page** → 404. Nothing to say.
 *  - **members-only, and you are anonymous** → 302 to the sign-in
 *    interstitial. Signing in might genuinely fix it.
 *  - **members-only, and you are signed in but not enrolled** → 403 naming
 *    the account. Signing in again will not help, and silently bouncing such
 *    a visitor back through OAuth is the loop that makes people email us.
 *
 * A draft is a 404 for everyone including its author — see
 * `isPageVisibleOnSite`; the public site is the published artifact, and staff
 * preview drafts in the app where the URL is unmistakably internal.
 */
export const loader = async (args: LoaderFunctionArgs) => {
  const { request, params } = args;
  const context = await resolveSiteContext(args);
  const { site, viewer, memberLinkOrigin, seoOrigin } = context;

  const url = new URL(request.url);
  const publicPath = publicPathOf(url.pathname, params.subdomain!);

  const page = (await ClassmojiService.site.getPageBySlugForSite(
    site.classroom_id,
    params.pageSlug!
  )) as SitePageRow | null;

  if (!page || page.is_draft) {
    throw new Response('missing', {
      status: 404,
      headers: siteHeaders({ request, cacheable: false, noindex: true }),
    });
  }

  if (!ClassmojiService.site.isPageVisibleOnSite(page, viewer.role)) {
    if (!viewer.userId) {
      // On a custom domain every visitor is anonymous by construction, and
      // `memberLinkOrigin` sends them to the canonical subdomain's
      // interstitial — the one host where signing in can actually produce a
      // session for this classroom. On the subdomain it is empty and this stays
      // the same relative redirect it has always been.
      throw redirect(`${memberLinkOrigin}${signInPathFor(publicPath)}`, {
        headers: siteHeaders({ request, cacheable: false, noindex: true }),
      });
    }
    throw new Response(
      `Signed in as ${viewer.login || viewer.name || 'your account'} — not a member of this class.`,
      { status: 403, headers: siteHeaders({ request, cacheable: false, noindex: true }) }
    );
  }

  const rendered = await renderPageForViewer(args, context, page);

  return data(
    {
      courseName: site.classroom.name,
      title: rendered.title,
      // The home page is also servable at its own slug (sitePagePath links to
      // the slug, not `/`), so a route-based "this is a sub-page" test is not
      // enough — an authored link to the home page would render "Home › Home".
      // Gate the breadcrumb on identity with the nominated front page instead.
      isHomePage: page.id === site.home_page_id,
      html: rendered.html,
      coverImage: rendered.coverImage,
      // The width the page was AUTHORED at, so the site column matches the
      // editor's. Resolved here because the page row exists in the loader and
      // nowhere else on this route.
      widthClass: siteArticleWidthClass(page.width),
      description: describeFromHtml(rendered.html),
      // The whole point of a custom domain is that it becomes the address of
      // the course, so a verified one is what `rel=canonical`/`og:url` name —
      // from BOTH hostnames. `seoOrigin` is the single decision; see
      // canonicalOriginForSite.
      //
      // Members-only pages are `noindex` below, so this only ever names a URL
      // that can actually serve the content a crawler would be told about.
      canonical: seoOrigin ? `${seoOrigin}${publicPath}` : null,
      // Staff edit their pages in the app, never here. The pill is the whole
      // bridge between the two surfaces.
      editHref: isStaff(viewer) ? `${pagesUrl()}/${site.classroom.slug}/${page.id}` : null,
    },
    {
      // Only a public page read by an anonymous visitor is shared-cacheable;
      // siteHeaders downgrades this anyway when a session cookie is present.
      headers: siteHeaders({
        request,
        cacheable: page.is_public && !isMember(viewer),
        noindex: !page.is_public,
      }),
    }
  );
};

export const headers: HeadersFunction = args => routeSiteHeaders(args);

/**
 * Marks this route as the breadcrumb source: the layout reads the leaf match's
 * loader data (`title` + `isHomePage`) via `useMatches` and renders the inline
 * `{course} › {page}` crumb in the identity bar. Only page.tsx carries it, so
 * home/schedule/sign-in show the course name alone.
 */
export const handle = { siteBreadcrumb: true };

export const meta: MetaFunction<typeof loader> = ({ data: loaderData }) => {
  if (!loaderData) return [{ title: 'Page' }];

  const title = `${loaderData.title} — ${loaderData.courseName}`;
  return [
    { title },
    { property: 'og:title', content: title },
    { property: 'og:type', content: 'article' },
    ...(loaderData.description
      ? [
          { name: 'description', content: loaderData.description },
          { property: 'og:description', content: loaderData.description },
        ]
      : []),
    ...(loaderData.canonical
      ? [
          { property: 'og:url', content: loaderData.canonical },
          { tagName: 'link', rel: 'canonical', href: loaderData.canonical },
        ]
      : []),
  ];
};

const SitePage = () => {
  const { title, html, coverImage, editHref, widthClass } = useLoaderData<typeof loader>();

  return (
    <article>
      <CoverImage coverImage={coverImage} />
      <div className={`mx-auto ${widthClass} px-4 pb-16 sm:px-6 site-article`}>
        <div className={coverImage?.url ? 'pt-10' : 'pt-14'}>
          {editHref ? <EditPagePill href={editHref} /> : null}
          <h1 className="mb-6 text-4xl font-bold text-gray-900 sm:text-5xl dark:text-white">
            {title}
          </h1>
        </div>
        {/* The document is serialized server-side by BlockNote's own exporter
            with a schema whose every block renders static, sanitized markup —
            see viewerSchema.server.ts. There is no client bundle on this page
            to re-hydrate it with. */}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </article>
  );
};

export default SitePage;
