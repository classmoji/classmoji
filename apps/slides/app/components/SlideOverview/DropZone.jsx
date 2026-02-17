import { useDroppable } from '@dnd-kit/core';

/**
 * DropZone - Visual drop target between items
 *
 * Shows a highlighted area when dragging over it.
 * Used for both stack-level gaps and slide-level gaps within stacks.
 */
export default function DropZone({
  id,
  type, // 'stack-gap' | 'slide-gap'
  index,
  stackId = null,
  isVertical = false,
  activeType = null,
}) {
  // Determine if this drop zone accepts the current drag type
  // This must be computed before useDroppable so we can disable non-accepting zones
  const canAccept =
    (type === 'stack-gap' && (activeType === 'slide' || activeType === 'stack')) ||
    (type === 'slide-gap' && activeType === 'slide');

  // IMPORTANT: Disable droppables that can't accept the current drag type
  // This prevents collision detection from finding slide-gaps when dragging stacks
  const { isOver, setNodeRef, active } = useDroppable({
    id,
    data: {
      type,
      index,
      stackId,
    },
    disabled: activeType !== null && !canAccept,
  });

  // Only show when actively dragging
  const showDropZone = active !== null;

  if (!showDropZone) {
    // Return a minimal spacer when not dragging
    return (
      <div
        className={isVertical ? 'h-2' : 'w-3 shrink-0'}
      />
    );
  }

  // Stack gaps are wider and more prominent
  const isStackGap = type === 'stack-gap';

  return (
    <div
      ref={setNodeRef}
      className={`
        ${isVertical
          ? 'h-8 w-full my-1'
          : isStackGap
            ? 'w-16 min-h-[120px] h-full mx-1 shrink-0 self-stretch'
            : 'w-8 min-h-[80px] shrink-0'
        }
        flex items-center justify-center
        transition-all duration-200
        rounded-lg
        ${canAccept
          ? isOver
            ? 'bg-blue-500/30 border-2 border-blue-500 border-dashed'
            : 'bg-gray-700/50 border-2 border-gray-500 border-dashed hover:bg-gray-600/50'
          : 'opacity-20'
        }
      `}
    >
      {/* Visual indicator */}
      <div
        className={`
          flex items-center justify-center
          transition-all duration-200
          ${isOver && canAccept ? 'scale-125' : ''}
        `}
      >
        {isOver && canAccept ? (
          // Plus icon when hovering
          <svg
            className="w-6 h-6 text-blue-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
        ) : canAccept ? (
          // Line indicator when not hovering
          <div
            className={`
              ${isVertical ? 'h-0.5 w-8' : 'w-0.5 h-8'}
              bg-gray-500 rounded-full
            `}
          />
        ) : null}
      </div>
    </div>
  );
}
