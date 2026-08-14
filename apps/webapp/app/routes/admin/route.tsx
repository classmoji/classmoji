import { Outlet } from 'react-router';
import { CommonLayout, RequireRole } from '~/components';
import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { DEFAULT_NAV_VISIBILITY, navVisibilityFromSettings } from '~/utils/navVisibility';
import type { ImportProgressBannerProps } from '~/components/features/import/ImportProgressBanner';
import type { Route } from './+types/route';

/** A finished import stays visible this long, then stops being loaded at all. */
const COMPLETED_BANNER_WINDOW_MS = 10 * 60 * 1000;

/**
 * The classroom's background import, when it is worth showing.
 *
 * PENDING/RUNNING is obvious, and FAILED is deliberately included even though it
 * is terminal — a failed import is exactly the state the user must see, and it
 * carries the retry. Only COMPLETED ages out, so a classroom imported last term
 * doesn't greet its owner with a stale success banner.
 */
async function loadImportBanner(classroomId: string): Promise<ImportProgressBannerProps | null> {
  const job = await getPrisma().importJob.findUnique({ where: { classroom_id: classroomId } });
  if (!job) return null;
  if (
    job.status === 'COMPLETED' &&
    Date.now() - job.updated_at.getTime() > COMPLETED_BANNER_WINDOW_MS
  ) {
    return null;
  }

  const source = await getPrisma().classroom.findUnique({
    where: { id: job.source_classroom_id },
    select: { name: true },
  });

  // Field by field, matching the API route's ImportJobView — the banner polls
  // that endpoint, so the initial payload has to be the same narrow shape.
  return {
    job: {
      id: job.id,
      status: job.status as ImportProgressBannerProps['job']['status'],
      phase: job.phase,
      progress: job.progress as unknown as ImportProgressBannerProps['job']['progress'],
      warnings: (job.warnings ?? []) as string[],
      error: job.error,
      updated_at: job.updated_at.toISOString(),
    },
    sourceName: source?.name ?? null,
  };
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  // Handle case where class param might not be present yet (e.g., at /admin)
  if (!classSlug) {
    return { menuPages: [], recentViewers: [], navVisibility: DEFAULT_NAV_VISIBILITY };
  }

  try {
    // SECURITY: Verify user has OWNER role in this classroom before recording/fetching views
    const { userId, classroom } = await requireClassroomAdmin(request, classSlug);

    // Fetch pages that should appear in menu (same as student view)
    const menuPages = await ClassmojiService.page.findForStudentMenu(classroom.id);

    const importBanner = await loadImportBanner(classroom.id);

    // Check if recent viewers feature is enabled (settings included from findBySlug)
    const recentViewersEnabled = classroom.settings?.recent_viewers_enabled ?? true;

    if (!recentViewersEnabled) {
      return { menuPages, recentViewers: [], importBanner };
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
      importBanner,
      pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
      navVisibility: navVisibilityFromSettings(classroom.settings),
    };
  } catch {
    // If classroom access fails, return empty data
    return {
      menuPages: [],
      recentViewers: [],
      pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
      navVisibility: DEFAULT_NAV_VISIBILITY,
    };
  }
};

const Admin = ({ loaderData }: Route.ComponentProps) => {
  const { menuPages, recentViewers, isAdmin, pagesUrl, navVisibility } = loaderData;
  const importBanner = 'importBanner' in loaderData ? loaderData.importBanner : null;

  return (
    <CommonLayout
      menuPages={menuPages}
      recentViewers={recentViewers}
      groupViewersByRole={isAdmin}
      pagesUrl={pagesUrl}
      navVisibility={navVisibility}
      importBanner={importBanner}
    >
      <RequireRole roles={['OWNER']}>
        <Outlet />
      </RequireRole>
    </CommonLayout>
  );
};

export default Admin;
