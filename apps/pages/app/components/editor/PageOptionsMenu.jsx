import { useFetcher } from 'react-router';
import { useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
import {
  IconWorld,
  IconLock,
  IconPencil,
  IconLayoutSidebarRight,
  IconLayout,
  IconLayoutSidebarLeftExpand,
  IconTrash,
} from '@tabler/icons-react';

/**
 * Page options dropdown menu.
 * Provides actions for toggling public status, changing width, and deleting the page.
 */
const PageOptionsMenu = ({ page, classroom, isOpen, onClose }) => {
  const fetcher = useFetcher();
  const menuRef = useRef(null);
  const deleteToastIdRef = useRef(null);

  const currentStatus = page.is_draft ? 'draft' : page.is_public ? 'public' : 'private';

  const handleStatusChange = (value) => {
    if (value === currentStatus) return;
    fetcher.submit(
      {
        intent: 'update-status',
        pageId: page.id,
        is_draft: value === 'draft',
        is_public: value === 'public',
      },
      { method: 'POST', action: `/${classroom.slug}`, encType: 'application/json' }
    );
    onClose();
  };

  const handleSetWidth = (width) => {
    fetcher.submit(
      {
        intent: 'update-width',
        width,
      },
      { method: 'POST', encType: 'application/json' }
    );
    onClose();
  };

  const handleDelete = () => {
    if (confirm('Delete this page? This cannot be undone.')) {
      // Show loading toast and store ID in ref
      deleteToastIdRef.current = toast.loading('Deleting page...', {
        position: 'top-center',
      });

      fetcher.submit(
        {
          intent: 'delete',
          pageId: page.id,
        },
        { method: 'POST', action: `/${classroom.slug}`, encType: 'application/json' }
      );
    }
    onClose(); // Menu can close immediately - toast will show feedback
  };

  // Close menu when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  // Handle delete success/error with toast updates
  useEffect(() => {
    if (fetcher.state === 'idle' && deleteToastIdRef.current) {
      const toastId = deleteToastIdRef.current;

      // Check if navigation happened (successful delete with redirect)
      const wasSuccessful = !fetcher.data || !fetcher.data.error;

      if (wasSuccessful) {
        toast.update(toastId, {
          render: 'Page deleted',
          type: 'success',
          isLoading: false,
          autoClose: 2000,
        });
        deleteToastIdRef.current = null;
        // No navigate() - server redirect handles it
      } else if (fetcher.data?.error) {
        toast.update(toastId, {
          render: `Failed to delete: ${fetcher.data.error}`,
          type: 'error',
          isLoading: false,
          autoClose: 5000,
          closeButton: true,
        });
        deleteToastIdRef.current = null;
        // Stay on current page so user can see what failed
      }
    }
  }, [fetcher.state, fetcher.data]);

  if (!isOpen) return null;

  return (
    <div
      ref={menuRef}
      className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50"
    >
      <div className="py-1">
        {/* Page Status */}
        <div className="px-4 py-1.5">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</span>
        </div>
        {[
          { value: 'draft', label: 'Draft', icon: IconPencil, description: 'Only you and teachers can see' },
          { value: 'private', label: 'Private', icon: IconLock, description: 'Classroom members only' },
          { value: 'public', label: 'Public', icon: IconWorld, description: 'Anyone with the link' },
        ].map(({ value, label, icon: Icon, description }) => (
          <button
            key={value}
            onClick={() => handleStatusChange(value)}
            className={`w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 ${
              currentStatus === value ? 'text-yellow-600 dark:text-yellow-400' : 'text-gray-700 dark:text-gray-300'
            }`}
          >
            <Icon size={16} />
            <div className="flex flex-col">
              <span className={currentStatus === value ? 'font-medium' : ''}>{label}</span>
              <span className="text-xs text-gray-400 dark:text-gray-500">{description}</span>
            </div>
          </button>
        ))}

        {/* Divider */}
        <div className="border-t border-gray-200 dark:border-gray-700 my-1" />

        {/* Width options */}
        <button
          onClick={() => handleSetWidth(1)}
          className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
        >
          <IconLayoutSidebarRight
            size={16}
            className={page.width === 1 ? 'text-yellow-600' : 'text-gray-700 dark:text-gray-300'}
          />
          <span className={page.width === 1 ? 'font-medium text-yellow-600' : 'text-gray-700 dark:text-gray-300'}>
            Narrow
          </span>
        </button>
        <button
          onClick={() => handleSetWidth(2)}
          className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
        >
          <IconLayout
            size={16}
            className={page.width === 2 ? 'text-yellow-600' : 'text-gray-700 dark:text-gray-300'}
          />
          <span className={page.width === 2 ? 'font-medium text-yellow-600' : 'text-gray-700 dark:text-gray-300'}>
            Default
          </span>
        </button>
        <button
          onClick={() => handleSetWidth(3)}
          className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
        >
          <IconLayoutSidebarLeftExpand
            size={16}
            className={page.width === 3 ? 'text-yellow-600' : 'text-gray-700 dark:text-gray-300'}
          />
          <span className={page.width === 3 ? 'font-medium text-yellow-600' : 'text-gray-700 dark:text-gray-300'}>
            Wide
          </span>
        </button>
        <button
          onClick={() => handleSetWidth(4)}
          className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
        >
          <IconLayoutSidebarLeftExpand
            size={16}
            className={page.width === 4 ? 'text-yellow-600' : 'text-gray-700 dark:text-gray-300'}
          />
          <span className={page.width === 4 ? 'font-medium text-yellow-600' : 'text-gray-700 dark:text-gray-300'}>
            Extra Wide
          </span>
        </button>

        {/* Divider */}
        <div className="border-t border-gray-200 dark:border-gray-700 my-1" />

        {/* Delete */}
        <button
          onClick={handleDelete}
          className="w-full px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
        >
          <IconTrash size={16} />
          <span>Move to trash</span>
        </button>
      </div>
    </div>
  );
};

export default PageOptionsMenu;
