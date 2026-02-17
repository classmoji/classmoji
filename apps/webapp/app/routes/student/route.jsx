import { Outlet, useLoaderData } from 'react-router';
import { CommonLayout, RequireRole } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomMember } from '~/utils/routeAuth.server';
import { SHARED_CONTENT_PATHS } from '~/constants';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  // Handle case where class param might not be present yet
  if (!classSlug) {
    return { menuPages: [], recentViewers: [] };
  }

  try {
    // SECURITY: Verify user is a member of this classroom before recording/fetching views
    const { userId, classroom } = await requireClassroomMember(request, classSlug);

    // Fetch pages that should appear in student menu
    const menuPages = await ClassmojiService.page.findForStudentMenu(classroom.id);

    // Check if recent viewers feature is enabled (settings included from findBySlug)
    const recentViewersEnabled = classroom.settings?.recent_viewers_enabled ?? true;

    let recentViewers = [];

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
      // Only DISPLAY recent viewers for shared content (pages, slides, modules, calendar)
      // Skip personal routes like dashboard, grades, tokens to avoid privacy confusion
      const isSharedContent = SHARED_CONTENT_PATHS.some(p => resourcePath.startsWith(p));

      if (isSharedContent) {
        recentViewers = await ClassmojiService.resourceView.getRecentViewers({
          resourcePath,
          classroomId: classroom.id,
        });
      }
    }

    return {
      menuPages,
      recentViewers,
      pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    };
  } catch {
    // If classroom access fails, return empty data
    return { menuPages: [], recentViewers: [], pagesUrl: process.env.PAGES_URL || 'http://localhost:7100' };
  }
};

const Student = () => {
  const { menuPages, recentViewers, pagesUrl } = useLoaderData();

  return (
    <CommonLayout menuPages={menuPages} recentViewers={recentViewers} pagesUrl={pagesUrl}>
      <RequireRole roles={['STUDENT', 'OWNER']} tag="student">
        <Outlet />
      </RequireRole>
    </CommonLayout>
  );
};

export default Student;
