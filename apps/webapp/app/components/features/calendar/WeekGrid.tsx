/**
 * The week grid: a day-name header, the all-day strip, and seven columns of
 * hour cells with the timed events drawn over them — and, across each column,
 * a line at every deadline due inside the rendered hours.
 *
 * Presentational and role-blind — the staff calendar makes each hour cell
 * droppable and each block draggable through the two render props, and the
 * drag-to-select rectangle is drawn by adding classes to the cells it is
 * handed. Nothing in here imports the drag layer, which is what keeps `@dnd-kit`
 * out of the student bundle.
 */

import { Fragment, useEffect, useState } from 'react';
import {
  DEFAULT_END_HOUR,
  DEFAULT_START_HOUR,
  WEEK_GRID_COLUMNS,
  formatHourLabel,
  heightForBlock,
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
import { DeadlineLines, DeadlinePills, deadlineGroups } from './DeadlineMarkers';
import { NowBadge, NowMarker, NowRule } from './NowIndicator';
import { defaultRenderCell, defaultRenderEvent } from './gridRenderProps';
import { resourcesForEvent } from './ResourceLink';
import type { RenderCell, RenderEvent } from './gridRenderProps';
import type { RepositoryAssignmentLinkInfo } from './ResourceLink';
import type { CalendarEventWithLinks } from './types';

interface WeekGridProps {
  /** Sunday…Saturday of the week on screen. */
  dates: Date[];
  /** Ticks once a minute, from `useCalendarNavigation`. */
  now: Date;
  eventsFor: (date: Date) => CalendarEventWithLinks[];
  onEventClick?: (event: CalendarEventWithLinks) => void;
  /**
   * Keep the all-day strip on screen even on a week with nothing in it. Staff
   * only: the strip is the one drop target that moves an event to another day
   * WITHOUT rewriting its time (an hour cell snaps to the hour), so hiding it
   * when empty took that move away on exactly the weeks where it is needed.
   */
  alwaysShowAllDay?: boolean;
  /**
   * The clock hours to draw, from `geometry.hourRange` over the WHOLE loaded
   * event set — the month-sized payload, unfiltered by the type legend. Per
   * week it would resize the grid as you page; after the filter it would
   * resize as you toggle a chip.
   *
   * `endHour` is exclusive, so 24 means the last row is 11 PM.
   */
  startHour?: number;
  endHour?: number;
  /**
   * Where the chips on a block point. Threaded from the route, because the
   * grid itself knows neither the classroom nor the role looking at it.
   *
   * The last two are the viewer's own repository assignments, which turn a
   * linked assignment into a link to THEIR GitHub issue. Staff loaders do not
   * send them and should not: staff have no personal repo in the class.
   */
  classSlug?: string;
  rolePrefix?: string;
  pagesUrl?: string;
  slidesUrl?: string;
  gitOrgLogin?: string | null;
  repoAssignmentsByAssignmentId?: Record<string, RepositoryAssignmentLinkInfo | undefined>;
  renderEvent?: RenderEvent;
  renderCell?: RenderCell;
}

const WeekGrid = ({
  dates,
  now,
  eventsFor,
  onEventClick,
  alwaysShowAllDay = false,
  startHour = DEFAULT_START_HOUR,
  endHour = DEFAULT_END_HOUR,
  classSlug,
  rolePrefix,
  pagesUrl,
  slidesUrl,
  gitOrgLogin,
  repoAssignmentsByAssignmentId,
  renderEvent = defaultRenderEvent,
  renderCell = defaultRenderCell,
}: WeekGridProps) => {
  const linkContext = {
    classSlug,
    rolePrefix,
    pagesUrl,
    slidesUrl,
    gitOrgLogin,
    repoAssignmentsByAssignmentId,
  };
  const hours = hoursInWindow(startHour, endHour);
  const nowHourFloat = now.getHours() + now.getMinutes() / 60;
  const nowTop = topForHour(nowHourFloat, startHour);

  /**
   * The now indicator is client-only. Rendered on the server it would draw the
   * SERVER's clock — a different minute, and for a reader in another timezone a
   * different hour or day — which is both a hydration mismatch on the badge's
   * text and a visible jump as it corrects itself.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Every piece of the indicator hangs off this one check. The staff grid gated
  // only the per-column line, so its full-width rule and its gutter badge drew
  // on whatever week you had paged to.
  // `< endHour`, not `<=`: the end is EXCLUSIVE, and at exactly the end the
  // line would be drawn on the grid's bottom edge — a rule below the last row
  // rather than an indicator inside it.
  const showNow =
    mounted &&
    dates.some(date => isSameDay(date, now)) &&
    nowHourFloat >= startHour &&
    nowHourFloat < endHour;

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
        itemsFor={date =>
          eventsFor(date).filter(event => isOutsideWindow(event, startHour, endHour))
        }
        onEventClick={onEventClick}
        alwaysShow={alwaysShowAllDay}
        renderEvent={renderEvent}
        renderCell={renderCell}
      />

      <div className="relative">
        {showNow && <NowRule top={nowTop} />}
        <div className="grid" style={{ gridTemplateColumns: WEEK_GRID_COLUMNS }}>
          {/* Hour gutter: the labels are absolutely placed so they sit ON the
              hour line rather than inside the row below it. One line each —
              `8 AM`, not a stacked `8` over `AM`. */}
          <div className="relative" style={{ height: remForHours(hours.length) }}>
            {hours.map(hour => (
              <div
                key={hour}
                className="absolute right-3 text-xs font-medium text-ink-4 leading-tight whitespace-nowrap"
                style={{ top: `calc(${topForHour(hour, startHour)} + 4px)` }}
              >
                {formatHourLabel(hour)}
              </div>
            ))}
            {showNow && <NowBadge now={now} top={nowTop} />}
          </div>

          {dates.map((date, dayIdx) => {
            const dayEvents = eventsFor(date);
            const timed = dayEvents.filter(event => !isOutsideWindow(event, startHour, endHour));
            // Deadlines are in the strip too — this is the line, not a move.
            const deadlines = deadlineGroups(dayEvents, startHour, endHour, hourFloat =>
              topForHour(hourFloat, startHour)
            );
            return (
              <div key={monthDropId(date)} className="relative border-l border-line">
                {hours.map((hour, hourIdx) => (
                  <Fragment key={hour}>
                    {renderCell({
                      dropId: weekDropId(date, hour),
                      date,
                      hour,
                      dayIndex: dayIdx,
                      // The last row closes with the grid's own edge rather
                      // than a rule of its own. `last:border-b-0` said that
                      // and never did it: the cells are not the column's last
                      // children — the deadline, block and pill layers come
                      // after them — so the variant never matched.
                      className: `${
                        hourIdx === hours.length - 1 ? '' : 'border-b border-line'
                      } transition-colors`,
                      style: { height: remForHours(1) },
                    })}
                  </Fragment>
                ))}

                {/* Behind the blocks, on purpose: a deadline line is context,
                    and an event running through one should not look cut in
                    half by it. Its pills go in front, below. */}
                <DeadlineLines groups={deadlines} />

                {/* Blocks float over the cells: the cells stay droppable and
                    drag-selectable everywhere a block does not cover. */}
                <div className="absolute inset-0 pointer-events-none">
                  {timed.map((event, idx) => {
                    const start = new Date(event.start_time);
                    const end = new Date(event.end_time);
                    const eventHour = start.getHours() + start.getMinutes() / 60;
                    const durationHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);

                    return (
                      <Fragment key={eventKey(event, idx)}>
                        {renderEvent({
                          event,
                          placement: 'week',
                          // The block's height is the event's duration, clipped
                          // at the bottom edge of the window — an event that
                          // runs past midnight stops at the last row rather
                          // than hanging below the calendar. `pb-1` is inside
                          // that height (border-box), so the card fills the
                          // duration minus a hairline and two back-to-back
                          // events do not touch. The gap lives here rather than
                          // in `heightForBlock`, which is the geometry the drop
                          // targets are measured against.
                          className: 'absolute left-1 right-1 pb-1 pointer-events-auto',
                          style: {
                            top: topForHour(eventHour, startHour),
                            height: heightForBlock(eventHour, durationHours, endHour),
                          },
                          children: (
                            <EventCard
                              event={event}
                              onClick={onEventClick}
                              compact
                              // The grid sized the block, so the grid is what
                              // tells the card how much room it has to work in.
                              blockHours={durationHours}
                              // "Show all" in week view: everything this
                              // viewer's payload carries for the event, starred
                              // one first. The card decides how many fit.
                              resources={resourcesForEvent(event)}
                              linkContext={linkContext}
                            />
                          ),
                        })}
                      </Fragment>
                    );
                  })}
                </div>

                {/* In FRONT of the blocks: a label behind a block is not a
                    label. The layer takes no pointer events, so only the pill
                    itself is in the way of a drop or a drag-to-select. */}
                <DeadlinePills groups={deadlines} onEventClick={onEventClick} />

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
