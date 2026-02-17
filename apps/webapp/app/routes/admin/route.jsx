import { Outlet, useLoaderData } from 'react-router';
import { CommonLayout, RequireRole } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  // Handle case where class param might not be present yet (e.g., at /admin)
  if (!classSlug) {
    return { menuPages: [], recentViewers: [] };
  }

  try {
    // SECURITY: Verify user has OWNER role in this classroom before recording/fetching views
    const { userId, classroom } = await requireClassroomAdmin(request, classSlug);

    // Fetch pages that should appear in menu (same as student view)
    const menuPages = await ClassmojiService.page.findForStudentMenu(classroom.id);

    // Check if recent viewers feature is enabled (settings included from findBySlug)
    const recentViewersEnabled = classroom.settings?.recent_viewers_enabled ?? true;

    if (!recentViewersEnabled) {
      return { menuPages, recentViewers: [] };
    }

    // Normalize the current path
    const url = new URL(request.url);
    const resourcePath = ClassmojiService.resourceView.normalizePath(url.pathname);

    // Fire-and-forget: record the view without blocking
    // Admin route is always viewed as OWNER (teaching view)
    Promise.resolve().then(() => {
      ClassmojiService.resourceView.recordView({
        resourcePath,
        userId,
        classroomId: classroom.id,
        viewedAsRole: 'OWNER',
      });
    });

    // Fetch recent viewers for this resource (including current user and roles for admin view)
    const recentViewers = await ClassmojiService.resourceView.getRecentViewers({
      resourcePath,
      classroomId: classroom.id,
      includeRoles: true,
    });

    return {
      menuPages,
      recentViewers,
      isAdmin: true,
      pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    };
  } catch {
    // If classroom access fails, return empty data
    return {
      menuPages: [],
      recentViewers: [],
      pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    };
  }
};

const Admin = () => {
  const { menuPages, recentViewers, isAdmin, pagesUrl } = useLoaderData();

  return (
    <CommonLayout
      menuPages={menuPages}
      recentViewers={recentViewers}
      groupViewersByRole={isAdmin}
      pagesUrl={pagesUrl}
    >
      <RequireRole roles={['OWNER']}>
        <Outlet />
      </RequireRole>
    </CommonLayout>
  );
};

export default Admin;
