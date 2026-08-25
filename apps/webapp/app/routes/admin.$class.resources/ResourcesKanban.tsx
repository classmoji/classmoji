import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useFetcher } from 'react-router';
import { useEffect } from 'react';
import { Input, Switch } from 'antd';
import { useCallout } from '@classmoji/ui-components';
import { IconSearch, IconFile, IconPresentation } from '@tabler/icons-react';
import { useResourcesBoard } from './useResourcesBoard';
import { ModuleColumn, SourceColumn } from './KanbanColumn';
import KanbanCard from './KanbanCard';

interface Resource {
  id: string;
  title: string;
  links?: Array<{ id: string; repository_id: string | null; assignment_id: string | null }>;
  [key: string]: unknown;
}

interface Repository {
  id: string;
  title: string;
  assignments?: Array<{ id: string; title: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface ResourcesKanbanProps {
  repositories: Repository[];
  pages: Resource[];
  slides: Resource[];
}

const ResourcesKanban = ({ repositories, pages, slides }: ResourcesKanbanProps) => {
  const fetcher = useFetcher();
  const callout = useCallout();

  // The action RETURNS its failures rather than throwing them (a thrown
  // Response would skip fetcher.data and take over the page via the root error
  // boundary), so a rejected link surfaces here as a callout and the board
  // stays put. Returning also lets React Router revalidate on its own, which is
  // what refreshes the stale loader data behind a rejected duplicate drag.
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.error) {
      callout.show({ variant: 'error', title: fetcher.data.error, autoDismissMs: 3000 });
    }
    // `callout` is stable per CalloutProvider, so it is not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const {
    allPages,
    allSlides,
    getModuleResources,
    getAssignmentResources,
    isLinked,
    getLinkId,
    activeCard,
    setActiveCard,
    searchQuery,
    setSearchQuery,
    showPages,
    setShowPages,
    showSlides,
    setShowSlides,
  } = useResourcesBoard(repositories, pages, slides);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { resource, resourceType } = event.active.data.current as {
      resource: Resource;
      resourceType: string;
    };
    setActiveCard({ resource, resourceType });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveCard(null);

    if (!over) return;

    const { resource, resourceType } = active.data.current as {
      resource: Resource;
      resourceType: string;
    };
    const { targetType, targetId } = over.data.current || {};

    if (!targetType || !targetId) return;

    // Drop-time duplicate check. It reads loader data that may be a moment
    // behind the server, so it is a courtesy, not the guard — the service
    // re-checks and reports `already_linked`, which lands in the callout above.
    if (isLinked(resource, resourceType, targetType, targetId)) {
      return;
    }

    // React Router revalidates once the action resolves, so the board refreshes
    // from the server rather than from a timer racing the manifest push.
    fetcher.submit(
      {
        resourceId: resource.id,
        resourceType,
        targetType,
        targetId,
      },
      {
        method: 'post',
        action: '?/addLink',
        encType: 'application/json',
      }
    );
  };

  const handleDragCancel = () => {
    setActiveCard(null);
  };

  const handleRemoveLink = (linkId: string, resourceType: string) => {
    fetcher.submit(
      { linkId, resourceType },
      {
        method: 'post',
        action: '?/removeLink',
        encType: 'application/json',
      }
    );
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-4 px-6 py-3 border-b border-line bg-panel">
        <Input
          prefix={<IconSearch size={16} className="text-gray-400" />}
          placeholder="Search resources..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="max-w-xs"
          allowClear
        />
        <div className="h-5 w-px bg-line" />
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Switch size="small" checked={showPages} onChange={setShowPages} />
          <IconFile size={15} className="text-ink-3" />
          <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Pages</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Switch size="small" checked={showSlides} onChange={setShowSlides} />
          <IconPresentation size={15} className="text-ink-3" />
          <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Slides</span>
        </label>
      </div>

      {/* Kanban board */}
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="flex-1 flex overflow-hidden">
          {/* Fixed source column */}
          <div className="flex-shrink-0 p-4 border-r border-line bg-panel overflow-y-auto">
            <SourceColumn pages={allPages} slides={allSlides} />
          </div>

          {/* Scrollable repositories area */}
          <div className="flex-1 flex gap-4 p-4 overflow-x-auto overflow-y-auto">
            {repositories.map((repository: Repository) => {
              const { pages: modPages, slides: modSlides } = getModuleResources(repository.id);
              return (
                <ModuleColumn
                  key={repository.id}
                  repository={repository}
                  modulePages={modPages}
                  moduleSlides={modSlides}
                  assignments={repository.assignments || []}
                  getAssignmentResources={getAssignmentResources}
                  getLinkId={getLinkId}
                  onRemoveLink={handleRemoveLink}
                  isOver={false}
                />
              );
            })}
            {repositories.length === 0 && (
              <div className="flex items-center justify-center flex-1 text-sm text-ink-3">
                No repositories available. Create a repository first.
              </div>
            )}
          </div>
        </div>

        {/* Drag overlay */}
        <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
          {activeCard && (
            <KanbanCard
              resource={activeCard.resource as Parameters<typeof KanbanCard>[0]['resource']}
              resourceType={activeCard.resourceType}
              isDragOverlay={true}
            />
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
};

export default ResourcesKanban;
