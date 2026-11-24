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
import { loadSitePageView, siteReaderPolicy, type SitePageRow } from './pageRender.server.ts';
import { siteArticleWidthClass } from './articleWidth.ts';
import { imagePreloadMeta, imagePreloadsFor } from './imagePreloads.ts';
import { pagesUrl } from './env.server.ts';
import { ClassmojiService } from '~/utils/db.server.ts';
import { LegacyPageNotice } from '~/components/LegacyPageNotice.tsx';
import { ReaderIsland } from '~/reader-island/ReaderIsland.tsx';

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
        title: null,
        island: null,
        assets: null,
        imagePreloads: [],
        coverImage: null,
        description: null,
        editHref: null,
        legacyNotice: false,
        // The landing has no page behind it; the default keeps its column
        // exactly where it has always been.
        widthClass: siteArticleWidthClass(null),
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

  const view = await loadSitePageView(args, context, home);

  return data(
    {
      kind: 'page' as const,
      courseName: site.classroom.name,
      canonical,
      signInHref,
      isAnonymous: !viewer.userId,
      title: view.title,
      coverImage: view.coverImage,
      island: view.island,
      assets: view.assets,
      // The first images of THIS viewer's payload, fetched while the island loads.
      imagePreloads: imagePreloadsFor(view.island.payload),
      // From the NON-member document, whoever is reading (pageRender.server.ts).
      description: view.description,
      editHref: isStaff(viewer) ? `${pagesUrl()}/${site.classroom.slug}/${home.id}` : null,
      // A page still in the old format renders empty; its staff are told why.
      // Staff are members, so this response is never shared-cacheable.
      legacyNotice: isStaff(viewer) && view.legacyFormat,
      // The home page is a page like any other, and it is the one most likely
      // to have been widened for a directory or a row of profiles.
      widthClass: siteArticleWidthClass(home.width),
    },
    {
      headers: siteHeaders({
        request,
        cacheable: home.is_public && !isMember(viewer),
        noindex: !home.is_public,
        reader: siteReaderPolicy(request, context),
      }),
    }
  );
};

export const headers: HeadersFunction = args => routeSiteHeaders(args);

export const meta: MetaFunction<typeof loader> = ({ loaderData }) => {
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
    ...imagePreloadMeta(loaderData.imagePreloads ?? []),
  ];
};

const SiteHome = () => {
  const {
    kind,
    courseName,
    title,
    coverImage,
    island,
    assets,
    editHref,
    isAnonymous,
    signInHref,
    widthClass,
    legacyNotice,
  } = useLoaderData<typeof loader>();

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
          // navigate to anyway — and the landing ships no client bundle.
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
      <div className={`site-article mx-auto ${widthClass} px-4 pb-16 sm:px-6`}>
        <div className={coverImage?.url ? 'pt-10' : 'pt-14'}>
          {editHref ? <EditPagePill href={editHref} /> : null}
          <h1 className="mb-6 text-4xl font-bold text-gray-900 sm:text-5xl dark:text-white">
            {title}
          </h1>
        </div>
        {legacyNotice ? <LegacyPageNotice layout="inline" /> : null}
        {/* The document: the shared reader, mounted by the reader island. */}
        {island && assets ? (
          <ReaderIsland
            assets={assets}
            data={island}
            className="site-reader-root"
            stalledFallback
          />
        ) : null}
      </div>
    </article>
  );
};

export default SiteHome;
