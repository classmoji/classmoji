import { useOutletContext, redirect } from 'react-router';
import { useLoaderData } from 'react-router';

import EmptyPageState from '~/components/layout/EmptyPageState.jsx';
import { loader as parentLoader } from '../$classroomSlug/route.jsx';

/**
 * Index route loader: redirects to first page or shows empty state
 */
export const loader = async ({ params, request }) => {
  const { view, pages, classroom } = await parentLoader({ params, request });

  // If no pages exist
  if (pages.length === 0) {
    // Public users: redirect to login (existing behavior)
    if (view === 'public') {
      const webappUrl = process.env.WEBAPP_URL || 'http://localhost:3000';
      const url = new URL(request.url);
      return redirect(`${webappUrl}?redirect=${encodeURIComponent(url.href)}`);
    }
    // Admin/student: show "create first page" empty state
    return { showEmptyState: true, emptyType: 'no-pages', view, classroom };
  }

  // If pages exist
  if (view === 'admin') {
    // Admin: show selection prompt (has sidebar with all pages)
    return { showEmptyState: true, emptyType: 'select-page', view, classroom };
  } else {
    // Student/public: redirect to first page (simpler navigation)
    return redirect(`/${params.classroomSlug}/${pages[0].id}`);
  }
};

const ClassroomIndex = () => {
  const { showEmptyState, emptyType, view, classroom } = useLoaderData();
  const { canEdit } = useOutletContext();

  if (showEmptyState) {
    if (emptyType === 'select-page') {
      // Admin viewing after deletion - prompt to select from sidebar
      return (
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-center">
            <div className="text-6xl mb-4">📄</div>
            <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
              Select a page from the sidebar
            </h2>
            <p className="text-gray-600 dark:text-gray-400">
              Choose a page to edit or create a new one
            </p>
          </div>
        </div>
      );
    }
    // emptyType === 'no-pages': show existing EmptyPageState
    return <EmptyPageState canEdit={canEdit} classroom={classroom} />;
  }

  // This should never render because we redirect students to first page
  // But keeping as fallback
  return null;
};

export default ClassroomIndex;
