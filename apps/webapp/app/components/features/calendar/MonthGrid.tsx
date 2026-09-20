/**
 * The month grid: six rows of seven day cells, each holding up to three chips.
 *
 * Presentational and role-blind. The staff calendar makes the cells droppable
 * and the chips draggable through the two render props; nothing in here knows
 * that dragging exists.
 */

import { Fragment } from 'react';
import { monthDropId } from './geometry';
import { DAY_LABELS, eventKey, formatDayLabel, isCurrentMonth, isSameDay } from './utils';
import EventChip from './EventChip';
import FeaturedResourceLink from './FeaturedResourceLink';
import { defaultRenderCell, defaultRenderEvent } from './gridRenderProps';
import type { RenderCell, RenderEvent } from './gridRenderProps';
import type { CalendarEventWithLinks } from './types';

/** How many chips a cell shows before it offers "+N more". */
export const MONTH_CELL_CAP = 3;

interface MonthGridProps {
  /** The 42 cells of the month on screen, padded from both neighbours. */
  dates: Date[];
  /** Which month is "this" one; the padding days are drawn back. */
  currentDate: Date;
  /**
   * Which day gets the today pill. It comes from the navigation hook's ticker
   * rather than from a fresh `new Date()` here, so the whole calendar agrees
   * about what "today" is within one render — and moves to the next day at the
   * same moment the week grid does.
   */
  now: Date;
  eventsFor: (date: Date) => CalendarEventWithLinks[];
  onEventClick?: (event: CalendarEventWithLinks) => void;
  /**
   * Where a cell's "+N more" goes: week view, opened on that day. Without it
   * the overflow count is not offered as a control at all, rather than being
   * offered as a button that does nothing.
   */
  onShowMore?: (date: Date) => void;
  renderEvent?: RenderEvent;
  renderCell?: RenderCell;
  /**
   * Where the starred resource under an event chip points. Threaded from the
   * route through the calendar container, because the month grid itself knows
   * nothing about which classroom or which role is looking at it.
   *
   * Left out, the starred line still renders — it simply links the way the link
   * list does when a caller gives it no bases.
   */
  classSlug?: string;
  rolePrefix?: string;
  pagesUrl?: string;
  slidesUrl?: string;
}

const MonthGrid = ({
  dates,
  currentDate,
  now,
  eventsFor,
  onEventClick,
  onShowMore,
  renderEvent = defaultRenderEvent,
  renderCell = defaultRenderCell,
  classSlug,
  rolePrefix,
  pagesUrl,
  slidesUrl,
}: MonthGridProps) => {
  const weeks: Date[][] = [];
  for (let i = 0; i < dates.length; i += 7) weeks.push(dates.slice(i, i + 7));

  return (
    // Hold a minimum width on phones and let the shell scroll horizontally,
    // rather than squeezing seven columns into nothing.
    <div className="min-w-[44rem]">
      <div className="grid grid-cols-7 border-b border-line">
        {DAY_LABELS.map(day => (
          <div
            key={day}
            className="py-3 text-center text-xs font-semibold tracking-[0.16em] text-ink-4"
          >
            {day}
          </div>
        ))}
      </div>

      <div>
        {weeks.map((week, weekIdx) => (
          <div key={weekIdx} className="grid grid-cols-7 border-b border-line last:border-b-0">
            {week.map(date => {
              const dayEvents = eventsFor(date);
              const inMonth = isCurrentMonth(date, currentDate);
              const isDayToday = isSameDay(date, now);
              const visible = dayEvents.slice(0, MONTH_CELL_CAP);
              const overflow = dayEvents.length - visible.length;
              const dropId = monthDropId(date);

              return (
                <Fragment key={dropId}>
                  {renderCell({
                    dropId,
                    date,
                    className: `min-h-[120px] p-2 border-l border-line first:border-l-0 flex flex-col gap-1 overflow-hidden transition-colors ${
                      inMonth ? '' : 'bg-stone-50/70 dark:bg-neutral-900/40'
                    }`,
                    children: (
                      <>
                        <div className="flex justify-end">
                          <span
                            className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold ${
                              isDayToday
                                ? 'text-white'
                                : inMonth
                                  ? 'text-ink-1'
                                  : 'text-gray-400 dark:text-gray-600'
                            }`}
                            style={isDayToday ? { backgroundColor: 'var(--accent)' } : undefined}
                          >
                            {date.getDate()}
                          </span>
                        </div>

                        <div className="flex flex-col gap-1 min-w-0">
                          {visible.map((event, idx) => (
                            // The starred resource is a SIBLING of the block,
                            // outside whatever the caller wrapped it in: a link
                            // cannot live inside the event's button, and out
                            // here the staff calendar's drag layer never sees
                            // it at all.
                            <div key={eventKey(event, idx)} className="flex flex-col min-w-0">
                              {renderEvent({
                                event,
                                placement: 'month',
                                className: 'min-w-0',
                                children: <EventChip event={event} onClick={onEventClick} />,
                              })}
                              {event.featured_resource && (
                                <FeaturedResourceLink
                                  featured={event.featured_resource}
                                  event={event}
                                  classSlug={classSlug}
                                  rolePrefix={rolePrefix}
                                  pagesUrl={pagesUrl}
                                  slidesUrl={slidesUrl}
                                />
                              )}
                            </div>
                          ))}
                          {overflow > 0 &&
                            (onShowMore ? (
                              <button
                                type="button"
                                // "+2 more" is enough beside the cell it sits
                                // in; announced on its own it names neither
                                // what it shows nor which day it belongs to.
                                aria-label={`Show ${overflow} more ${
                                  overflow === 1 ? 'event' : 'events'
                                } on ${formatDayLabel(date)}`}
                                onClick={() => onShowMore(date)}
                                className="text-xs text-ink-3 hover:text-ink-1 text-left pl-1 rounded focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                              >
                                +{overflow} more
                              </button>
                            ) : (
                              <span className="text-xs text-ink-3 pl-1">+{overflow} more</span>
                            ))}
                        </div>
                      </>
                    ),
                  })}
                </Fragment>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

export default MonthGrid;
