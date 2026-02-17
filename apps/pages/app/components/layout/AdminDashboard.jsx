import { useFetcher, Link } from 'react-router';
import dayjs from 'dayjs';

/**
 * Admin dashboard — table of all pages with management actions.
 */
const AdminDashboard = ({ pages, classroom }) => {
  const fetcher = useFetcher();

  const statusValue = (page) => {
    if (page.is_draft) return 'draft';
    if (page.is_public) return 'public';
    return 'private';
  };

  const statusStyles = {
    draft: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    private: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    public: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  };

  const handleStatusChange = (page, value) => {
    fetcher.submit(
      {
        intent: 'update-status',
        pageId: page.id,
        is_draft: value === 'draft',
        is_public: value === 'public',
      },
      { method: 'post', encType: 'application/json' },
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          Pages
        </h1>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="create" />
          <button
            type="submit"
            className="px-4 py-2 bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-700 dark:hover:bg-gray-100"
          >
            + New Page
          </button>
        </fetcher.Form>
      </div>

      {pages.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 dark:text-gray-400 text-lg">
            No pages yet. Create your first page to get started.
          </p>
        </div>
      ) : (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Title
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Menu
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Updated
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {pages.map((page) => (
                <tr key={page.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="px-4 py-3">
                    <Link
                      to={`/${classroom.slug}/${page.id}`}
                      className="text-sm font-medium text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400"
                    >
                      {page.title || 'Untitled'}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={statusValue(page)}
                      onChange={(e) => handleStatusChange(page, e.target.value)}
                      className={`text-xs font-medium rounded-full px-2 py-0.5 border-none cursor-pointer appearance-none pr-5 ${statusStyles[statusValue(page)]}`}
                      style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24'%3E%3Cpath fill='currentColor' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center' }}
                    >
                      <option value="draft">Draft</option>
                      <option value="private">Private</option>
                      <option value="public">Public</option>
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => {
                        fetcher.submit(
                          { intent: 'toggle-menu', pageId: page.id, show: !page.show_in_student_menu },
                          { method: 'post', encType: 'application/json' }
                        );
                      }}
                      className={`text-xs px-2 py-0.5 rounded ${
                        page.show_in_student_menu
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300'
                          : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500'
                      }`}
                    >
                      {page.show_in_student_menu ? 'Visible' : 'Hidden'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {dayjs(page.updated_at).format('MMM D, YYYY')}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Link
                        to={`/${classroom.slug}/${page.id}`}
                        className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                      >
                        View
                      </Link>
                      <Link
                        to={`/${classroom.slug}/${page.id}`}
                        className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400"
                      >
                        Edit
                      </Link>
                      <button
                        onClick={() => {
                          if (confirm('Delete this page? This cannot be undone.')) {
                            fetcher.submit(
                              { intent: 'delete', pageId: page.id },
                              { method: 'post', encType: 'application/json' }
                            );
                          }
                        }}
                        className="text-xs text-red-600 hover:text-red-800 dark:text-red-400"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default AdminDashboard;
