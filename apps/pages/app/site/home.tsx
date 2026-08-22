import { data, useLoaderData } from 'react-router';
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from 'react-router';

import { CoverImage, EditPagePill } from './chrome.tsx';
import { routeSiteHeaders, siteHeaders } from './headers.server.ts';
import {
  hasPublicPages,
  isMember,
  isStaff,
  loadSitePageIndex,
  resolveSiteContext,
} from './tenant.server.ts';
import { describeFromHtml, renderPageForViewer, type SitePageRow } from './pageRender.server.ts';
import { pagesUrl } from './env.server.ts';
import { ClassmojiService } from '~/utils/db.server.ts';

/**
 * `/` — the site root.
 *
 * The home page is an ordinary page the instructor nominated, so the happy
 * path is exactly the `/{slug}` render. Two things make this route more than
 * an alias:
 *
 *  - **A live site can legitimately have no home page.** The FK from
 *    `classroom_sites.home_page_id` is ON DELETE SET NULL, so deleting the
 *    nominated page leaves an enabled site pointing at nothing rather than
 *    silently releasing the subdomain. That shape must render a landing page,
 *    never a 500.
 *  - **The home page may be members-only.** `getHomePageForViewer` returns
 *    null for an anonymous visitor in that case, and the same minimal landing
 *    covers it — without ever revealing the page's title.
 *
 * When the site has no public pages at all, the landing is also `noindex`:
 * a private course should not turn up in search results as a permanently
 * empty shell carrying its own name.
 */
export const loader = async (args: LoaderFunctionArgs) => {
  const { request } = args;
  const context = await resolveSiteContext(args);
  const { site, viewer, memberLinkOrigin, seoOrigin } = context;

  const home = (await ClassmojiService.site.getHomePageForViewer(
    site,
    viewer.role
  )) as SitePageRow | null;

  // `seoOrigin`, not the subdomain: a verified custom domain is the address
  // both hostnames advertise. See canonicalOriginForSite.
  const canonical = seoOrigin ? `${seoOrigin}/` : null;
  // Absolute on a custom domain (no session can exist there), relative on the
  // canonical subdomain.
  const signInHref = `${memberLinkOrigin}/sign-in`;

  if (!home) {
    const pages = await loadSitePageIndex(args, site.classroom_id);
    const indexable = hasPublicPages(pages);

    return data(
      {
        kind: 'landing' as const,
        courseName: site.classroom.name,
        canonical,
        signInHref,
        isAnonymous: !viewer.userId,
        html: null,
        title: null,
        coverImage: null,
        description: null,
        editHref: null,
      },
      {
        headers: siteHeaders({
          request,
          cacheable: !isMember(viewer),
          noindex: !indexable,
        }),
      }
    );
  }

  const rendered = await renderPageForViewer(args, context, home);

  return data(
    {
      kind: 'page' as const,
      courseName: site.classroom.name,
      canonical,
      signInHref,
      isAnonymous: !viewer.userId,
      html: rendered.html,
      title: rendered.title,
      coverImage: rendered.coverImage,
      description: describeFromHtml(rendered.html),
      editHref: isStaff(viewer) ? `${pagesUrl()}/${site.classroom.slug}/${home.id}` : null,
    },
    {
      headers: siteHeaders({
        request,
        cacheable: home.is_public && !isMember(viewer),
        noindex: !home.is_public,
      }),
    }
  );
};

export const headers: HeadersFunction = args => routeSiteHeaders(args);

export const meta: MetaFunction<typeof loader> = ({ data: loaderData }) => {
  if (!loaderData) return [{ title: 'Class site' }];

  const title = loaderData.courseName;
  return [
    { title },
    { property: 'og:title', content: title },
    { property: 'og:type', content: 'website' },
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

const SiteHome = () => {
  const { kind, courseName, title, html, coverImage, editHref, isAnonymous, signInHref } =
    useLoaderData<typeof loader>();

  if (kind === 'landing') {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center px-4 text-center">
        <h1 className="mb-3 text-3xl font-bold text-gray-900 dark:text-white">{courseName}</h1>
        <p className="text-gray-600 dark:text-gray-400">
          {isAnonymous
            ? 'This course website is not open to the public yet.'
            : 'This course website does not have a front page yet.'}
        </p>
        {isAnonymous ? (
          // A plain anchor, not <Link>: on a custom domain this href is an
          // absolute URL to another origin, which client-side routing cannot
          // navigate to anyway — and these pages ship no client bundle.
          <a
            href={signInHref}
            className="mt-6 rounded-full bg-gray-900 px-4 py-2 text-sm text-white no-underline hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
          >
            Sign in
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <article>
      <CoverImage coverImage={coverImage} />
      <div className="site-article mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        <div className={coverImage?.url ? 'pt-10' : 'pt-14'}>
          {editHref ? <EditPagePill href={editHref} /> : null}
          <h1 className="mb-6 text-4xl font-bold text-gray-900 sm:text-5xl dark:text-white">
            {title}
          </h1>
        </div>
        {/* Server-serialized by BlockNote with the static viewer schema; this
            page ships no client bundle to hydrate it. */}
        <div dangerouslySetInnerHTML={{ __html: html! }} />
      </div>
    </article>
  );
};

export default SiteHome;
