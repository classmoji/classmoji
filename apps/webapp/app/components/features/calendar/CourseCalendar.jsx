import { useState, useMemo, useEffect } from 'react';
import useLocalStorageState from 'use-local-storage-state';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { DndContext, DragOverlay, useDraggable, useDroppable, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import EventCard from './EventCard';
import {
  getMonthDates,
  getWeekDates,
  getMonthName,
  getYear,
  addMonths,
  addWeeks,
  isToday,
  isCurrentMonth,
  groupEventsByDate,
  sortEventsByTime,
  filterEventsByType,
  getShortDayName,
  getEventTypeLightBg,
  getEventTypeDarkText,
  getEventTypeDotColor,
  getEventTypeLabel,
} from './utils';

const EVENT_TYPES = ['OFFICE_HOURS', 'LECTURE', 'LAB', 'ASSESSMENT', 'DEADLINE'];

// Draggable event component
const DraggableEvent = ({ event, children, disabled, className = '', style = {} }) => {
  // For recurring events, include occurrence_date in ID to make each occurrence unique
  const eventId = event.occurrence_date
    ? `event-${event.id}-${new Date(event.occurrence_date).toISOString().split('T')[0]}`
    : `event-${event.id}`;

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: eventId,
    data: { event }, // Wrap in object to preserve it
    disabled,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={className}
      style={{ ...style, opacity: isDragging ? 0.5 : 1 }}
    >
      {children}
    </div>
  );
};

// Droppable cell component
const DroppableCell = ({ id, children, className, onClick }) => {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`${className} ${isOver ? '!bg-blue-50 dark:!bg-blue-900/20' : ''}`}
      onClick={onClick}
    >
      {children}
    </div>
  );
};

