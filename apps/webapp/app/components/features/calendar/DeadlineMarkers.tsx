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

import { HOUR_HEIGHT_REM } from './geometry';
import { formatShortTime } from './utils';
import type { CalendarEventWithLinks } from './types';

/** One deadline, and where ITS line goes. */
export interface DeadlineMark {
  event: CalendarEventWithLinks;
  /** The clock hour the line sits at, minutes as a fraction. */
  hourFloat: number;
  /** That hour as an offset from the top of the grid. */
  top: string;
}

/**
 * Deadlines whose pills would otherwise land on top of each other, drawn as
 * one anchored stack. Their LINES stay where they each belong.
 */
export interface DeadlineGroup {
  /** The earliest due time in the stack — where the stack is anchored. */
  hourFloat: number;
  top: string;
  /** Whether the pills hang above the anchor — see `DeadlinePills`. */
  above: boolean;
  items: DeadlineMark[];
}

/**
 * A pill's own box and the gap between two stacked ones, in rem. Rounded up
 * from what the built CSS draws (0.65rem of type, `py-0.5`, a hairline
 * border), because being generous here costs nothing and being short of it
 * puts a pill through the all-day strip.
 */
const PILL_BOX_REM = 1.25;
const PILL_STACK_GAP_REM = 0.125;

/**
 * How much room a stack of `count` pills needs above its anchor, in hours of
 * grid. It has to scale with the stack: two deadlines five minutes apart are
 * one stack two pills tall, and clearance for one of them would hang the
 * other into the all-day strip.
 */
export const pillClearanceHours = (count: number): number =>
  (count * PILL_BOX_REM + Math.max(0, count - 1) * PILL_STACK_GAP_REM) / HOUR_HEIGHT_REM;

/**
 * How close two due times have to be for their pills to collide — one pill
 * height, in hours of grid. Deadlines at 11:55 and 11:59 PM are four minutes
 * apart and would be drawn one on top of the other.
 */
const PILL_MERGE_HOURS = PILL_BOX_REM / HOUR_HEIGHT_REM;

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
 * The deadlines of ONE day that have a line to draw, with the ones whose pills
 * would collide gathered into a single stack.
 *
 * Grouping used to be by exact minute, which only caught the case where two
 * assignments were due at the same instant — 11:55 and 11:59 PM are four
 * minutes apart and were drawn one pill on top of the other. Anything within a
 * pill's height of the one before it joins its stack; each keeps its own line,
 * and each pill still says its own time.
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
  const marks: DeadlineMark[] = [];

  for (const event of events) {
    if (!event.is_deadline) continue;
    const due = new Date(event.start_time);
    if (Number.isNaN(due.getTime())) continue;

    const hourFloat = due.getHours() + due.getMinutes() / 60;
    if (hourFloat < startHour || hourFloat >= endHourExclusive) continue;

    marks.push({ event, hourFloat, top: topFor(hourFloat) });
  }

  marks.sort((a, b) => a.hourFloat - b.hourFloat);

  const groups: DeadlineGroup[] = [];
  for (const mark of marks) {
    const open = groups[groups.length - 1];
    // Measured from the stack's ANCHOR, not from the previous pill: three
    // deadlines a minute apart are one stack, not a chain that walks down the
    // column a pill at a time.
    if (open && mark.hourFloat - open.hourFloat < PILL_MERGE_HOURS) {
      open.items.push(mark);
      continue;
    }
    groups.push({ hourFloat: mark.hourFloat, top: mark.top, above: true, items: [mark] });
  }

  return groups.map(group => ({
    ...group,
    // Above the anchor, except where "above" is not the grid: a stack near the
    // first rendered hour would hang over the all-day strip, which holds those
    // same deadlines' chips. The taller the stack, the more room it needs.
    above: group.hourFloat - startHour >= pillClearanceHours(group.items.length),
  }));
};

/** Every line to draw, in the order they fall. */
export const deadlineMarks = (groups: readonly DeadlineGroup[]): DeadlineMark[] =>
  groups.flatMap(group => group.items);

/** A stable key for one deadline within its day. */
const itemKey = (mark: DeadlineMark, index: number): string =>
  `${mark.event.id ?? 'deadline'}-${index}`;

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
    {deadlineMarks(groups).map((mark, index) => (
      <div
        key={itemKey(mark, index)}
        className={`absolute left-0 right-0 border-t-2 border-rose-500/80 dark:border-rose-400/70 ${
          mark.event.is_unpublished ? 'border-dashed' : ''
        }`}
        // Each line at its OWN time, even where the pills above them merged
        // into one stack: the line is the answer to "when", and moving it
        // would make it the wrong answer.
        style={{ top: mark.top }}
      />
    ))}
  </div>
);

interface DeadlinePillsProps extends DeadlineLayerProps {
  onEventClick?: (event: CalendarEventWithLinks) => void;
}

/**
 * The labels, in front of the event blocks and right-aligned in the column.
 *
 * Above the line, not below it. The commonest deadline in a course is due at
 * 11:59 PM, whose line is the last thing in the grid — a pill below it would
 * be drawn outside the calendar — and a rule that flipped near the BOTTOM edge
 * would draw the same deadline differently depending on how late the rest of
 * the week ran. Above also reads correctly on its own: everything above the
 * line is the time you still have.
 *
 * The one exception is the top edge, where "above" is not the grid at all but
 * the all-day strip — which holds those same deadlines' chips. A stack near
 * the first rendered hour hangs below its line instead, and how near is
 * "near" scales with how tall the stack is.
 *
 * Deadlines close enough for their pills to collide are ONE anchored column,
 * so the second lands above the first rather than on it, each still saying its
 * own time.
 *
 * Capped at 70% of the column and pinned to its right edge. A pill sits over
 * whatever the block beneath it is drawing, and the case that matters is a
 * block that ends exactly at the due time: since the chips now stack from the
 * top of their block rather than its floor, they are nowhere near that edge on
 * every tier but a completely full one — and at 70% the left of the column,
 * where a chip's icon and the start of its title are, stays clear.
 */
export const DeadlinePills = ({ groups, onEventClick }: DeadlinePillsProps) => (
  <div className="absolute inset-0 pointer-events-none">
    {groups.map(group => (
      <div
        key={group.hourFloat}
        className="absolute left-0 right-0.5 flex flex-col items-end gap-0.5"
        style={{
          top: group.top,
          transform: group.above ? 'translateY(-100%)' : undefined,
        }}
      >
        {group.items.map((mark, index) => {
          const title = deadlineTitle(mark.event);
          const time = formatShortTime(mark.event.start_time);
          const label = `${time} · ${title}`;

          return (
            <button
              key={itemKey(mark, index)}
              type="button"
              onClick={() => onEventClick?.(mark.event)}
              // The column is narrow enough that most of these truncate, so
              // the whole label stays reachable on hover and, for a screen
              // reader, in a name that says what kind of thing this is.
              title={label}
              aria-label={`Deadline: ${title}, due ${time}`}
              className="pointer-events-auto max-w-[70%] truncate rounded-full border border-rose-300 dark:border-rose-700/70 bg-rose-100 dark:bg-rose-900/60 px-1.5 py-0.5 text-[0.65rem] font-medium leading-none text-rose-800 dark:text-rose-200 shadow-sm hover:bg-rose-200 dark:hover:bg-rose-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              {label}
            </button>
          );
        })}
      </div>
    ))}
  </div>
);
