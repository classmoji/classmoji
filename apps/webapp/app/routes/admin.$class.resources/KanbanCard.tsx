import { useDraggable } from '@dnd-kit/core';
import { IconFile, IconPresentation, IconX, IconLinkOff } from '@tabler/icons-react';

interface KanbanCardProps {
  resource: {
    id: string;
    title: string;
    links?: Array<{ id: string; module_id: string | null; assignment_id: string | null }>;
    [key: string]: unknown;
  };
  resourceType: string;
  linkId?: string | null;
  onRemove?: ((linkId: string, resourceType: string) => void) | null;
  isDragOverlay?: boolean;
  showUnlinkedWarning?: boolean;
  draggable?: boolean;
  dragIdPrefix?: string | null;
}

const KanbanCard = ({
  resource,
  resourceType,
  linkId = null,
  onRemove = null,
  isDragOverlay = false,
  showUnlinkedWarning = false,
  draggable = true,
  dragIdPrefix = null,
}: KanbanCardProps) => {
  const dragId = dragIdPrefix
    ? `${dragIdPrefix}-${resourceType}-${resource.id}`
    : `${resourceType}-${resource.id}`;

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId,
    data: { resource, resourceType },
    disabled: isDragOverlay || !draggable,
  });

  const isPage = resourceType === 'page';
  const Icon = isPage ? IconFile : IconPresentation;
  const isUnlinked = showUnlinkedWarning && (!resource.links || resource.links.length === 0);

  // Subtle color coding: blue tint for pages, red tint for slides
  const colorClasses = isPage
    ? 'border-l-blue-400 bg-sky-bg/50 dark:bg-blue-950/20'
    : 'border-l-red-400 bg-rose-bg/50 dark:bg-red-950/20';

  const iconColorClass = isPage
    ? 'text-blue-500 dark:text-blue-400'
    : 'text-red-500 dark:text-red-400';

  return (
    <div
      ref={!isDragOverlay ? setNodeRef : undefined}
      {...(!isDragOverlay ? attributes : {})}
      {...(!isDragOverlay ? listeners : {})}
      className={`
        group flex items-center gap-2 px-3 py-2 rounded-md border border-l-[3px] text-sm
        ${colorClasses}
        border-line dark:border-line
        hover:border-line dark:hover:border-gray-600
        hover:shadow-sm
        transition-all duration-150
        ${isDragging && !isDragOverlay ? 'opacity-40' : ''}
        ${isDragOverlay ? 'shadow-lg ring-2 ring-primary/50' : ''}
        ${draggable && !isDragOverlay ? 'cursor-grab active:cursor-grabbing' : ''}
      `}
    >
      <Icon size={16} className={`flex-shrink-0 ${iconColorClass}`} />
      <span className="truncate flex-1 text-ink-1 dark:text-ink-1">{resource.title}</span>
      {isUnlinked && (
        <span title="Not linked to any module or assignment">
          <IconLinkOff size={14} className="text-ink-3 flex-shrink-0" />
        </span>
      )}
      {onRemove && linkId && (
        <button
          onClick={e => {
            e.stopPropagation();
            onRemove(linkId, resourceType);
          }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-paper-2 dark:hover:bg-gray-700 transition-opacity"
        >
          <IconX size={14} className="text-ink-3 hover:text-red-500" />
        </button>
      )}
    </div>
  );
};

export default KanbanCard;
