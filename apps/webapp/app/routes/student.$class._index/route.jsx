import { redirect } from 'react-router';
import { ClassmojiService } from '@classmoji/services';
import { requireStudentAccess } from '~/utils/helpers';

/**
 * Student classroom index route - redirects to configured default page
 *
 * Handles redirect logic for `/student/{classSlug}` to the classroom's
 * configured default landing page (dashboard, modules, or a specific page).
 */
export const loader = async ({ params, request }) => {
  let classroom;

  try {
    const result = await requireStudentAccess(
      request,
      params.class,
      { resourceType: 'CLASSROOM', action: 'view_default_page' }
    );
    classroom = result.classroom;
  } catch (error) {
    // If auth fails (401/403), redirect to home instead of showing error
    if (error instanceof Response && (error.status === 401 || error.status === 403)) {
      return redirect('/');
    }
    throw error;
  }

  const defaultPage = classroom.settings?.default_student_page || 'dashboard';

  // Dashboard is the ultimate fallback
  if (defaultPage === 'dashboard') {
    return redirect('dashboard');
  }

  // Modules route
  if (defaultPage === 'modules') {
    return redirect('modules');
  }

  // Specific page - verify it exists and is visible to students
  if (defaultPage.startsWith('page:')) {
    const pageId = defaultPage.replace('page:', '');

    try {
      const page = await ClassmojiService.page.findById(pageId, {
        includeClassroom: false,
      });

      // Only redirect to page if it exists, is published, and is in the student menu
      if (page && page.show_in_student_menu && !page.is_draft) {
        return redirect(`pages/${page.id}`);
      }
    } catch {
      // Page not found or error - fall through to dashboard
    }
  }

  // Fallback to dashboard for any invalid/missing configuration
  return redirect('dashboard');
};

// No component needed - this route only handles redirects
export default function StudentClassroomIndex() {
  return null;
}
