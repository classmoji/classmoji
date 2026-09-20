/**
 * Drag and drop for the staff calendar — and the ONLY file in the calendar that
 * imports `@dnd-kit`.
 *
 * That is the point of the split: the student calendar renders the same grids
 * without this file, so the library never reaches a student's bundle. Anything
 * that imports it (or re-exports from it) drags ~40 KB into every student page
 * that shows a calendar, so the grids take render props instead and this layer
 * supplies them.
 */

import { useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { CSSProperties, ReactNode } from 'react';
import EventCard from './EventCard';
import { parseDropId } from './geometry';
import { eventKey, getEventTypeDarkText, getEventTypeLightBg } from './utils';
import type { CalendarView } from './useCalendarNavigation';
import type { CalendarEventWithLinks } from './types';

/**
 * Form-close items are deadlines for rendering, filtering and ICS export, but
 * they must never be dragged: the deadline-drop handler parses an assignment id
 * out of the event id and there is no assignment behind a form. A form's close
 * date is changed in the form builder.
 */
export const isDragLocked = (event: CalendarEventWithLinks) => Boolean(event.is_form_close);

/** Whether this event can be picked up at all, given the handlers in scope. */
export const canDragEvent = (
  event: CalendarEventWithLinks,
  canDragDeadlines: boolean,
  onEventDrop: unknown
): boolean => {
  if (isDragLocked(event)) return false;
  return event.is_deadline ? canDragDeadlines : Boolean(onEventDrop);
};

interface DraggableEventProps {
  event: CalendarEventWithLinks;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * The drag handle around one block.
 *
 * dnd-kit's `attributes` are deliberately NOT spread. They set `role="button"`
 * and `tabIndex={0}` on this wrapper, which would put a button around the
 * event's own button — a control inside a control, announced twice, and one
 * more tab stop per event. They buy nothing here either: keyboard dragging
 * needs a `KeyboardSensor`, and only a `PointerSensor` is configured. The event
 * stays keyboard-reachable through its own button, which opens the modal.
 */
export const DraggableEvent = ({
  event,
  children,
  disabled,
  className = '',
  style = {},
}: DraggableEventProps) => {
  const { listeners, setNodeRef, isDragging } = useDraggable({
    // One id per OCCURRENCE: a recurring event surfaces many times under one id.
    id: `event-${eventKey(event, 0)}`,
    data: { event },
    disabled,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      className={className}
      style={{ ...style, opacity: isDragging ? 0.5 : 1 }}
    >
      {children}
    </div>
  );
};

interface DroppableCellProps {
  id: string;
  children?: ReactNode;
  className: string;
  style?: CSSProperties;
  onMouseDown?: (e: React.MouseEvent) => void;
  onMouseEnter?: () => void;
}

export const DroppableCell = ({
  id,
  children,
  className,
  style,
  onMouseDown,
  onMouseEnter,
}: DroppableCellProps) => {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`${className} ${isOver ? '!bg-blue-50 dark:!bg-blue-900/20' : ''}`}
      style={style}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
    >
      {children}
    </div>
  );
};

interface CalendarDragLayerProps {
  /** Which grid is on screen — it decides what the drag overlay looks like. */
  view: CalendarView;
  showCreator?: boolean;
  onEventDrop?: ((event: CalendarEventWithLinks, newStart: Date, newEnd: Date) => void) | null;
  onDeadlineDrop?: ((event: CalendarEventWithLinks, newStart: Date) => void) | null;
  children: ReactNode;
}

const CalendarDragLayer = ({
  view,
  showCreator = false,
  onEventDrop,
  onDeadlineDrop,
  children,
}: CalendarDragLayerProps) => {
  const [activeEvent, setActiveEvent] = useState<CalendarEventWithLinks | null>(null);
  const [draggedWidth, setDraggedWidth] = useState<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 3px before a press becomes a drag, so a plain click still opens the
      // event rather than nudging it by a pixel.
      activationConstraint: { distance: 3 },
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const draggedEvent = event.active.data.current?.event as CalendarEventWithLinks | undefined;
    if (!draggedEvent) return;
    setActiveEvent(draggedEvent);
    const initialRect = event.active.rect.current?.initial;
    if (initialRect?.width) setDraggedWidth(initialRect.width);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveEvent(null);
    setDraggedWidth(null);

    if (!event.over) return;

    const draggedEvent = event.active.data.current!.event as CalendarEventWithLinks;
    const isDeadline = draggedEvent.is_deadline;

    // Belt and braces: the draggable is already disabled for form closes.
    if (isDragLocked(draggedEvent)) return;
    if (isDeadline && !onDeadlineDrop) return;
    if (!isDeadline && !onEventDrop) return;

    // The two id formats and this parser live together in geometry.ts, so a
    // change to one cannot leave the other behind.
    const target = parseDropId(String(event.over.id));
    if (!target) return;

    const newStartTime = new Date(target.date);
    if (target.view === 'week') {
      // The hour in a week drop id is an ABSOLUTE clock hour, never a row index.
      newStartTime.setHours(target.hour, 0, 0, 0);
    } else {
      // A month cell moves the date and keeps the event's time of day.
      const originalStart = new Date(draggedEvent.start_time);
      newStartTime.setHours(originalStart.getHours(), originalStart.getMinutes(), 0, 0);
    }

    if (isDeadline) {
      onDeadlineDrop!(draggedEvent, newStartTime);
      return;
    }

    const duration =
      new Date(draggedEvent.end_time).getTime() - new Date(draggedEvent.start_time).getTime();
    onEventDrop!(draggedEvent, newStartTime, new Date(newStartTime.getTime() + duration));
  };

  const handleDragCancel = () => {
    setActiveEvent(null);
    setDraggedWidth(null);
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {children}

      <DragOverlay dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
        {activeEvent ? (
          view === 'month' ? (
            <div
              className={`text-xs px-2 py-1 rounded shadow-lg opacity-90 ${getEventTypeLightBg(
                activeEvent.event_type
              )} ${getEventTypeDarkText(activeEvent.event_type)}`}
              style={{ width: draggedWidth || 'auto', cursor: 'grabbing' }}
            >
              <span className="truncate font-medium">{activeEvent.title}</span>
            </div>
          ) : (
            <div
              className="opacity-90 shadow-2xl"
              style={{ width: draggedWidth || 'auto', cursor: 'grabbing' }}
            >
              <EventCard event={activeEvent} showCreator={showCreator} compact />
            </div>
          )
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};

export default CalendarDragLayer;
