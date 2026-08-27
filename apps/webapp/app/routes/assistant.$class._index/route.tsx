import { redirect } from 'react-router';
import type { Route } from './+types/route';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';

/**
 * Assistant classroom index — redirects `/assistant/{classSlug}` to the
 * dashboard.
 *
 * Same gap, and same reason, as the teacher index alongside it: the bare prefix
 * otherwise renders an empty shell, and notification deep links fall back to
 * `/${prefix}/${slug}` for resource types the prefix has no list page for.
 */
export const loader = async ({ params, request }: Route.LoaderArgs) => {
  try {
    await requireClassroomTeachingTeam(request, params.class!, {
      resourceType: 'ASSISTANT_LAYOUT',
      action: 'view_default_page',
    });
  } catch (error: unknown) {
    if (error instanceof Response && (error.status === 401 || error.status === 403)) {
      return redirect('/');
    }
    throw error;
  }

  return redirect('dashboard');
};

// Redirect-only route; nothing to render.
export default function AssistantClassroomIndex() {
  return null;
}
