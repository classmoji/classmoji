import { redirect } from 'react-router';
import type { Route } from './+types/route';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';

/**
 * Teacher classroom index — redirects `/teacher/{classSlug}` to the dashboard.
 *
 * Without this the bare prefix matches the layout and nothing else, so it
 * renders an empty shell. That is reachable in normal use: notification deep
 * links fall back to `/${prefix}/${slug}` for any resource type whose list page
 * the prefix does not serve (assignments, and anything unrecognised — see
 * components/features/notifications/notificationLinks.ts).
 *
 * Dashboard rather than the student index's configurable landing page: that
 * setting (`default_student_page`) is about what STUDENTS see and can point at
 * a student-menu page, which is not the right destination for staff.
 */
export const loader = async ({ params, request }: Route.LoaderArgs) => {
  try {
    await requireClassroomTeachingTeam(request, params.class!, {
      resourceType: 'TEACHER_LAYOUT',
      action: 'view_default_page',
    });
  } catch (error: unknown) {
    // Send a signed-out or unauthorized visitor home rather than rendering an
    // error page for what is only a redirect.
    if (error instanceof Response && (error.status === 401 || error.status === 403)) {
      return redirect('/');
    }
    throw error;
  }

  return redirect('dashboard');
};

// Redirect-only route; nothing to render.
export default function TeacherClassroomIndex() {
  return null;
}
