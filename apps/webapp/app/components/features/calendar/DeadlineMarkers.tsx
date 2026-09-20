/**
 * Deadlines, drawn where they fall in the week grid.
 *
 * A deadline used to exist only as a chip in the all-day strip, so "when is
 * this due?" cost a click on a chip at the top of the screen. It now also
 * draws a line across its day at the hour it is due — the strip chip stays,
 * because it is the chip that can be dragged and because a deadline before the
 * window's first row has no line to draw.
 *
 * This is NOT the block path. A deadline is zero-duration: it has no height, so
 * it cannot be a card that fills a slot, and every rule in `EventCard` about
 * what fits in how many minutes is meaningless for it.
 *
 * Two layers, deliberately separated, because they sit on opposite sides of the
 * event blocks: the LINE is behind them (it is context, and an event that runs
 * through a deadline should not be cut in half by it) and the PILL is in front
 * (it is the label, and a label behind a block is not a label). Both layers are
 * `pointer-events-none`; the pill alone takes the pointer, so it blocks no drop
 * and no drag-to-select outside its own box.
 *
 * Read-only in v1: rescheduling a deadline stays on the all-day chip, which is
 * the one the staff drag layer picks up.
 */

import { formatShortTime } from './utils';
import type { CalendarEventWithLinks } from './types';

/** Deadlines due at the same minute, which share one line and stack their pills. */
export interface DeadlineGroup {
  /** The clock hour the line sits at, minutes as a fraction. */
  hourFloat: number;
  /** That hour as an offset from the top of the grid. */
  top: string;
  items: CalendarEventWithLinks[];
}

/**
 * The title as a deadline pill says it: `Due: Lab 3` is three words of chrome
 * in a column about 107px wide, and the pill already says it is a deadline —
 * by its colour, by its position on the line, and in its accessible name. A
 * form close reads `Survey closes`, which is already a sentence and is left
 * alone.
 */
export const deadlineTitle = (event: CalendarEventWithLinks): string =>
  (event.title ?? '').replace(/^Due:\s*/i, '');

/**
 * The deadlines of ONE day that have a line to draw, grouped by due time.
 *
 * Anything due outside the rendered hours is left out: it keeps its all-day
 * chip, which is the honest answer — a line at an hour the grid does not draw
 * would have to be drawn at an hour that is not its own.
 *
 * Pure, and exported so the grouping can be asserted without a renderer.
 */
export const deadlineGroups = (
  events: readonly CalendarEventWithLinks[],
  startHour: number,
  endHourExclusive: number,
  topFor: (hourFloat: number) => string
): DeadlineGroup[] => {
  const byHour = new Map<number, CalendarEventWithLinks[]>();

  for (const event of events) {
    if (!event.is_deadline) continue;
    const due = new Date(event.start_time);
    if (Number.isNaN(due.getTime())) continue;

    const hourFloat = due.getHours() + due.getMinutes() / 60;
    if (hourFloat < startHour || hourFloat >= endHourExclusive) continue;

    const group = byHour.get(hourFloat);
    if (group) group.push(event);
    else byHour.set(hourFloat, [event]);
  }

  return [...byHour.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hourFloat, items]) => ({ hourFloat, top: topFor(hourFloat), items }));
};

/** A stable key for one deadline within its day. */
const itemKey = (event: CalendarEventWithLinks, index: number): string =>
  `${event.id ?? 'deadline'}-${index}`;

interface DeadlineLayerProps {
  groups: DeadlineGroup[];
}

/**
 * The lines themselves, behind the event blocks.
 *
 * `aria-hidden`: the line says nothing the pill above it does not say, and a
 * screen reader reading each deadline twice is worse than not drawing it.
 * Dashed means the assignment behind it is not published — only staff are ever
 * handed one of those.
 */
export const DeadlineLines = ({ groups }: DeadlineLayerProps) => (
  <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
    {groups.map(group =>
      group.items.map((item, index) => (
        <div
          key={itemKey(item, index)}
          className={`absolute left-0 right-0 border-t-2 border-rose-500/80 dark:border-rose-400/70 ${
            item.is_unpublished ? 'border-dashed' : ''
          }`}
          style={{ top: group.top }}
        />
      ))
    )}
  </div>
);

interface DeadlinePillsProps extends DeadlineLayerProps {
  onEventClick?: (event: CalendarEventWithLinks) => void;
}

/**
 * The labels, in front of the event blocks and right-aligned in the column.
 *
 * ALWAYS above the line, never below it. The commonest deadline in a course is
 * due at 11:59 PM, whose line is the last thing in the grid — a pill below it
 * would be drawn outside the calendar — and a rule that flips near the bottom
 * edge would draw the same deadline differently depending on how late the rest
 * of the week runs. Above also reads correctly on its own: everything above
 * the line is the time you still have.
 *
 * Two deadlines at the same time stack rather than overlap: the group is one
 * bottom-anchored column, so the second pill lands above the first.
 */
export const DeadlinePills = ({ groups, onEventClick }: DeadlinePillsProps) => (
  <div className="absolute inset-0 pointer-events-none">
    {groups.map(group => (
      <div
        key={group.hourFloat}
        className="absolute left-1 right-1 flex flex-col items-end gap-0.5"
        style={{ top: group.top, transform: 'translateY(-100%)' }}
      >
        {group.items.map((item, index) => {
          const title = deadlineTitle(item);
          const time = formatShortTime(item.start_time);
          const label = `${time} · ${title}`;

          return (
            <button
              key={itemKey(item, index)}
              type="button"
              onClick={() => onEventClick?.(item)}
              // The column is narrow enough that most of these truncate, so
              // the whole label stays reachable on hover and, for a screen
              // reader, in a name that says what kind of thing this is.
              title={label}
              aria-label={`Deadline: ${title}, due ${time}`}
              className="pointer-events-auto max-w-full truncate rounded-full border border-rose-300 dark:border-rose-700/70 bg-rose-100 dark:bg-rose-900/60 px-1.5 py-0.5 text-[0.65rem] font-medium leading-none text-rose-800 dark:text-rose-200 shadow-sm hover:bg-rose-200 dark:hover:bg-rose-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              {label}
            </button>
          );
        })}
      </div>
    ))}
  </div>
);
