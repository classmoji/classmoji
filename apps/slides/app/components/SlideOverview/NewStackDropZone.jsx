import { useDroppable } from '@dnd-kit/core';

/**
 * NewStackDropZone - Drop zone at the top for creating new stacks
 *
 * When a slide is dropped here, it creates a new single-slide stack
 * appended to the end of the presentation.
 */
export default function NewStackDropZone({ isActive }) {
  const { isOver, setNodeRef, active } = useDroppable({
    id: 'new-stack-zone',
    data: {
      type: 'new-stack-zone',
    },
  });

  // Only show prominently when dragging a slide
  const showProminent = active !== null && isActive;

  return (
    <div
      ref={setNodeRef}
      className={`
        mx-6 mt-2 mb-4
        border-2 border-dashed rounded-lg
        transition-all duration-200
        flex items-center justify-center
        ${showProminent
          ? isOver
            ? 'border-blue-500 bg-blue-900/30 py-6'
            : 'border-gray-500 bg-gray-800/50 py-4'
          : 'border-gray-700 py-2 opacity-50'
        }
      `}
    >
      <div className={`
        flex items-center gap-2 text-sm
        ${showProminent
          ? isOver
            ? 'text-blue-400'
            : 'text-gray-400'
          : 'text-gray-600'
        }
      `}>
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        <span>
          {isOver ? 'Release to create new stack' : 'Drop slide here to create new stack'}
        </span>
      </div>
    </div>
  );
}
