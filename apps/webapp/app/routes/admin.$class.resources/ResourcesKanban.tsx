import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useFetcher, useRevalidator } from 'react-router';
import { Input, Switch } from 'antd';
import { IconSearch, IconFile, IconPresentation } from '@tabler/icons-react';
import { useResourcesBoard } from './useResourcesBoard';
import { ModuleColumn, SourceColumn } from './KanbanColumn';
import KanbanCard from './KanbanCard';

interface Resource {
  id: string;
  title: string;
  links?: Array<{ id: string; module_id: string | null; assignment_id: string | null }>;
  [key: string]: unknown;
}

interface Module {
  id: string;
  title: string;
  assignments?: Array<{ id: string; title: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface ResourcesKanbanProps {
  modules: Module[];
  pages: Resource[];
  slides: Resource[];
}

const ResourcesKanban = ({ modules, pages, slides }: ResourcesKanbanProps) => {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

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
  } = useResourcesBoard(modules, pages, slides);

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

    // Check if already linked
    if (isLinked(resource, resourceType, targetType, targetId)) {
      return;
    }

    // Submit to server
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

    // Revalidate to get updated data
    setTimeout(() => revalidator.revalidate(), 100);
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

    setTimeout(() => revalidator.revalidate(), 100);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Filters */}
      <div className="flex items-center gap-4 px-4 py-3 border-b border-line dark:border-line bg-panel dark:bg-panel">
        <Input
          prefix={<IconSearch size={16} className="text-ink-3" />}
          placeholder="Search resources..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="max-w-xs"
          allowClear
        />
        <div className="flex items-center gap-2">
          <Switch size="small" checked={showPages} onChange={setShowPages} />
          <IconFile size={16} className="text-ink-2 dark:text-ink-3" />
          <span className="text-sm text-ink-2 dark:text-ink-3">Pages</span>
        </div>
        <div className="flex items-center gap-2">
          <Switch size="small" checked={showSlides} onChange={setShowSlides} />
          <IconPresentation size={16} className="text-ink-2 dark:text-ink-3" />
          <span className="text-sm text-ink-2 dark:text-ink-3">Slides</span>
        </div>
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
          <div className="flex-shrink-0 p-4 border-r border-line dark:border-line bg-paper dark:bg-paper overflow-y-auto">
            <SourceColumn pages={allPages} slides={allSlides} />
          </div>

          {/* Scrollable modules area */}
          <div className="flex-1 flex gap-4 p-4 overflow-x-auto overflow-y-auto">
            {modules.map((module: Module) => {
              const { pages: modPages, slides: modSlides } = getModuleResources(module.id);
              return (
                <ModuleColumn
                  key={module.id}
                  module={module}
                  modulePages={modPages}
                  moduleSlides={modSlides}
                  assignments={module.assignments || []}
                  getAssignmentResources={getAssignmentResources}
                  getLinkId={getLinkId}
                  onRemoveLink={handleRemoveLink}
                  isOver={false}
                />
              );
            })}
            {modules.length === 0 && (
              <div className="flex items-center justify-center flex-1 text-ink-3 dark:text-ink-2">
                No modules available. Create a module first.
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
