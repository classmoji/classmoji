import { useDraggable } from '@dnd-kit/core';
import SlideThumbnail from './SlideThumbnail';
import DropZone from './DropZone';

/**
 * SlideGrid - Horizontal grid of stacks
 *
 * Renders all stacks in a horizontal layout with drop zones between them.
 * Each stack can contain one or more slides in a vertical arrangement.
 */
export default function SlideGrid({
  stacks,
  onSlideClick,
  onDeleteSlide,
  activeId,
  activeType,
}) {
  // Count total slides to know if we can delete
  const totalSlides = stacks.reduce((sum, stack) => sum + stack.slides.length, 0);
  const canDelete = totalSlides > 1;

  // Interleave stacks with drop zones as flat array for proper flex stretching
  const items = [];

  // Initial drop zone
  items.push(
    <DropZone
      key="stack-gap-0"
      id="stack-gap-0"
      type="stack-gap"
      index={0}
      activeType={activeType}
    />
  );

  // Add stacks with drop zones after each
  stacks.forEach((stack, stackIndex) => {
    items.push(
      <DraggableStack
        key={stack.id}
        stack={stack}
        stackIndex={stackIndex}
        onSlideClick={onSlideClick}
        onDeleteSlide={onDeleteSlide}
        activeId={activeId}
        activeType={activeType}
        canDelete={canDelete}
      />
    );

    items.push(
      <DropZone
        key={`stack-gap-${stackIndex + 1}`}
        id={`stack-gap-${stackIndex + 1}`}
        type="stack-gap"
        index={stackIndex + 1}
        activeType={activeType}
      />
    );
  });

  return (
    <div className="flex items-stretch gap-0 overflow-x-auto pb-4">
      {items}
    </div>
  );
}

/**
 * DraggableStack - A stack container with drag handle
 */
function DraggableStack({
  stack,
  stackIndex,
  onSlideClick,
  onDeleteSlide,
  activeId,
  activeType,
  canDelete,
}) {
  // Stack is draggable via the handle
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useDraggable({
    id: stack.id,
    data: { type: 'stack' },
  });

  return (
    <div
      ref={setNodeRef}
      className={`
        bg-gray-800 rounded-lg p-3
        border-2 transition-all duration-200
        ${isDragging ? 'opacity-50 border-blue-500' : 'border-gray-700'}
        ${activeId === stack.id ? 'ring-2 ring-blue-500' : ''}
      `}
    >
      {/* Drag Handle */}
      <div
        {...attributes}
        {...listeners}
        className="flex items-center justify-center mb-2 py-1 cursor-grab active:cursor-grabbing
          bg-gray-700 rounded hover:bg-gray-600 transition-colors"
        title="Drag to reorder stack"
      >
        <svg className="w-5 h-5 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
          <path d="M7 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>
        </svg>
      </div>

      {/* Slides in the stack */}
      <div className="flex flex-col gap-0">
        {/* Initial slide drop zone */}
        <DropZone
          id={`slide-gap-${stack.id}-0`}
          type="slide-gap"
          index={0}
          stackId={stack.id}
          isVertical
          activeType={activeType}
        />

        {stack.slides.map((slide, slideIndex) => (
          <div key={slide.id}>
            <DraggableSlide
              slide={slide}
              stackIndex={stackIndex}
              slideIndex={slideIndex}
              onSlideClick={onSlideClick}
              onDeleteSlide={onDeleteSlide}
              activeId={activeId}
              canDelete={canDelete}
              isInStack={stack.slides.length > 1}
            />

            {/* Drop zone after each slide */}
            <DropZone
              id={`slide-gap-${stack.id}-${slideIndex + 1}`}
              type="slide-gap"
              index={slideIndex + 1}
              stackId={stack.id}
              isVertical
              activeType={activeType}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * DraggableSlide - Individual slide thumbnail that can be dragged
 */
function DraggableSlide({
  slide,
  stackIndex,
  slideIndex,
  onSlideClick,
  onDeleteSlide,
  activeId,
  canDelete,
  isInStack,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useDraggable({
    id: slide.id,
    data: { type: 'slide' },
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`
        cursor-grab active:cursor-grabbing
        ${isDragging ? 'opacity-50' : ''}
        ${activeId === slide.id ? 'ring-2 ring-blue-500 rounded-lg' : ''}
      `}
    >
      <SlideThumbnail
        slide={slide}
        isDragging={isDragging}
        isInStack={isInStack}
        canDelete={canDelete}
        onClick={() => onSlideClick(slide.id, stackIndex, slideIndex)}
        onDelete={() => onDeleteSlide(slide.id)}
      />
    </div>
  );
}
