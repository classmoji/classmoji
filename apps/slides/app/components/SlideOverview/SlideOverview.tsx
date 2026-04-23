import { useState, useCallback, useMemo, useEffect } from 'react';
import { DndContext, DragOverlay, pointerWithin, rectIntersection } from '@dnd-kit/core';
import type { CollisionDetection, DragStartEvent, DragEndEvent } from '@dnd-kit/core';
import { useSlideStructure } from './hooks/useSlideStructure';
import type { SlideData, StackData } from './hooks/useSlideStructure';
import SlideGrid from './SlideGrid';
import NewStackDropZone from './NewStackDropZone';
import SlideThumbnail from './SlideThumbnail';

/**
 * Custom collision detection that tries pointerWithin first,
 * then falls back to rectIntersection for better reliability
 */

interface SlideOverviewProps {
  revealInstance: RevealApi | null;
  onClose?: () => void;
  onContentChange?: () => void;
  onNavigate?: (stackIndex: number, slideIndex: number) => void;
}

const customCollisionDetection: CollisionDetection = args => {
  // First try pointer within - most precise
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) {
    return pointerCollisions;
  }

  // Fall back to rect intersection for cases where pointer detection fails
  return rectIntersection(args);
};

/**
 * SlideOverview - Full-screen slide management view
 *
 * Displays all slides as thumbnails in a grid, allowing:
 * - Drag to reorder slides and stacks
 * - Click to navigate to a slide
 * - Delete slides
 * - Create new stacks
 *
 * @param {Object} revealInstance - The Reveal.js instance (passed as state, not a ref)
 */
export default function SlideOverview({
  revealInstance,
  onClose,
  onContentChange,
  onNavigate,
}: SlideOverviewProps) {
  // Parse the current slide structure from Reveal.js DOM
  // Pass onContentChange so the hook can auto-sync after state updates
  const {
    stacks,
    setStacks: _setStacks,
    error,
    findSlideById,
    findStackById,
    moveSlide,
    moveStack,
    deleteSlide,
    createStack,
  } = useSlideStructure(revealInstance, onContentChange);

  // Track which item is being dragged
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<'slide' | 'stack' | null>(null); // 'slide' or 'stack'

  // Get the active item for DragOverlay
  const activeSlide = useMemo((): SlideData | null => {
    if (!activeId || activeType !== 'slide') return null;
    return findSlideById(activeId);
  }, [activeId, activeType, findSlideById]);

  const activeStack = useMemo((): StackData | null => {
    if (!activeId || activeType !== 'stack') return null;
    return findStackById(activeId);
  }, [activeId, activeType, findStackById]);

  // Handle drag start
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id as string);
    setActiveType((active.data.current?.type as 'slide' | 'stack') || 'slide');
  }, []);

  // Handle drag end
  // Note: syncToDOM and onContentChange are now called automatically by useSlideStructure
  // after state updates, so we just need to call the move functions
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      setActiveId(null);
      setActiveType(null);

      if (!over) return;

      const activeData = active.data.current as Record<string, unknown> | undefined;
      const overData = over.data.current as Record<string, unknown> | undefined;

      // Determine what was dragged and where
      if (activeData?.type === 'stack') {
        // Dragging a stack - can only drop between stacks
        if (overData?.type === 'stack-gap') {
          moveStack(active.id as string, overData.index as number);
        }
      } else {
        // Dragging a slide
        if (overData?.type === 'stack-gap') {
          // Drop between stacks - creates new single-slide stack
          moveSlide(active.id as string, { type: 'new-stack', index: overData.index as number });
        } else if (overData?.type === 'slide-gap') {
          // Drop between slides in a stack
          moveSlide(active.id as string, {
            type: 'into-stack',
            stackId: overData.stackId as string,
            index: overData.index as number,
          });
        } else if (overData?.type === 'new-stack-zone') {
          // Drop in "new stack" zone - creates new stack at end
          createStack(active.id as string);
        }
      }
    },
    [moveSlide, moveStack, createStack]
  );

  // Handle click on a slide thumbnail - navigate and close
  const handleSlideClick = useCallback(
    (slideId: string, stackIndex: number, slideIndex: number) => {
      onNavigate?.(stackIndex, slideIndex);
      onClose?.();
    },
    [onNavigate, onClose]
  );

  // Handle delete slide - sync is automatic via useSlideStructure
  const handleDeleteSlide = useCallback(
    (slideId: string) => {
      deleteSlide(slideId);
    },
    [deleteSlide]
  );

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-gray-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
        <h2 className="text-xl font-semibold text-white">Slide Overview</h2>
        <button
          onClick={onClose}
          className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
          title="Close (Esc)"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* DnD Context */}
      <DndContext
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        collisionDetection={customCollisionDetection}
      >
        {/* New Stack Drop Zone */}
        <NewStackDropZone isActive={activeType === 'slide'} />

        {/* Main Grid */}
        <div className="flex-1 overflow-auto p-6">
          {error ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="text-red-400 text-lg mb-2">⚠️ Error</div>
                <p className="text-gray-400 mb-4">{error}</p>
                <button
                  onClick={onClose}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg"
                >
                  Close
                </button>
              </div>
            </div>
          ) : stacks.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-4" />
                <p className="text-gray-400">Loading slides...</p>
              </div>
            </div>
          ) : (
            <SlideGrid
              stacks={stacks}
              onSlideClick={handleSlideClick}
              onDeleteSlide={handleDeleteSlide}
              activeId={activeId}
              activeType={activeType}
            />
          )}
        </div>

        {/* Drag Overlay - shows preview of dragged item */}
        <DragOverlay>
          {activeSlide && activeType === 'slide' && (
            <div className="opacity-80 rotate-3">
              <SlideThumbnail slide={activeSlide} isDragging />
            </div>
          )}
          {activeStack && activeType === 'stack' && (
            <div className="opacity-80 rotate-3">
              <div className="bg-gray-800 rounded-lg p-2 border-2 border-blue-500">
                <div className="text-xs text-gray-400 mb-1">
                  Stack ({activeStack.slides.length} slides)
                </div>
                {activeStack.slides.slice(0, 2).map((slide: SlideData) => (
                  <div key={slide.id} className="mb-1 last:mb-0">
                    <SlideThumbnail slide={slide} small />
                  </div>
                ))}
                {activeStack.slides.length > 2 && (
                  <div className="text-xs text-gray-500 text-center">
                    +{activeStack.slides.length - 2} more
                  </div>
                )}
              </div>
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
