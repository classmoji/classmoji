import { useFetcher } from 'react-router';
import { IconFileText, IconPlus } from '@tabler/icons-react';

/**
 * EmptyPageState - Shown when no pages exist for a classroom
 *
 * Props:
 * - canEdit: Boolean - whether user can create pages
 * - classroom: Classroom object with slug
 */
const EmptyPageState = ({ canEdit, classroom }) => {
  const fetcher = useFetcher();
  const isCreating = fetcher.state !== 'idle';

  const handleCreatePage = () => {
    fetcher.submit(
      { intent: 'create' },
      { method: 'post', action: `/${classroom.slug}` }
    );
  };

  return (
    <div className="flex items-center justify-center h-full min-h-[60vh]">
      <div className="text-center max-w-md px-4">
        <div className="mb-6">
          <IconFileText
            size={64}
            className="mx-auto text-gray-300 dark:text-gray-700"
            strokeWidth={1.5}
          />
        </div>

        <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
          {canEdit ? 'No pages yet' : 'No pages available'}
        </h2>

        <p className="text-gray-600 dark:text-gray-400 mb-6">
          {canEdit
            ? 'Get started by creating your first page.'
            : 'There are no pages available in this classroom yet.'}
        </p>

        {canEdit && (
          <button
            onClick={handleCreatePage}
            disabled={isCreating}
            className={`inline-flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-colors ${
              isCreating
                ? 'bg-gray-200 dark:bg-gray-800 text-gray-500 dark:text-gray-500 cursor-not-allowed'
                : 'bg-primary-600 hover:bg-primary-700 text-white'
            }`}
          >
            <IconPlus size={20} />
            {isCreating ? 'Creating...' : 'Create First Page'}
          </button>
        )}
      </div>
    </div>
  );
};

export default EmptyPageState;
