import { Outlet } from 'react-router';
import type { Route } from './+types/route';
import { CommonLayout, RequireRole } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import { PagePeekProvider } from '~/components/features/pages';
import { DEFAULT_NAV_VISIBILITY, navVisibilityFromSettings } from '~/utils/navVisibility';
import { EMPTY_PAGES_NAV, loadPagesNav } from '~/utils/pagesNav.server';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  const pagesUrl = process.env.PAGES_URL || 'http://localhost:7100';

  // Handle case where class param might not be present yet (e.g., at /teacher)
  if (!classSlug) {
    return {
      recentViewers: [],
      pagesUrl,
      pagesNav: EMPTY_PAGES_NAV,
      navVisibility: DEFAULT_NAV_VISIBILITY,
    };
  }

  try {
    // Named so a denial is identifiable. Unlike the leaf routes, this one is
    // specific to the /teacher prefix, so the row should say which shell was
    // refused rather than the shared default 'TEACHING_RESOURCE'/'access'.
    //
    // NOT an authorization boundary for what renders beneath it: the catch
    // below turns a denial into an empty shell rather than a 403, and the
    // RequireRole in the component is client-side. Each leaf route carries its
    // own gate, and for a POST this loader does not run first at all — React
    // Router runs the matched leaf's action, then revalidates parents.
    const { userId, classroom, membership } = await requireClassroomTeachingTeam(
      request,
      classSlug,
      {
        resourceType: 'TEACHER_LAYOUT',
        action: 'enter_teacher_prefix',
      }
    );

    // Same single read the assistant layout does: nav visibility + the site links
    // the peek drawer's ↗ needs.
    const pagesNav = await loadPagesNav(classroom.id);

    // Check if recent viewers feature is enabled (settings included from findBySlug)
    const recentViewersEnabled = classroom.settings?.recent_viewers_enabled ?? true;

    let recentViewers: {
      user: { id: string; name: string | null; login: string | null; avatar_url: string | null };
      lastViewedAt: Date;
      role?: string | null;
    }[] = [];

    if (recentViewersEnabled) {
      // Normalize the current path for view tracking
      const url = new URL(request.url);
      const resourcePath = ClassmojiService.resourceView.normalizePath(url.pathname);

      // Fire-and-forget: record the view without blocking.
      //
      // The viewer's REAL role, not the prefix. An owner previewing the class
      // as a teacher is still an owner, and recording them as TEACHER would put
      // them in the teacher bucket of the recent-viewers list — which is read
      // as "who on the teaching team has seen this".
      Promise.resolve().then(() => {
        ClassmojiService.resourceView.recordView({
          resourcePath,
          userId,
          classroomId: classroom.id,
          viewedAsRole: membership?.role ?? 'TEACHER',
        });
      });

      // Fetch recent viewers for this resource (with roles for teaching team view)
      recentViewers = await ClassmojiService.resourceView.getRecentViewers({
        resourcePath,
        classroomId: classroom.id,
        includeRoles: true,
      });
    }

    return {
      recentViewers,
      isTeachingTeam: true,
      pagesUrl,
      pagesNav,
      navVisibility: {
        ...navVisibilityFromSettings(classroom.settings),
        // Staff preview drafts, so any module (published or not) shows the tab.
        hasModules: await ClassmojiService.module.hasModulesForClassroom(classSlug, {
          includeUnpublished: true,
        }),
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

const Teacher = ({ loaderData, params }: Route.ComponentProps) => {
  const { recentViewers, isTeachingTeam, pagesUrl, pagesNav, navVisibility } = loaderData;

  return (
    <CommonLayout
      recentViewers={recentViewers}
      groupViewersByRole={isTeachingTeam}
      pagesUrl={pagesUrl}
      navVisibility={navVisibility}
    >
      <PagePeekProvider
        classSlug={params.class ?? ''}
        rolePath="/teacher"
        pagesUrl={pagesUrl}
        siteOrigin={pagesNav.siteOrigin}
        siteSlugByPageId={pagesNav.siteSlugByPageId}
      >
        <RequireRole roles={['TEACHER']}>
          <Outlet />
        </RequireRole>
      </PagePeekProvider>
    </CommonLayout>
  );
};

export default Teacher;
