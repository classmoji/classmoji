/**
 * The row above the hour grid: deadlines, and anything that falls outside the
 * rendered hours.
 *
 * It disappears when the week has nothing to put in it (the student
 * behaviour) — the staff grid always reserved the row, so most weeks carried an
 * empty band across the top of the calendar.
 */

import { Fragment, useState } from 'react';
import { WEEK_GRID_COLUMNS, monthDropId } from './geometry';
import { eventKey, formatShortTime } from './utils';
import EventChip from './EventChip';
import { defaultRenderCell, defaultRenderEvent } from './gridRenderProps';
import type { RenderCell, RenderEvent } from './gridRenderProps';
import type { CalendarEventWithLinks } from './types';

/** How many chips a day shows before it offers "+N more". */
export const ALL_DAY_CAP = 3;

interface AllDayStripProps {
  /** Sunday…Saturday of the week on screen. */
  dates: Date[];
  /** The all-day items for one day, already filtered and sorted. */
  itemsFor: (date: Date) => CalendarEventWithLinks[];
  onEventClick?: (event: CalendarEventWithLinks) => void;
  renderEvent?: RenderEvent;
  renderCell?: RenderCell;
}

/**
 * A deadline says when it is due; anything else up here says when it starts.
 * Either way the time is the reason the item is in the strip rather than in the
 * grid, so it is the one thing worth a second line.
 */
const subtitleFor = (event: CalendarEventWithLinks) =>
  event.is_deadline
    ? `due ${formatShortTime(event.start_time)}`
    : formatShortTime(event.start_time);

const CELL_CLASS = 'px-1.5 py-1.5 border-l border-line overflow-hidden';

const AllDayStrip = ({
  dates,
  itemsFor,
  onEventClick,
  renderEvent = defaultRenderEvent,
  renderCell = defaultRenderCell,
}: AllDayStripProps) => {
  // Which days have been opened past the cap. Local and per-day: "+N more" here
  // cannot send the reader to week view the way a month cell's does, because
  // this row only exists IN week view — so it opens the rest of the day in
  // place instead of being the dead text it was.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const perDay = dates.map(itemsFor);
  if (perDay.every(items => items.length === 0)) return null;

  return (
    <div
      className="grid border-b border-line bg-gray-50/50 dark:bg-neutral-800/30"
      style={{ gridTemplateColumns: WEEK_GRID_COLUMNS }}
    >
      <div className="px-1 py-1.5 text-xs text-ink-4">All day</div>
      {dates.map((date, dayIdx) => {
        const items = perDay[dayIdx];
        const dropId = monthDropId(date);
        const visible = expanded[dropId] ? items : items.slice(0, ALL_DAY_CAP);
        const overflow = items.length - visible.length;

        return (
          <Fragment key={dropId}>
            {renderCell({
              // The strip drops onto a whole date, exactly like a month cell.
              dropId,
              date,
              dayIndex: dayIdx,
              className: `${CELL_CLASS} min-h-[2.25rem]`,
              children: (
                <div className="flex flex-col gap-1 min-w-0">
                  {visible.map((event, idx) => (
                    <Fragment key={eventKey(event, idx)}>
                      {renderEvent({
                        event,
                        placement: 'allDay',
                        className: 'min-w-0',
                        children: (
                          <EventChip
                            event={event}
                            onClick={onEventClick}
                            subtitle={subtitleFor(event)}
                          />
                        ),
                      })}
                    </Fragment>
                  ))}
                  {overflow > 0 && (
                    <button
                      type="button"
                      onClick={() => setExpanded(state => ({ ...state, [dropId]: true }))}
                      className="text-xs text-ink-3 hover:text-ink-1 text-left px-1 rounded focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      +{overflow} more
                    </button>
                  )}
                </div>
              ),
            })}
          </Fragment>
        );
      })}
    </div>
  );
};

export default AllDayStrip;
