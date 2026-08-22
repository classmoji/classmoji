import { useCallback, useState } from 'react';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomMember } from '~/utils/routeAuth.server';
import { loadPagesNav } from '~/utils/pagesNav.server';
import { PageViewPanel, sitePageUrl, type PageNavMessage } from '~/components/features/pages';

/**
 * A single page, docked — the deep-link form of the Pages destination.
 *
 * This URL is load-bearing well beyond the sidebar: notification links land
 * here, the fallback directory links here, and it is where the peek drawer's ↗
 * points for a page with no public URL. It renders the SAME panel as the peek
 * drawer and the Pages view, so arriving by any of those routes looks like the
 * same place.
 *
 * Auth note: this used to call requireStudentAccess, which allows STUDENT only
 * — so the assistant route that re-exports it 403'd every assistant despite the
 * comment saying otherwise. Members are the right audience for reading a page.
 */
export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;
  const pageId = params.pageId!;

  const { classroom, membership } = await requireClassroomMember(request, classSlug);

  const page = await ClassmojiService.page.findById(pageId, { includeClassroom: false });

  if (!page || page.classroom_id !== classroom.id) {
    throw new Response('Page not found', { status: 404 });
  }

  // Drafts stay staff-only. (The pages app enforces this again on the embedded
  // request; this check is what keeps the app from framing a 403 at all.)
  const canViewDrafts = ['OWNER', 'TEACHER', 'ASSISTANT'].includes(membership?.role ?? '');
  if (page.is_draft && !canViewDrafts) {
    throw new Response('This page is not yet published', { status: 403 });
  }

  const pagesNav = await loadPagesNav(classroom.id);

  return {
    page: { id: page.id, title: page.title },
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    siteOrigin: pagesNav.siteOrigin,
    siteSlugByPageId: pagesNav.siteSlugByPageId,
  };
};

const Component = ({ loaderData, params }: Route.ComponentProps) => {
  const { page, pagesUrl, siteOrigin, siteSlugByPageId } = loaderData;
  const classSlug = params.class!;

  const [current, setCurrent] = useState({ pageId: page.id, title: page.title });
  const onNav = useCallback(
    (message: PageNavMessage) =>
      setCurrent(previous => ({
        pageId: message.pageId,
        title: message.title || previous.title,
      })),
    []
  );

  // No in-app fallback here: this IS the in-app view, so ↗ either offers the
  // public URL or nothing at all.
  const siteUrl = sitePageUrl(siteOrigin, siteSlugByPageId[current.pageId]);
  const openTarget = siteUrl ? { url: siteUrl, isSite: true } : null;

  return (
    <div className="min-h-full relative">
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">Pages</h1>
      </div>
      <div className="flex h-[calc(100vh-9.5rem)] min-h-[420px] flex-col overflow-hidden rounded-2xl bg-white ring-1 ring-stone-200 dark:bg-neutral-900 dark:ring-neutral-800">
        <PageViewPanel
          variant="docked"
          pagesUrl={pagesUrl}
          classSlug={classSlug}
          pageRef={page.id}
          title={current.title}
          openTarget={openTarget}
          onNav={onNav}
          homeRef={page.id}
          homeTitle={page.title}
        />
      </div>
    </div>
  );
};

export default Component;
