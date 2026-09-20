/**
 * The row above the hour grid: deadlines, and anything that falls outside the
 * rendered hours.
 *
 * It disappears when the week has nothing to put in it (the student
 * behaviour) — the staff grid always reserved the row, so most weeks carried an
 * empty band across the top of the calendar. A caller that can DROP onto the
 * row keeps it with `alwaysShow`: for them the empty row is a target, not a
 * gap.
 */

import { Fragment, useState } from 'react';
import { WEEK_GRID_COLUMNS, monthDropId } from './geometry';
import { eventKey, formatDayLabel, formatShortTime } from './utils';
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
  /**
   * Keep the row on screen even when the week has nothing for it. Staff pass
   * this: the strip is their only drop target that changes an event's DAY
   * without changing its time of day (an hour cell snaps to the hour), and a
   * row that vanishes when empty is missing on exactly the weeks where that
   * move is wanted. Students keep the row hidden — for them it is an empty band
   * with nothing to do.
   */
  alwaysShow?: boolean;
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
  alwaysShow = false,
  renderEvent = defaultRenderEvent,
  renderCell = defaultRenderCell,
}: AllDayStripProps) => {
  // Which days have been opened past the cap. Local and per-day: "+N more" here
  // cannot send the reader to week view the way a month cell's does, because
  // this row only exists IN week view — so it opens the rest of the day in
  // place instead of being the dead text it was.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const perDay = dates.map(itemsFor);
  if (!alwaysShow && perDay.every(items => items.length === 0)) return null;

  return (
    <div
      className="grid border-b border-line bg-gray-50/50 dark:bg-neutral-800/30"
      style={{ gridTemplateColumns: WEEK_GRID_COLUMNS }}
    >
      <div className="px-1 py-1.5 text-xs text-ink-4">All day</div>
      {dates.map((date, dayIdx) => {
        const items = perDay[dayIdx];
        const dropId = monthDropId(date);
        const isExpanded = expanded[dropId] === true;
        const visible = isExpanded ? items : items.slice(0, ALL_DAY_CAP);
        const overflow = items.length - visible.length;
        const hidden = items.length - ALL_DAY_CAP;

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
                  {hidden > 0 && (
                    // One control, both ways: it stays after it has opened the
                    // day, so `aria-expanded` describes something a reader can
                    // actually toggle back.
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-label={
                        isExpanded
                          ? `Show fewer items on ${formatDayLabel(date)}`
                          : `Show ${overflow} more ${
                              overflow === 1 ? 'item' : 'items'
                            } on ${formatDayLabel(date)}`
                      }
                      onClick={() => setExpanded(state => ({ ...state, [dropId]: !isExpanded }))}
                      className="text-xs text-ink-3 hover:text-ink-1 text-left px-1 rounded focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                    >
                      {isExpanded ? 'Show fewer' : `+${overflow} more`}
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