const CourseCalendar = ({ events, onEventClick, onCellClick, onEventDrop, onDeadlineDrop, onMonthChange, showCreator = false, canDragDeadlines = false }) => {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useLocalStorageState('classmoji-calendar-view', {
    defaultValue: 'week',
  }); // 'month' or 'week'
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [activeEvent, setActiveEvent] = useState(null);
  const [draggedWidth, setDraggedWidth] = useState(null);
  const [currentTime, setCurrentTime] = useState(new Date());

  // Configure sensors for better drag behavior
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 3, // 3px movement required before drag starts
      },
    })
  );

  // Filter events
  const filteredEvents = useMemo(() => {
    return filterEventsByType(events, selectedTypes);
  }, [events, selectedTypes]);

  // Group events by date
  const eventsByDate = useMemo(() => {
    return groupEventsByDate(filteredEvents);
  }, [filteredEvents]);

  // Get dates for current view
  const dates = useMemo(() => {
    return view === 'month' ? getMonthDates(currentDate) : getWeekDates(currentDate);
  }, [currentDate, view]);

  // Update current time every minute for the time indicator
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);

    return () => clearInterval(interval);
  }, []);

  const handlePrevious = () => {
    const newDate = view === 'month' ? addMonths(currentDate, -1) : addWeeks(currentDate, -1);
    setCurrentDate(newDate);
    // Fetch events after state update (side effects should be outside setState)
    if (onMonthChange) {
      onMonthChange(newDate.getFullYear(), newDate.getMonth());
    }
  };

  const handleNext = () => {
    const newDate = view === 'month' ? addMonths(currentDate, 1) : addWeeks(currentDate, 1);
    setCurrentDate(newDate);
    // Fetch events after state update (side effects should be outside setState)
    if (onMonthChange) {
      onMonthChange(newDate.getFullYear(), newDate.getMonth());
    }
  };

  const handleToday = () => {
    const today = new Date();
    setCurrentDate(today);
    if (onMonthChange) {
      onMonthChange(today.getFullYear(), today.getMonth());
    }
  };

  const getEventsForDate = (date) => {
    const key = new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
    const dayEvents = eventsByDate[key] || [];
    return sortEventsByTime(dayEvents);
  };

  const handleDragStart = (event) => {
    const draggedEvent = event.active.data.current?.event;
    if (draggedEvent) {
      setActiveEvent(draggedEvent);
      // Capture the width of the dragged element
      const rect = event.active.rect?.current?.initial || event.active.rect;
      if (rect?.width) {
        setDraggedWidth(rect.width);
      }
    }
  };

  const handleDragEnd = (event) => {
    setActiveEvent(null);
    setDraggedWidth(null);

    if (!event.over) return;

    const draggedEvent = event.active.data.current.event; // Access the event from data.current
    const dropId = event.over.id;

    // Check if this is a deadline drop or regular event drop
    const isDeadline = draggedEvent.is_deadline;
    if (isDeadline && !onDeadlineDrop) return;
    if (!isDeadline && !onEventDrop) return;

    // Parse drop location from ID
    // Format: "month-YYYY-MM-DD" or "week-YYYY-MM-DD-HH"
    const parts = dropId.split('-');

    if (parts[0] === 'month') {
      // Month view drop
      const dropDate = new Date(parts[1], parseInt(parts[2]) - 1, parts[3]);
      const originalStart = new Date(draggedEvent.start_time);
      const newStartTime = new Date(dropDate);
      newStartTime.setHours(originalStart.getHours(), originalStart.getMinutes(), 0, 0);

      if (isDeadline) {
        onDeadlineDrop(draggedEvent, newStartTime);
      } else {
        const duration = new Date(draggedEvent.end_time) - new Date(draggedEvent.start_time);
        const newEndTime = new Date(newStartTime.getTime() + duration);
        onEventDrop(draggedEvent, newStartTime, newEndTime);
      }
    } else if (parts[0] === 'week') {
      // Week view drop
      const dropDate = new Date(parts[1], parseInt(parts[2]) - 1, parts[3]);
      const dropHour = parseInt(parts[4]);
      const newStartTime = new Date(dropDate);
      newStartTime.setHours(dropHour, 0, 0, 0);

      if (isDeadline) {
        onDeadlineDrop(draggedEvent, newStartTime);
      } else {
        const duration = new Date(draggedEvent.end_time) - new Date(draggedEvent.start_time);
        const newEndTime = new Date(newStartTime.getTime() + duration);
        onEventDrop(draggedEvent, newStartTime, newEndTime);
      }
    }
  };

  const handleDragCancel = () => {
    setActiveEvent(null);
    setDraggedWidth(null);
  };

  const renderMonthView = () => {
    const weeks = [];
    for (let i = 0; i < dates.length; i += 7) {
      weeks.push(dates.slice(i, i + 7));
    }

    return (
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
        {/* Header - Days of week */}
        <div className="grid grid-cols-7 border-b border-gray-200 dark:border-gray-700">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
            <div
              key={day}
              className="p-2 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
            >
              {day}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div>
          {weeks.map((week, weekIdx) => (
            <div key={weekIdx} className="grid grid-cols-7 border-b border-gray-200 dark:border-gray-700 last:border-b-0">
              {week.map((date, dayIdx) => {
                const dayEvents = getEventsForDate(date);
                const isInCurrentMonth = isCurrentMonth(date, currentDate);
                const isTodayDate = isToday(date);
                const dropId = `month-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

                return (
                  <DroppableCell
                    key={dayIdx}
                    id={dropId}
                    className={`min-h-[120px] p-2 border-r border-gray-200 dark:border-gray-700 last:border-r-0 transition-colors overflow-hidden ${
                      onCellClick ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50' : ''
                    } ${!isInCurrentMonth ? 'bg-gray-50/50 dark:bg-gray-900/50' : ''}`}
                    onClick={() => onCellClick?.(date)}
                  >
                    {/* Date number */}
                    <div className="flex items-center justify-end mb-1">
                      <span
                        className={`text-sm font-medium flex items-center justify-center w-7 h-7 rounded-full ${
                          isTodayDate
                            ? 'bg-secondary text-white'
                            : isInCurrentMonth
                            ? 'text-gray-900 dark:text-gray-100'
                            : 'text-gray-400 dark:text-gray-600'
                        }`}
                      >
                        {date.getDate()}
                      </span>
                    </div>

                    {/* Events */}
                    <div className="space-y-1">
                      {dayEvents.map((event, idx) => (
                        <DraggableEvent
                          key={event.occurrence_date ? `${event.id}-${new Date(event.occurrence_date).toISOString()}` : (event.id || idx)}
                          event={event}
                          disabled={event.is_deadline ? !canDragDeadlines : !onEventDrop}
                        >
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              onEventClick?.(event);
                            }}
                            className={`text-xs px-2 py-1 rounded transition-opacity truncate flex items-center gap-1 ${
                              (event.is_deadline && canDragDeadlines) || (!event.is_deadline && onEventDrop) ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
                            } hover:opacity-80 ${getEventTypeLightBg(event.event_type)} ${getEventTypeDarkText(event.event_type)} ${event.is_unpublished ? 'border border-dashed border-yellow-500' : ''}`}
                            title={event.is_deadline && canDragDeadlines ? 'Drag to change deadline' : undefined}
                          >
                            <span className="font-medium truncate">{event.title}</span>
                            {event.is_unpublished && (
                              <span className="shrink-0 text-[10px] px-1 rounded bg-yellow-200 dark:bg-yellow-800 text-yellow-800 dark:text-yellow-200">
                                Draft
                              </span>
                            )}
                          </div>
                        </DraggableEvent>
                      ))}
                    </div>
                  </DroppableCell>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderWeekView = () => {
    const timeSlots = [];
    for (let hour = 8; hour <= 22; hour++) {
      timeSlots.push(hour);
    }

    // Helper to check if event should be in all-day section (deadlines or outside 8AM-10PM)
    const isAllDayOrOutsideHours = (event) => {
      if (event.is_deadline) return true;
      const startHour = new Date(event.start_time).getHours();
      const endHour = new Date(event.end_time).getHours();
      // Event is outside visible hours if it starts before 8AM or after 10PM
      return startHour < 8 || startHour >= 22 || endHour < 8;
    };

    return (
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Header */}
        <div className="grid border-b border-gray-200 dark:border-gray-700" style={{ gridTemplateColumns: '4rem 1fr 1fr 1fr 1fr 1fr 1fr 1fr' }}>
          <div className="p-2 border-r border-gray-200 dark:border-gray-700" />
          {dates.map((date, idx) => {
            const isTodayDate = isToday(date);
            const isWeekend = date.getDay() === 0 || date.getDay() === 6;
            return (
              <div
                key={idx}
                className={`p-3 border-r border-gray-200 dark:border-gray-700 last:border-r-0 text-center ${isWeekend ? 'bg-gray-100/70 dark:bg-gray-800/40' : ''}`}
              >
                <div className={`text-xs font-medium uppercase tracking-wider ${isTodayDate ? 'text-secondary' : 'text-gray-500 dark:text-gray-400'}`}>
                  {getShortDayName(date)}
                </div>
                <div
                  className={`text-lg font-semibold mt-1 ${
                    isTodayDate
                      ? 'text-secondary'
                      : 'text-gray-900 dark:text-gray-100'
                  }`}
                >
                  {date.getDate()}
                </div>
              </div>
            );
          })}
        </div>

        {/* All-day / Deadlines row */}
        <div className="grid border-b border-gray-200 dark:border-gray-700" style={{ gridTemplateColumns: '4rem 1fr 1fr 1fr 1fr 1fr 1fr 1fr' }}>
          <div className="px-1 py-1.5 border-r border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 bg-gray-50/50 dark:bg-gray-800/30">
            All day
          </div>
          {dates.map((date, dayIdx) => {
            const dayEvents = getEventsForDate(date);
            const allDayEvents = dayEvents.filter(isAllDayOrOutsideHours);
            const isWeekend = date.getDay() === 0 || date.getDay() === 6;
            const allDayDropId = `month-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            return (
              <DroppableCell
                key={dayIdx}
                id={allDayDropId}
                className={`px-1 py-1 border-r border-gray-200 dark:border-gray-700 last:border-r-0 min-h-[2rem] overflow-hidden ${isWeekend ? 'bg-gray-100 dark:bg-gray-800/50' : 'bg-gray-50/50 dark:bg-gray-800/30'}`}
              >
                <div className="space-y-0.5">
                  {allDayEvents.slice(0, 3).map((event, idx) => (
                    <DraggableEvent
                      key={event.occurrence_date ? `${event.id}-${new Date(event.occurrence_date).toISOString()}` : (event.id || idx)}
                      event={event}
                      disabled={event.is_deadline ? !canDragDeadlines : !onEventDrop}
                    >
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          onEventClick?.(event);
                        }}
                        className={`text-xs px-1.5 py-0.5 rounded truncate hover:opacity-80 flex items-center gap-1 ${
                          (event.is_deadline && canDragDeadlines) || (!event.is_deadline && onEventDrop) ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
                        } ${getEventTypeLightBg(event.event_type)} ${getEventTypeDarkText(event.event_type)} ${event.is_unpublished ? 'border border-dashed border-yellow-500' : ''}`}
                        title={event.is_deadline && canDragDeadlines ? 'Drag to change deadline' : undefined}
                      >
                        <span className="font-medium truncate">{event.title}</span>
                        {event.is_unpublished && (
                          <span className="shrink-0 text-[10px] px-1 rounded bg-yellow-200 dark:bg-yellow-800 text-yellow-800 dark:text-yellow-200">
                            Draft
                          </span>
                        )}
                      </div>
                    </DraggableEvent>
                  ))}
                  {allDayEvents.length > 3 && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 px-1">
                      +{allDayEvents.length - 3} more
                    </div>
                  )}
                </div>
              </DroppableCell>
            );
          })}
        </div>

        {/* Grid */}
        <div className="overflow-x-auto relative">
          {/* Current time line across all columns */}
          {currentTime.getHours() >= 8 && currentTime.getHours() < 22 && (
            <div
              className="absolute left-0 right-0 pointer-events-none z-10"
              style={{
                top: `${((currentTime.getHours() + currentTime.getMinutes() / 60) - 8) * 4}rem`,
              }}
            >
              <div className="h-px bg-red-200/50 dark:bg-red-400/20" />
            </div>
          )}
          <div className="grid" style={{ gridTemplateColumns: '4rem 1fr 1fr 1fr 1fr 1fr 1fr 1fr' }}>
            {/* Time column */}
            <div className="border-r border-gray-200 dark:border-gray-700 relative">
              {timeSlots.map(hour => (
                <div
                  key={hour}
                  className="h-16 px-1 py-1 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 text-right"
                >
                  {hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`}
                </div>
              ))}
              {/* Current time badge */}
              {currentTime.getHours() >= 8 && currentTime.getHours() < 22 && (
                <div
                  className="absolute left-0.5 right-0.5 pointer-events-none z-20"
                  style={{
                    top: `${((currentTime.getHours() + currentTime.getMinutes() / 60) - 8) * 4}rem`,
                    transform: 'translateY(-50%)',
                  }}
                >
                  <div className="bg-red-500 text-white text-xs font-medium px-1 py-0.5 rounded-full text-center">
                    {currentTime.getHours() % 12 || 12}:{String(currentTime.getMinutes()).padStart(2, '0')}
                  </div>
                </div>
              )}
            </div>

            {/* Day columns */}
            {dates.map((date, dayIdx) => {
              const dayEvents = getEventsForDate(date);
              const isWeekend = date.getDay() === 0 || date.getDay() === 6;
              return (
                <div
                  key={dayIdx}
                  className={`border-r border-gray-200 dark:border-gray-700 last:border-r-0 relative ${isWeekend ? 'bg-gray-100/60 dark:bg-gray-800/40' : ''}`}
                >
                  {timeSlots.map(hour => {
                    const dropId = `week-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${String(hour).padStart(2, '0')}`;
                    return (
                      <DroppableCell
                        key={hour}
                        id={dropId}
                        className={`h-16 border-b border-gray-200 dark:border-gray-700 cursor-pointer transition-colors hover:bg-gray-100 dark:hover:bg-gray-800/50`}
                        onClick={() => {
                          const cellDate = new Date(date);
                          cellDate.setHours(hour, 0, 0, 0);
                          onCellClick?.(cellDate);
                        }}
                      />
                    );
                  })}
                  {/* Events overlay - only show timed events (not all-day/deadlines) */}
                  <div className="absolute inset-0 pointer-events-none">
                    {dayEvents.filter(e => !isAllDayOrOutsideHours(e)).map((event, idx) => {
                      const startTime = new Date(event.start_time);
                      const endTime = new Date(event.end_time);
                      const startHour = startTime.getHours() + startTime.getMinutes() / 60;
                      let duration = (endTime - startTime) / (1000 * 60 * 60);

                      // Ensure minimum height for short events
                      if (duration < 0.5) {
                        duration = 0.5; // Minimum 30 minutes display height
                      }

                      // Offset by 8 AM start time
                      const offsetHour = startHour - 8;

                      return (
                        <DraggableEvent
                          key={event.occurrence_date ? `${event.id}-${new Date(event.occurrence_date).toISOString()}` : (event.id || idx)}
                          event={event}
                          disabled={event.is_deadline ? !canDragDeadlines : !onEventDrop}
                          className={`absolute left-1 right-1 pointer-events-auto ${
                            (event.is_deadline && canDragDeadlines) || (!event.is_deadline && onEventDrop) ? 'cursor-grab active:cursor-grabbing' : ''
                          }`}
                          style={{
                            top: `${offsetHour * 4}rem`,
                            height: `${duration * 4}rem`,
                          }}
                        >
                          <EventCard
                            event={event}
                            onClick={onEventClick}
                            showCreator={showCreator}
                            compact={true}
                          />
                        </DraggableEvent>
                      );
                    })}
                  </div>
                  {/* Current time indicator */}
                  {isToday(date) && currentTime.getHours() >= 8 && currentTime.getHours() < 22 && (
                    <div
                      className="absolute left-0 right-0 pointer-events-none z-20 flex items-center"
                      style={{
                        top: `${((currentTime.getHours() + currentTime.getMinutes() / 60) - 8) * 4}rem`,
                        transform: 'translateY(-50%)',
                      }}
                    >
                      <div className="w-3 h-3 bg-red-500 rounded-full -ml-1.5 shrink-0" />
                      <div className="flex-1 h-0.5 bg-red-500" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  // Get week range for display
  const getWeekRangeText = () => {
    if (view !== 'week' || dates.length === 0) return '';
    const startDate = dates[0];
    const endDate = dates[dates.length - 1];
    const startMonth = getMonthName(startDate);
    const endMonth = getMonthName(endDate);

    if (startMonth === endMonth) {
      return `${startDate.getDate()} - ${endDate.getDate()}`;
    }
    return `${startMonth.slice(0, 3)} ${startDate.getDate()} - ${endMonth.slice(0, 3)} ${endDate.getDate()}`;
  };

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
      <div className="space-y-3">
      {/* Unified toolbar */}
      <div className="flex items-center justify-between bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
        {/* Left: Navigation */}
        <div className="flex items-center gap-1">
          <button
            onClick={handlePrevious}
            className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <IconChevronLeft size={18} />
          </button>
          <button
            onClick={handleToday}
            className="px-2.5 py-1 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
          >
            Today
          </button>
          <button
            onClick={handleNext}
            className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <IconChevronRight size={18} />
          </button>

          <div className="ml-3 text-base font-semibold text-gray-900 dark:text-gray-100">
            {getMonthName(currentDate)} {getYear(currentDate)}
            {view === 'week' && (
              <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
                {getWeekRangeText()}
              </span>
            )}
          </div>
        </div>

        {/* Center: Filters */}
        <div className="hidden md:flex items-center gap-1">
          {EVENT_TYPES.map(type => {
            const isActive = selectedTypes.length === 0 || selectedTypes.includes(type);
            return (
              <button
                key={type}
                onClick={() => {
                  if (selectedTypes.includes(type)) {
                    setSelectedTypes(selectedTypes.filter(t => t !== type));
                  } else {
                    setSelectedTypes([...selectedTypes, type]);
                  }
                }}
                className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all ${
                  isActive
                    ? 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                    : 'text-gray-400 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-500'
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${getEventTypeDotColor(type)} ${!isActive ? 'opacity-30' : ''}`} />
                {getEventTypeLabel(type)}
              </button>
            );
          })}
        </div>

        {/* Right: View toggle */}
        <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-md p-0.5">
          <button
            onClick={() => setView('month')}
            className={`px-3 py-1 text-xs font-medium rounded transition-all ${
              view === 'month'
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            Month
          </button>
          <button
            onClick={() => setView('week')}
            className={`px-3 py-1 text-xs font-medium rounded transition-all ${
              view === 'week'
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            Week
          </button>
        </div>
      </div>

      {/* Mobile filters (shown below toolbar on small screens) */}
      <div className="md:hidden flex items-center gap-1 overflow-x-auto pb-1">
        {EVENT_TYPES.map(type => {
          const isActive = selectedTypes.length === 0 || selectedTypes.includes(type);
          return (
            <button
              key={type}
              onClick={() => {
                if (selectedTypes.includes(type)) {
                  setSelectedTypes(selectedTypes.filter(t => t !== type));
                } else {
                  setSelectedTypes([...selectedTypes, type]);
                }
              }}
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-all ${
                isActive
                  ? 'text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800'
                  : 'text-gray-400 dark:text-gray-600'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${getEventTypeDotColor(type)} ${!isActive ? 'opacity-30' : ''}`} />
              {getEventTypeLabel(type)}
            </button>
          );
        })}
      </div>

      {/* Calendar view */}
      {view === 'month' ? renderMonthView() : renderWeekView()}

      </div>

      <DragOverlay
        dropAnimation={{
          duration: 200,
          easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
        }}
      >
        {activeEvent ? (
          view === 'month' ? (
            <div
              className={`text-xs px-2 py-1 rounded shadow-lg opacity-90 ${getEventTypeLightBg(activeEvent.event_type)} ${getEventTypeDarkText(activeEvent.event_type)}`}
              style={{
                width: draggedWidth || 'auto',
                cursor: 'grabbing',
              }}
            >
              <span className="truncate font-medium">{activeEvent.title}</span>
            </div>
          ) : (
            <div
              className="opacity-90 shadow-2xl"
              style={{
                width: draggedWidth || 'auto',
                cursor: 'grabbing',
              }}
            >
              <EventCard
                event={activeEvent}
                showCreator={showCreator}
                compact={true}
              />
            </div>
          )
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};

export default CourseCalendar;
