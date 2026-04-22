import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { IconFolder, IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import KanbanCard from './KanbanCard';

interface ResourceLink {
  id: string;
  module_id: string | null;
  assignment_id: string | null;
}

interface Resource {
  id: string;
  title: string;
  links?: ResourceLink[];
  [key: string]: unknown;
}

interface DropZoneProps {
  id: string;
  targetType: string;
  targetId: string;
  isOver: boolean;
  children: React.ReactNode;
  hasResources: boolean;
}

const DropZone = ({ id, targetType, targetId, isOver, children, hasResources }: DropZoneProps) => {
  const { setNodeRef, isOver: isOverThis } = useDroppable({
    id,
    data: { targetType, targetId },
  });

  const showEmptyState = !hasResources;
  const isActive = isOver || isOverThis;

  return (
    <div
      ref={setNodeRef}
      className={`
        p-2 space-y-1.5 min-h-[60px] rounded-md transition-colors duration-150
        ${isActive ? 'bg-primary/5 ring-2 ring-primary/20' : ''}
      `}
    >
      {children}
      {showEmptyState && (
        <div
          className={`
          flex items-center justify-center h-12 border border-dashed rounded-md
          text-xs text-ink-3 dark:text-ink-2
          ${isActive ? 'border-primary bg-primary/5' : 'border-line dark:border-line'}
        `}
        >
          {isActive ? 'Drop here' : 'Drop resources'}
        </div>
      )}
    </div>
  );
};

interface AssignmentRef {
  id: string;
  title: string;
}

interface AssignmentSectionProps {
  assignment: AssignmentRef;
  moduleId: string;
  pages: Resource[];
  slides: Resource[];
  getLinkId: (
    resource: Resource,
    targetType: string,
    targetId: string
  ) => string | null | undefined;
  onRemoveLink: (linkId: string, resourceType: string) => void;
  isOver: boolean;
}

const AssignmentSection = ({
  assignment,
  moduleId: _moduleId,
  pages,
  slides,
  getLinkId,
  onRemoveLink,
  isOver,
}: AssignmentSectionProps) => {
  const [expanded, setExpanded] = useState(true);
  const count = pages.length + slides.length;

  return (
    <div className="border-t border-line-cool dark:border-line">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-paper dark:hover:bg-gray-700/50 transition-colors"
      >
        {expanded ? (
          <IconChevronDown size={14} className="text-ink-3" />
        ) : (
          <IconChevronRight size={14} className="text-ink-3" />
        )}
        <span className="flex-1 text-sm text-ink-2 dark:text-ink-3 truncate">
          {assignment.title}
        </span>
        <span className="text-xs text-ink-3 bg-paper-2 dark:bg-paper-2 px-1.5 py-0.5 rounded">
          {count}
        </span>
      </button>
      {expanded && (
        <DropZone
          id={`assignment-${assignment.id}`}
          targetType="assignment"
          targetId={assignment.id}
          isOver={isOver}
          hasResources={count > 0}
        >
          {pages.map((page: Resource) => (
            <KanbanCard
              key={`page-${page.id}-assignment-${assignment.id}`}
              resource={page}
              resourceType="page"
              linkId={getLinkId(page, 'assignment', assignment.id)}
              onRemove={onRemoveLink}
              draggable={false}
            />
          ))}
          {slides.map((slide: Resource) => (
            <KanbanCard
              key={`slide-${slide.id}-assignment-${assignment.id}`}
              resource={slide}
              resourceType="slide"
              linkId={getLinkId(slide, 'assignment', assignment.id)}
              onRemove={onRemoveLink}
              draggable={false}
            />
          ))}
        </DropZone>
      )}
    </div>
  );
};

interface ModuleColumnProps {
  module: { id: string; title: string };
  modulePages: Resource[];
  moduleSlides: Resource[];
  assignments: AssignmentRef[];
  getAssignmentResources: (assignmentId: string) => { pages: Resource[]; slides: Resource[] };
  getLinkId: (
    resource: Resource,
    targetType: string,
    targetId: string
  ) => string | null | undefined;
  onRemoveLink: (linkId: string, resourceType: string) => void;
  isOver: boolean;
}

const ModuleColumn = ({
  module,
  modulePages,
  moduleSlides,
  assignments,
  getAssignmentResources,
  getLinkId,
  onRemoveLink,
  isOver,
}: ModuleColumnProps) => {
  const moduleCount = modulePages.length + moduleSlides.length;
  const totalCount = assignments.reduce((sum: number, a: AssignmentRef) => {
    const { pages, slides } = getAssignmentResources(a.id);
    return sum + pages.length + slides.length;
  }, moduleCount);

  return (
    <div className="flex flex-col flex-shrink-0 min-w-[300px] max-w-[340px] bg-panel dark:bg-panel rounded-lg border border-line dark:border-line shadow-sm">
      {/* Module Header */}
      <div className="px-4 py-3 border-b border-line-cool dark:border-line flex items-center gap-2">
        <IconFolder size={18} className="text-ink-2 dark:text-ink-3" />
        <span className="flex-1 font-medium text-ink-0 dark:text-ink-1 truncate">
          {module.title}
        </span>
        <span className="text-xs text-ink-3 bg-paper-2 dark:bg-paper-2 px-2 py-0.5 rounded-full">
          {totalCount}
        </span>
      </div>

      {/* Module-level drop zone */}
      <div className="px-2 pt-2">
        <div className="text-xs text-ink-3 dark:text-ink-2 px-1 mb-1 uppercase tracking-wide">
          Module Level
        </div>
        <DropZone
          id={`module-${module.id}`}
          targetType="module"
          targetId={module.id}
          isOver={isOver}
          hasResources={moduleCount > 0}
        >
          {modulePages.map(page => (
            <KanbanCard
              key={`page-${page.id}-module-${module.id}`}
              resource={page}
              resourceType="page"
              linkId={getLinkId(page, 'module', module.id)}
              onRemove={onRemoveLink}
              draggable={false}
            />
          ))}
          {moduleSlides.map(slide => (
            <KanbanCard
              key={`slide-${slide.id}-module-${module.id}`}
              resource={slide}
              resourceType="slide"
              linkId={getLinkId(slide, 'module', module.id)}
              onRemove={onRemoveLink}
              draggable={false}
            />
          ))}
        </DropZone>
      </div>

      {/* Assignments */}
      {assignments.length > 0 && (
        <div className="mt-2">
          <div className="text-xs text-ink-3 dark:text-ink-2 px-3 mb-1 uppercase tracking-wide">
            Assignments
          </div>
          {assignments.map((assignment: AssignmentRef) => {
            const { pages, slides } = getAssignmentResources(assignment.id);
            return (
              <AssignmentSection
                key={assignment.id}
                assignment={assignment}
                moduleId={module.id}
                pages={pages}
                slides={slides}
                getLinkId={getLinkId}
                onRemoveLink={onRemoveLink}
                isOver={isOver}
              />
            );
          })}
        </div>
      )}

      {/* Bottom padding */}
      <div className="h-2" />
    </div>
  );
};

interface SourceColumnProps {
  pages: Resource[];
  slides: Resource[];
}

const SourceColumn = ({ pages, slides }: SourceColumnProps) => {
  const count = pages.length + slides.length;

  return (
    <div className="flex flex-col w-[280px] min-w-[280px] bg-paper dark:bg-paper rounded-lg border border-line dark:border-line">
      {/* Header */}
      <div className="px-4 py-3 border-b border-line dark:border-line flex items-center gap-2 bg-paper-2 dark:bg-panel rounded-t-lg">
        <span className="flex-1 font-medium text-ink-1 dark:text-ink-1">All Resources</span>
        <span className="text-xs text-ink-2 bg-line dark:bg-paper-2 px-2 py-0.5 rounded-full">
          {count}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 p-2 space-y-1.5 overflow-y-auto">
        {pages.map(page => (
          <KanbanCard
            key={`source-page-${page.id}`}
            resource={page}
            resourceType="page"
            showUnlinkedWarning={true}
            dragIdPrefix="source"
          />
        ))}
        {slides.map(slide => (
          <KanbanCard
            key={`source-slide-${slide.id}`}
            resource={slide}
            resourceType="slide"
            showUnlinkedWarning={true}
            dragIdPrefix="source"
          />
        ))}
        {count === 0 && (
          <div className="text-center text-sm text-ink-3 dark:text-ink-2 py-8">
            No resources available
          </div>
        )}
      </div>
    </div>
  );
};

export { ModuleColumn, SourceColumn };
