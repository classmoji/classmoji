// The pages list's data, loaded once and served to two routes.
//
// It lives outside the route module because React Router only strips
// `loader`, `action`, `middleware` and `headers` from a route's client bundle.
// A loader FACTORY exported from the route file is none of those, so its
// server-only imports would follow the component into the browser. Here, behind
// `.server`, both routes import a ready-made loader and the whole module drops
// out of the client build with their `loader` export.
import { assertClassroomAccess } from '~/utils/helpers';
import { ClassmojiService } from '@classmoji/services';

type LoaderArgs = { params: Record<string, string | undefined>; request: Request };

/**
 * The pages list's loader, with the roles it admits left open.
 *
 * Everything it does is a read, so the assistant route serves the same list
 * from the same query with ASSISTANT added — see `assistant.$class_.pages`.
 * Keeping one loader is what stops the two lists drifting apart. Writes are NOT
 * shared: the action below still refuses anyone but OWNER and TEACHER.
 */
export const buildLoader =
  (allowedRoles: Array<'OWNER' | 'TEACHER' | 'ASSISTANT'>) =>
  async ({ request, params }: LoaderArgs) => {
    const { class: classSlug } = params;

    const { classroom } = await assertClassroomAccess({
      request,
      classroomSlug: classSlug!,
      allowedRoles,
      resourceType: 'PAGES',
      attemptedAction: 'view_pages',
    });

    // Get all pages for this classroom
    const pages = await ClassmojiService.page.findByClassroomId(classroom.id, {
      includeCreator: true,
      includeLinks: true,
    });

    // Fetch recent viewers for all pages in one query (with total counts and roles for admin UI)
    const resourcePaths = pages.map(page => `pages/${page.id}`);
    const pageViewersMap = await ClassmojiService.resourceView.getRecentViewersForPaths({
      resourcePaths,
      classroomId: classroom.id,
      limitPerPath: 50,
      includeTotalCount: true,
      includeRoles: true,
    });

    // Convert Map to plain object for serialization (React Router can't serialize Maps)
    const pageViewers = Object.fromEntries(pageViewersMap);

    return {
      classSlug,
      classroom,
      pages,
      pageViewers,
    };
  };

/** OWNER or TEACHER — the /admin and /teacher pages list. */
export const adminLoader = buildLoader(['OWNER', 'TEACHER']);

/** Plus ASSISTANT — the same list under /assistant, read-only. */
export const teachingTeamLoader = buildLoader(['OWNER', 'TEACHER', 'ASSISTANT']);
