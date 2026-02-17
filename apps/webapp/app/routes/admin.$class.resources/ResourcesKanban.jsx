import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useFetcher, useRevalidator } from 'react-router';
import { Input, Switch } from 'antd';
import { IconSearch, IconFile, IconPresentation } from '@tabler/icons-react';
import { useResourcesBoard } from './useResourcesBoard';
import { ModuleColumn, SourceColumn } from './KanbanColumn';
import KanbanCard from './KanbanCard';

const ResourcesKanban = ({ modules, pages, slides }) => {
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

  const handleDragStart = (event) => {
    const { resource, resourceType } = event.active.data.current;
    setActiveCard({ resource, resourceType });
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    setActiveCard(null);

    if (!over) return;

    const { resource, resourceType } = active.data.current;
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

  const handleRemoveLink = (linkId, resourceType) => {
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
      <div className="flex items-center gap-4 px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <Input
          prefix={<IconSearch size={16} className="text-gray-400" />}
          placeholder="Search resources..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="max-w-xs"
          allowClear
        />
        <div className="flex items-center gap-2">
          <Switch
            size="small"
            checked={showPages}
            onChange={setShowPages}
          />
          <IconFile size={16} className="text-gray-500 dark:text-gray-400" />
          <span className="text-sm text-gray-600 dark:text-gray-300">Pages</span>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            size="small"
            checked={showSlides}
            onChange={setShowSlides}
          />
          <IconPresentation size={16} className="text-gray-500 dark:text-gray-400" />
          <span className="text-sm text-gray-600 dark:text-gray-300">Slides</span>
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
          <div className="flex-shrink-0 p-4 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 overflow-y-auto">
            <SourceColumn pages={allPages} slides={allSlides} />
          </div>

          {/* Scrollable modules area */}
          <div className="flex-1 flex gap-4 p-4 overflow-x-auto overflow-y-auto">
            {modules.map(module => {
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
              <div className="flex items-center justify-center flex-1 text-gray-400 dark:text-gray-500">
                No modules available. Create a module first.
              </div>
            )}
          </div>
        </div>

        {/* Drag overlay */}
        <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
          {activeCard && (
            <KanbanCard
              resource={activeCard.resource}
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
