/**
 * The week grid: a day-name header, the all-day strip, and seven columns of
 * hour cells with the timed events drawn over them.
 *
 * Presentational and role-blind — the staff calendar makes each hour cell
 * droppable and each block draggable through the two render props, and the
 * drag-to-select rectangle is drawn by adding classes to the cells it is
 * handed. Nothing in here imports the drag layer, which is what keeps `@dnd-kit`
 * out of the student bundle.
 */

import { Fragment } from 'react';
import {
  WEEK_GRID_COLUMNS,
  heightForDuration,
  hourLabelParts,
  hoursInWindow,
  isOutsideWindow,
  monthDropId,
  remForHours,
  topForHour,
  weekDropId,
} from './geometry';
import { DAY_LABELS, eventKey, isSameDay } from './utils';
import EventCard from './EventCard';
import AllDayStrip from './AllDayStrip';
import { NowBadge, NowMarker, NowRule } from './NowIndicator';
import { defaultRenderCell, defaultRenderEvent } from './gridRenderProps';
import type { RenderCell, RenderEvent } from './gridRenderProps';
import type { CalendarEventWithLinks } from './types';

interface WeekGridProps {
  /** Sunday…Saturday of the week on screen. */
  dates: Date[];
  /** Ticks once a minute, from `useCalendarNavigation`. */
  now: Date;
  eventsFor: (date: Date) => CalendarEventWithLinks[];
  onEventClick?: (event: CalendarEventWithLinks) => void;
  showCreator?: boolean;
  renderEvent?: RenderEvent;
  renderCell?: RenderCell;
}

const WeekGrid = ({
  dates,
  now,
  eventsFor,
  onEventClick,
  showCreator = false,
  renderEvent = defaultRenderEvent,
  renderCell = defaultRenderCell,
}: WeekGridProps) => {
  const hours = hoursInWindow();
  const nowHourFloat = now.getHours() + now.getMinutes() / 60;
  const nowTop = topForHour(nowHourFloat);

  // Every piece of the now indicator hangs off this one check. The staff grid
  // gated only the per-column line, so its full-width rule and its gutter badge
  // drew on whatever week you had paged to.
  const showNow =
    dates.some(date => isSameDay(date, now)) &&
    nowHourFloat >= hours[0] &&
    nowHourFloat <= hours[hours.length - 1] + 1;

  return (
    // Min width keeps the seven columns and the gutter readable on phones; the
    // shell scrolls horizontally rather than collapsing them.
    <div className="min-w-[48rem]">
      <div className="grid border-b border-line" style={{ gridTemplateColumns: WEEK_GRID_COLUMNS }}>
        <div />
        {dates.map((date, idx) => {
          const isDayToday = isSameDay(date, now);
          return (
            <div key={monthDropId(date)} className="flex flex-col items-center py-4">
              <span className="text-xs font-semibold tracking-[0.16em] text-ink-4">
                {DAY_LABELS[idx]}
              </span>
              <span
                className={`mt-2 flex items-center justify-center w-8 h-8 rounded-full text-sm font-semibold ${
                  isDayToday ? 'text-white' : 'text-ink-1'
                }`}
                style={isDayToday ? { backgroundColor: 'var(--accent)' } : undefined}
              >
                {date.getDate()}
              </span>
            </div>
          );
        })}
      </div>

      <AllDayStrip
        dates={dates}
        itemsFor={date => eventsFor(date).filter(event => isOutsideWindow(event))}
        onEventClick={onEventClick}
        renderEvent={renderEvent}
        renderCell={renderCell}
      />

      <div className="relative">
        {showNow && <NowRule top={nowTop} />}
        <div className="grid" style={{ gridTemplateColumns: WEEK_GRID_COLUMNS }}>
          {/* Hour gutter: the labels are absolutely placed so they sit ON the
              hour line rather than inside the row below it. */}
          <div className="relative" style={{ height: remForHours(hours.length) }}>
            {hours.map(hour => {
              const { hour: label, suffix } = hourLabelParts(hour);
              return (
                <div
                  key={hour}
                  className="absolute right-3 text-xs font-medium text-ink-4 flex flex-col items-end leading-tight"
                  style={{ top: `calc(${topForHour(hour)} + 4px)` }}
                >
                  <span>{label}</span>
                  <span>{suffix}</span>
                </div>
              );
            })}
            {showNow && <NowBadge now={now} top={nowTop} />}
          </div>

          {dates.map((date, dayIdx) => {
            const timed = eventsFor(date).filter(event => !isOutsideWindow(event));
            return (
              <div key={monthDropId(date)} className="relative border-l border-line">
                {hours.map(hour => (
                  <Fragment key={hour}>
                    {renderCell({
                      dropId: weekDropId(date, hour),
                      date,
                      hour,
                      dayIndex: dayIdx,
                      className: 'border-b border-line last:border-b-0 transition-colors',
                      style: { height: remForHours(1) },
                    })}
                  </Fragment>
                ))}

                {/* Blocks float over the cells: the cells stay droppable and
                    drag-selectable everywhere a block does not cover. */}
                <div className="absolute inset-0 pointer-events-none">
                  {timed.map((event, idx) => {
                    const start = new Date(event.start_time);
                    const end = new Date(event.end_time);
                    const startHour = start.getHours() + start.getMinutes() / 60;
                    const durationHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);

                    return (
                      <Fragment key={eventKey(event, idx)}>
                        {renderEvent({
                          event,
                          placement: 'week',
                          className: 'absolute left-1 right-1 pointer-events-auto',
                          style: {
                            top: topForHour(startHour),
                            height: heightForDuration(durationHours),
                          },
                          children: (
                            <EventCard
                              event={event}
                              onClick={onEventClick}
                              showCreator={showCreator}
                              compact
                            />
                          ),
                        })}
                      </Fragment>
                    );
                  })}
                </div>

                {showNow && isSameDay(date, now) && <NowMarker top={nowTop} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default WeekGrid;
