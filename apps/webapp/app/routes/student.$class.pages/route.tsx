import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { IconFileText } from '@tabler/icons-react';
import type { Route } from './+types/route';
import getPrisma from '@classmoji/database';
import { requireClassroomMember } from '~/utils/routeAuth.server';
import { loadPagesNav } from '~/utils/pagesNav.server';
import {
  PageViewPanel,
  inAppPageUrl,
  resolveOpenTarget,
  sitePageUrl,
  type PageNavMessage,
} from '~/components/features/pages';

/**
 * The Pages destination (mockup S5b).
 *
 * It is NOT a list of pages. When the class has a site home page, this route
 * docks that page full-width and navigation happens INSIDE it, through the
 * directory hub the instructor authored — exactly how the public site
 * navigates. "The page is the navigation."
 *
 * The list only appears as a fallback, for a class that has pages but has never
 * nominated a front page. Losing the list is deliberate: a hub the instructor
 * curated beats an alphabetical dump of every page they ever wrote.
 */
export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;
  // Members, not students-only: the assistant route re-exports this loader, and
  // owners routinely browse /student/... to see what their class sees.
  const { classroom } = await requireClassroomMember(request, classSlug);

  const pagesNav = await loadPagesNav(classroom.id);

  // The home page is what makes this a docked reader rather than a list, and it
  // counts whether or not the site is switched on — publishing to the web and
  // choosing a front page are separate decisions (see site.service).
  const homePage = pagesNav.homePageId
    ? await getPrisma().page.findFirst({
        where: { id: pagesNav.homePageId, classroom_id: classroom.id, is_draft: false },
        select: { id: true, title: true, slug: true },
      })
    : null;

  // Only read when there is no front page to dock — the fallback directory.
  const pages = homePage
    ? []
    : await getPrisma().page.findMany({
        where: { classroom_id: classroom.id, is_draft: false },
        select: { id: true, title: true },
        orderBy: [{ menu_order: 'asc' }, { title: 'asc' }],
      });

  return {
    homePage,
    pages,
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    siteOrigin: pagesNav.siteOrigin,
    siteSlugByPageId: pagesNav.siteSlugByPageId,
    rolePath: new URL(request.url).pathname.startsWith('/assistant') ? '/assistant' : '/student',
  };
};

const StudentPages = ({ loaderData, params }: Route.ComponentProps) => {
  const { homePage, pages, pagesUrl, siteOrigin, siteSlugByPageId, rolePath } = loaderData;
  const classSlug = params.class!;

  // Follows the reader as it moves through the hub, so the header title and the
  // ↗ target describe what is actually on screen.
  const [current, setCurrent] = useState<{ pageId: string; title: string } | null>(
    homePage ? { pageId: homePage.id, title: homePage.title } : null
  );
  const onNav = useCallback(
    (message: PageNavMessage) => setCurrent({ pageId: message.pageId, title: message.title || '' }),
    []
  );

  const Title = (
    <div className="flex items-center justify-between gap-3 mt-2 mb-4">
      <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">Pages</h1>
    </div>
  );

  if (homePage) {
    // Docked: ↗ only exists when there is a live site. It prefers the current
    // page's public URL and falls back to the site root, never to an in-app
    // link — the docked view IS the in-app view.
    const siteUrl = current ? sitePageUrl(siteOrigin, siteSlugByPageId[current.pageId]) : '';
    const openTarget = siteOrigin ? { url: siteUrl || siteOrigin, isSite: true } : null;

    return (
      <div className="min-h-full relative">
        {Title}
        <div className="flex h-[calc(100vh-9.5rem)] min-h-[420px] flex-col overflow-hidden rounded-2xl bg-white ring-1 ring-stone-200 dark:bg-neutral-900 dark:ring-neutral-800">
          <PageViewPanel
            variant="docked"
            pagesUrl={pagesUrl}
            classSlug={classSlug}
            pageRef={homePage.id}
            title={current?.title || homePage.title}
            openTarget={openTarget}
            onNav={onNav}
            homeRef={homePage.id}
            homeTitle={homePage.title}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full relative">
      {Title}
      <div className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
        {pages.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <div className="font-medium">No pages yet</div>
            <div className="text-sm">Your instructor hasn&apos;t published any pages.</div>
          </div>
        ) : (
          <>
            <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
              Your instructor hasn&apos;t chosen a front page for this class yet.
            </p>
            <ul className="divide-y divide-stone-200 dark:divide-neutral-800">
              {pages.map(page => {
                const fallback = inAppPageUrl(rolePath, classSlug, page.id);
                const target = resolveOpenTarget({
                  siteOrigin,
                  siteSlugByPageId,
                  pageId: page.id,
                  fallbackUrl: fallback,
                });
                return (
                  <li key={page.id}>
                    <Link
                      to={fallback}
                      className="flex items-center gap-2.5 px-1 py-2.5 text-sm text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
                      data-cm-page-row={page.id}
                      data-cm-page-site={target.isSite ? 'true' : undefined}
                    >
                      <IconFileText
                        size={18}
                        strokeWidth={1.75}
                        className="shrink-0 text-gray-400"
                      />
                      <span className="truncate">{page.title}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
};

export default StudentPages;
