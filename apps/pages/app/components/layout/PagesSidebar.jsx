import { Link, useFetcher } from 'react-router';
import { IconLayoutSidebarLeftCollapse, IconFileText, IconPlus, IconPencil, IconLock, IconWorld, IconX } from '@tabler/icons-react';
import { useState } from 'react';

/**
 * PagesSidebar - Collapsible sidebar with page navigation
 *
 * Props:
 * - pages: Array of page objects
 * - classroom: Classroom object with slug
 * - currentPageId: ID of currently viewed page (for highlighting)
 * - canEdit: Boolean - whether user can create/edit pages
 * - collapsed: Boolean - sidebar collapsed state
 * - onToggleCollapse: Function - toggle callback
 * - mobileOpen: Boolean - whether sidebar is open on mobile
 * - onMobileClose: Function - close callback for mobile
 */
const PagesSidebar = ({
  pages,
  classroom,
  currentPageId,
  canEdit,
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onMobileClose,
}) => {
  const fetcher = useFetcher();
  const isCreating = fetcher.state !== 'idle';
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newPageTitle, setNewPageTitle] = useState('');

  const handleCreatePage = () => {
    setShowCreateModal(true);
  };

  const handleConfirmCreate = () => {
    if (!newPageTitle.trim()) return;

    fetcher.submit(
      { intent: 'create', title: newPageTitle.trim() },
      { method: 'post', action: `/${classroom.slug}` }
    );

    setShowCreateModal(false);
    setNewPageTitle('');
  };

  const handleCancelCreate = () => {
    setShowCreateModal(false);
    setNewPageTitle('');
  };

  return (
    <>
      {/* Backdrop for mobile */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed left-0 top-0 h-screen bg-[#f7f8fa] dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 transition-all duration-200 ease-in-out flex flex-col z-50 ${
          collapsed ? 'w-16' : 'w-60'
        } ${mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}
      >
      {/* Header with collapse toggle */}
      <div className={`h-12 flex items-center ${collapsed ? 'justify-center' : 'justify-between'} px-4 border-b border-gray-200 dark:border-gray-800`}>
        {!collapsed && (
          <div className="flex items-center gap-2 min-w-0">
            <img
              src={classroom.git_organization?.avatar_url || classroom.avatar_url}
              alt={classroom.git_organization?.login || classroom.name}
              className="h-6 w-6 rounded-full border-2 border-gray-200 dark:border-gray-600 flex-shrink-0"
            />
            <h2 className="font-semibold text-gray-900 dark:text-white truncate">
              {classroom.name}
            </h2>
          </div>
        )}
        <button
          onClick={onToggleCollapse}
          className="p-1 rounded-md hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-colors duration-200"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <IconLayoutSidebarLeftCollapse
            size={20}
            className={`text-gray-700 dark:text-gray-300 hover:text-primary-600 dark:hover:text-primary-500 transition-all duration-300 ${
              collapsed ? 'rotate-180' : ''
            }`}
          />
        </button>
      </div>

      {/* Content area - page list */}
      <div className="flex-1 overflow-y-auto p-2">
        {pages.length === 0 ? (
          <div className="text-gray-500 dark:text-gray-400 text-sm text-center py-8">
            {collapsed ? (
              <IconFileText size={24} className="mx-auto opacity-30" />
            ) : (
              'No pages yet'
            )}
          </div>
        ) : (
          <div className="space-y-0.5">
            {pages.map((page) => {
              const isActive = page.id === currentPageId;
              return (
                <Link
                  key={page.id}
                  to={`/${classroom.slug}/${page.id}`}
                  onClick={() => onMobileClose && onMobileClose()}
                  className={`flex items-center gap-2 px-3 py-2 rounded-md transition-colors ${
                    isActive
                      ? 'bg-gray-200 dark:bg-gray-800 text-gray-900 dark:text-white'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                  title={collapsed ? page.title || 'Untitled' : undefined}
                >
                  {!collapsed && (
                    <>
                      <span className="truncate text-sm font-medium flex-1">
                        {page.title || 'Untitled'}
                      </span>
                      {canEdit && (
                        page.is_draft ? (
                          <IconPencil size={14} className="flex-shrink-0 text-gray-400 dark:text-gray-500" title="Draft" />
                        ) : page.is_public ? (
                          <IconWorld size={14} className="flex-shrink-0 text-green-500 dark:text-green-400" title="Public" />
                        ) : (
                          <IconLock size={14} className="flex-shrink-0 text-blue-500 dark:text-blue-400" title="Private" />
                        )
                      )}
                    </>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer with New Page button (admin only) */}
      {canEdit && (
        <div className="p-2 border-t border-gray-200 dark:border-gray-800">
          <button
            type="button"
            onClick={handleCreatePage}
            disabled={isCreating}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-md transition-colors ${
              isCreating
                ? 'text-gray-400 dark:text-gray-600 cursor-not-allowed'
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
            } ${collapsed ? 'justify-center' : ''}`}
            title={collapsed ? 'New Page' : undefined}
          >
            <IconPlus size={18} className="flex-shrink-0" />
            {!collapsed && (
              <span className="text-sm font-medium">
                {isCreating ? 'Creating...' : 'New Page'}
              </span>
            )}
          </button>
        </div>
      )}
      </div>

      {/* Create Page Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Create New Page
              </h3>
              <button
                onClick={handleCancelCreate}
                className="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                aria-label="Close"
              >
                <IconX size={20} className="text-gray-500 dark:text-gray-400" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4">
              <label htmlFor="page-title" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Page Title
              </label>
              <input
                id="page-title"
                type="text"
                value={newPageTitle}
                onChange={(e) => setNewPageTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newPageTitle.trim()) {
                    handleConfirmCreate();
                  } else if (e.key === 'Escape') {
                    handleCancelCreate();
                  }
                }}
                placeholder="Enter page title..."
                autoFocus
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:text-white"
              />
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={handleCancelCreate}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmCreate}
                disabled={!newPageTitle.trim() || isCreating}
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 disabled:cursor-not-allowed rounded-md transition-colors"
              >
                {isCreating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default PagesSidebar;
