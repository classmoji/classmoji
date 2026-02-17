import { Link } from 'react-router';
import dayjs from 'dayjs';

/**
 * Student page list — card grid of published pages.
 */
const StudentPageList = ({ pages, classroom }) => {
  if (pages.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 dark:text-gray-400 text-lg">
          No pages available yet.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">
        Pages
      </h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {pages.map((page) => (
          <Link
            key={page.id}
            to={`/${classroom.slug}/${page.id}`}
            className="group block border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden hover:shadow-md transition-shadow"
          >
            {/* Header image thumbnail */}
            {page.header_image_url ? (
              <div
                className="h-32 bg-gray-100 dark:bg-gray-800 bg-cover bg-center"
                style={{ backgroundImage: `url(${page.header_image_url})` }}
              />
            ) : (
              <div className="h-32 bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                <span className="text-3xl opacity-30">📄</span>
              </div>
            )}

            <div className="p-4">
              <h3 className="font-medium text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400">
                {page.title || 'Untitled'}
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Updated {dayjs(page.updated_at).format('MMM D, YYYY')}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
};

export default StudentPageList;
