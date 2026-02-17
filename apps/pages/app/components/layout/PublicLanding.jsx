import { Link } from 'react-router';

/**
 * Public landing page for unauthenticated visitors.
 * Shows public pages if available, or a minimal message.
 */
const PublicLanding = ({ pages, classroom }) => {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#191919]">
      <div className="max-w-4xl mx-auto px-4 py-12">
        {/* Classroom branding */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            {classroom.name}
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-2">
            Course Pages
          </p>
        </div>

        {pages.length > 0 ? (
          <div className="space-y-3">
            {pages.map((page) => (
              <Link
                key={page.id}
                to={`/${classroom.slug}/${page.id}`}
                className="block p-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg hover:shadow-md transition-shadow"
              >
                <h3 className="font-medium text-gray-900 dark:text-white">
                  {page.title || 'Untitled'}
                </h3>
              </Link>
            ))}
          </div>
        ) : (
          <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
            <p className="text-gray-500 dark:text-gray-400">
              No public content available.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default PublicLanding;
