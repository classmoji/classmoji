import { useDraggable } from '@dnd-kit/core';
import SlideThumbnail from './SlideThumbnail';
import DropZone from './DropZone';
import type { StackData, SlideData } from './hooks/useSlideStructure';

/** An agent's recent change to a slide: its name and colour, numbered per batch. */
export interface SlideAgentTouch {
  name: string;
  color: string;
  batch: number;
}

/** Live editing: who holds a slide, who is on it, and an agent's recent change. */
export interface SlideCollabBadge {
  lock: { name: string; color: string; mine: boolean } | null;
  peers: Array<{ key: string; name: string; color: string; agent?: boolean; agentTag?: string }>;
  agentTouch?: SlideAgentTouch | null;
}

type BadgesFor = (slideId: string | null) => SlideCollabBadge | null;

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return (
    (words[0][0] ?? '') + (words.length > 1 ? (words[words.length - 1][0] ?? '') : '')
  ).toUpperCase();
}

function CollabBadge({ badge }: { badge: SlideCollabBadge }) {
  return (
    <div className="pointer-events-none absolute top-1 right-1 z-10 flex items-center gap-1">
      {badge.lock && !badge.lock.mine && (
        <span
          className="flex items-center gap-1 rounded-full bg-white/95 py-0.5 pl-0.5 pr-1.5 text-[10px] font-semibold text-amber-900 ring-1 ring-amber-300 dark:bg-gray-800/95 dark:text-amber-100 dark:ring-amber-600"
          title={`${badge.lock.name} is editing`}
          role="img"
          aria-label={`${badge.lock.name} is editing`}
          data-testid="overview-lock-badge"
        >
          <span
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[8px] text-white"
            style={{ backgroundColor: badge.lock.color }}
          >
            {initials(badge.lock.name)}
          </span>
          Editing
        </span>
      )}
      {badge.peers.map(peer => (
        <span
          key={peer.key}
          title={peer.agent ? `${peer.name} (${peer.agentTag ?? 'agent'})` : peer.name}
          role="img"
          aria-label={peer.agent ? `${peer.name} (${peer.agentTag ?? 'agent'})` : peer.name}
          className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-semibold text-white ring-1 ${
            peer.agent ? 'ring-violet-500' : 'ring-white dark:ring-gray-800'
          }`}
          style={{ backgroundColor: peer.color }}
        >
          {initials(peer.name)}
        </span>
      ))}
    </div>
  );
}

interface SlideGridProps {
  stacks: StackData[];
  onSlideClick: (slideId: string, stackIndex: number, slideIndex: number) => void;
  onDeleteSlide: (slideId: string) => void;
  activeId: string | null;
  activeType: 'slide' | 'stack' | null;
  collabBadges?: BadgesFor;
}

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
  collabBadges,
}: SlideGridProps) {
  // Count total slides to know if we can delete
  const totalSlides = stacks.reduce((sum: number, stack) => sum + stack.slides.length, 0);
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
        collabBadges={collabBadges}
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

  return <div className="flex items-stretch gap-0 overflow-x-auto pb-4">{items}</div>;
}

/**
 * DraggableStack - A stack container with drag handle
 */
interface DraggableStackProps {
  stack: StackData;
  stackIndex: number;
  onSlideClick: (slideId: string, stackIndex: number, slideIndex: number) => void;
  onDeleteSlide: (slideId: string) => void;
  activeId: string | null;
  activeType: 'slide' | 'stack' | null;
  canDelete: boolean;
  collabBadges?: BadgesFor;
}

function DraggableStack({
  stack,
  stackIndex,
  onSlideClick,
  onDeleteSlide,
  activeId,
  activeType,
  canDelete,
  collabBadges,
}: DraggableStackProps) {
  // Stack is draggable via the handle
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
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
          <path d="M7 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
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
              collabBadges={collabBadges}
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
interface DraggableSlideProps {
  slide: SlideData;
  stackIndex: number;
  slideIndex: number;
  onSlideClick: (slideId: string, stackIndex: number, slideIndex: number) => void;
  onDeleteSlide: (slideId: string) => void;
  activeId: string | null;
  canDelete: boolean;
  isInStack: boolean;
  collabBadges?: BadgesFor;
}

function DraggableSlide({
  slide,
  stackIndex,
  slideIndex,
  onSlideClick,
  onDeleteSlide,
  activeId,
  canDelete,
  isInStack,
  collabBadges,
}: DraggableSlideProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: slide.id,
    data: { type: 'slide' },
  });
  const badge = collabBadges?.(slide.element.getAttribute('data-cm-id')) ?? null;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`
        relative cursor-grab active:cursor-grabbing
        ${isDragging ? 'opacity-50' : ''}
        ${activeId === slide.id ? 'ring-2 ring-blue-500 rounded-lg' : ''}
      `}
    >
      <SlideThumbnail
        slide={slide}
        isDragging={isDragging}
        isInStack={isInStack}
        // A slide someone else is editing can't be deleted from here.
        canDelete={canDelete && !(badge?.lock && !badge.lock.mine)}
        onClick={() => onSlideClick(slide.id, stackIndex, slideIndex)}
        onDelete={() => onDeleteSlide(slide.id)}
      />
      {badge && <CollabBadge badge={badge} />}
      {/* Keyed by batch: a new change restarts the fade. */}
      {badge?.agentTouch && (
        <AgentTouchMark key={badge.agentTouch.batch} touch={badge.agentTouch} />
      )}
    </div>
  );
}

/** A thumbnail an agent just changed: a frame and a name chip in its colour, fading out. */
function AgentTouchMark({ touch }: { touch: SlideAgentTouch }) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 rounded-lg motion-safe:animate-[cm-agent-touch-fade_5s_ease-out_forwards]"
      style={{ boxShadow: `0 0 0 2px ${touch.color}` }}
      data-testid="agent-touch"
      data-agent-name={touch.name}
      aria-hidden
    >
      <span className="absolute bottom-1 right-1 flex max-w-[75%] items-center gap-1 truncate rounded-full bg-white/95 py-px pl-1 pr-1.5 text-[10px] font-semibold text-gray-800 shadow-sm ring-1 ring-gray-200 dark:bg-gray-800/95 dark:text-gray-100 dark:ring-gray-700">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: touch.color }} />
        <span className="truncate">{touch.name}</span>
      </span>
    </div>
  );
}
