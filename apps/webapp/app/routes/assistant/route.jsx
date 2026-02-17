import { Outlet, useLoaderData } from 'react-router';
import { CommonLayout, RequireRole } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  // Handle case where class param might not be present yet (e.g., at /assistant)
  if (!classSlug) {
    return { menuPages: [], recentViewers: [] };
  }

  try {
    const { userId, classroom } = await requireClassroomTeachingTeam(request, classSlug);

    // Fetch pages that should appear in menu (same as student)
    const menuPages = await ClassmojiService.page.findForStudentMenu(classroom.id);

    // Check if recent viewers feature is enabled (settings included from findBySlug)
    const recentViewersEnabled = classroom.settings?.recent_viewers_enabled ?? true;

    let recentViewers = [];

    if (recentViewersEnabled) {
      // Normalize the current path for view tracking
      const url = new URL(request.url);
      const resourcePath = ClassmojiService.resourceView.normalizePath(url.pathname);

      // Fire-and-forget: record the view without blocking
      // Assistant route is always viewed as ASSISTANT
      Promise.resolve().then(() => {
        ClassmojiService.resourceView.recordView({
          resourcePath,
          userId,
          classroomId: classroom.id,
          viewedAsRole: 'ASSISTANT',
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
      menuPages,
      recentViewers,
      isTeachingTeam: true,
      pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    };
  } catch {
    // If classroom access fails, return empty menu pages
    return {
      menuPages: [],
      recentViewers: [],
      pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    };
  }
};

const Assistant = () => {
  const { menuPages, recentViewers, isTeachingTeam, pagesUrl } = useLoaderData();

  return (
    <CommonLayout
      menuPages={menuPages}
      recentViewers={recentViewers}
      groupViewersByRole={isTeachingTeam}
      pagesUrl={pagesUrl}
    >
      <RequireRole roles={['ASSISTANT']}>
        <Outlet />
      </RequireRole>
    </CommonLayout>
  );
};

export default Assistant;
