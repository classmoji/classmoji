import { Outlet } from 'react-router';
import type { Route } from './+types/route';
import { CommonLayout, RequireRole } from '~/components';
import { PagePeekProvider } from '~/components/features/pages';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomMember } from '~/utils/routeAuth.server';
import { DEFAULT_NAV_VISIBILITY, navVisibilityFromSettings } from '~/utils/navVisibility';
import { EMPTY_PAGES_NAV, loadPagesNav } from '~/utils/pagesNav.server';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  const pagesUrl = process.env.PAGES_URL || 'http://localhost:7100';

  // Handle case where class param might not be present yet
  if (!classSlug) {
    return {
      recentViewers: [],
      pagesUrl,
      pagesNav: EMPTY_PAGES_NAV,
      navVisibility: DEFAULT_NAV_VISIBILITY,
    };
  }

  try {
    // SECURITY: Verify user is a member of this classroom before recording/fetching views
    const { userId, classroom } = await requireClassroomMember(request, classSlug);

    // Site row + published pages, for the single Pages nav entry and for the
    // peek drawer's ↗ target. Replaces the old per-page sidebar query.
    const pagesNav = await loadPagesNav(classroom.id);

    // Check if recent viewers feature is enabled (settings included from findBySlug)
    const recentViewersEnabled = classroom.settings?.recent_viewers_enabled ?? true;

    let recentViewers: {
      user: { id: string; name: string | null; login: string | null; avatar_url: string | null };
      lastViewedAt: Date;
      role?: string | null;
    }[] = [];

    // Normalize the current path for view tracking
    const url = new URL(request.url);
    const resourcePath = ClassmojiService.resourceView.normalizePath(url.pathname);

    // Fire-and-forget: record ALL views for analytics (non-blocking)
    Promise.resolve().then(() => {
      ClassmojiService.resourceView.recordView({
        resourcePath,
        userId,
        classroomId: classroom.id,
        viewedAsRole: 'STUDENT',
      });
    });

    if (recentViewersEnabled) {
      recentViewers = await ClassmojiService.resourceView.getRecentViewers({
        resourcePath,
        classroomId: classroom.id,
      });
    }

    return {
      recentViewers,
      pagesUrl,
      pagesNav,
      navVisibility: {
        ...navVisibilityFromSettings(classroom.settings),
        // Students only see published modules — hide the tab when there are none.
        hasModules: await ClassmojiService.module.hasModulesForClassroom(classSlug),
        hasPages: pagesNav.hasPages,
      },
    };
  } catch {
    // If classroom access fails, return empty data
    return {
      recentViewers: [],
      pagesUrl,
      pagesNav: EMPTY_PAGES_NAV,
      navVisibility: DEFAULT_NAV_VISIBILITY,
    };
  }
};

const Student = ({ loaderData, params }: Route.ComponentProps) => {
  const { recentViewers, pagesUrl, pagesNav, navVisibility } = loaderData;

  return (
    <CommonLayout recentViewers={recentViewers} pagesUrl={pagesUrl} navVisibility={navVisibility}>
      {/* Mounted here, inside the shell, so a page peeked from a module tree or
          a calendar event opens over the current view without a navigation. */}
      <PagePeekProvider
        classSlug={params.class ?? ''}
        rolePath="/student"
        pagesUrl={pagesUrl}
        siteOrigin={pagesNav.siteOrigin}
        siteSlugByPageId={pagesNav.siteSlugByPageId}
      >
        <RequireRole roles={['STUDENT', 'OWNER']} tag="student">
          <Outlet />
        </RequireRole>
      </PagePeekProvider>
    </CommonLayout>
  );
};

export default Student;
