/**
 * The shared week grid, asserted against the markup it renders.
 *
 * Two of these are regressions waiting to come back: the now indicator drawing
 * on a week that does not contain today (the staff grid gated only one of its
 * three pieces), and the all-day strip reserving a band across the top of every
 * week (the staff grid always rendered it).
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import WeekGrid from '../WeekGrid';
import type { CalendarEventWithLinks } from '../types';

/** Sunday…Saturday around a date, the way the hook builds them. */
const weekOf = (date: Date): Date[] => {
  const sunday = new Date(date);
  sunday.setDate(date.getDate() - date.getDay());
  sunday.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + i);
    return d;
  });
};

const TUESDAY = new Date(2026, 8, 22, 14, 30);

const lecture: CalendarEventWithLinks = {
  id: 'evt-lecture',
  title: 'Week 1 Lecture',
  start_time: new Date(2026, 8, 22, 10, 0).toISOString(),
  end_time: new Date(2026, 8, 22, 11, 0).toISOString(),
  event_type: 'LECTURE',
  location: 'ECSC 116',
};

const deadline: CalendarEventWithLinks = {
  id: 'deadline-1',
  title: 'Due: Short Assignment 1',
  start_time: new Date(2026, 8, 23, 23, 59).toISOString(),
  end_time: new Date(2026, 8, 23, 23, 59).toISOString(),
  event_type: 'DEADLINE',
  is_deadline: true,
};

const render = (
  events: CalendarEventWithLinks[],
  now: Date,
  dates = weekOf(TUESDAY),
  props: { alwaysShowAllDay?: boolean; startHour?: number; endHour?: number } = {}
): string =>
  renderToStaticMarkup(
    <WeekGrid
      dates={dates}
      now={now}
      eventsFor={date => events.filter(e => new Date(e.start_time).getDate() === date.getDate())}
      {...props}
    />
  );

/**
 * The three pieces of the now indicator, identified by markup only they
 * produce. Asserting "the document contains no `var(--accent)`" would also
 * forbid the today pill and anything later work draws in the accent colour.
 */
const NOW_BADGE = '>2:30<';
const NOW_MARKER_DOT = 'w-2.5 h-2.5 rounded-full -ml-1.5';
const NOW_RULE = 'h-px opacity-30';

describe('WeekGrid', () => {
  it('labels the hour gutter on one line, 8 AM first and 10 PM last', () => {
    const html = render([], TUESDAY);
    expect(html).toContain('>8 AM<');
    expect(html).toContain('>10 PM<');
    // Never "0 AM": midnight and noon are both 12.
    expect(html).not.toContain('>0 AM<');
  });

  it('draws no part of the now indicator on the server', () => {
    // This IS the server pass: `renderToStaticMarkup` never runs the mount
    // effect. Drawing the server's clock is a hydration mismatch on the badge's
    // text, and a visible jump for a reader in another timezone.
    const html = render([], TUESDAY);
    expect(html).not.toContain(NOW_BADGE);
    expect(html).not.toContain(NOW_MARKER_DOT);
    expect(html).not.toContain(NOW_RULE);
  });

  it('draws no part of the now indicator on another week', () => {
    const html = render([], TUESDAY, weekOf(new Date(2026, 10, 10)));
    expect(html).not.toContain(NOW_BADGE);
    expect(html).not.toContain(NOW_MARKER_DOT);
    expect(html).not.toContain(NOW_RULE);
  });

  it('gives a timed event the shared block, with its end time and room', () => {
    const html = render([lecture], TUESDAY);
    expect(html).toContain('Week 1 Lecture');
    expect(html).toContain('ECSC 116');
    // Students only ever saw a start time here. The time and the room share
    // ONE row, with the meridiem written once — two rows did not fit in the
    // blocks the grid draws, and the second was sliced in half.
    expect(html).toMatch(/10:00\s*–\s*11:00\s*AM/);
    expect(html).toContain('·');
  });

  it('keeps the meta row on a 50-minute x-hour, and pays for it in padding', () => {
    // The most common short slot here. It keeps its row by dropping to `py-1`;
    // at `p-2` the row would not have fitted.
    const xHour: CalendarEventWithLinks = {
      ...lecture,
      id: 'evt-x-hour',
      title: 'x-hour',
      end_time: new Date(2026, 8, 22, 10, 50).toISOString(),
    };
    const html = render([xHour], TUESDAY);

    expect(html).toMatch(/10:00\s*–\s*10:50\s*AM/);
    expect(html).toContain('ECSC 116');
    expect(html).toContain('px-2 py-1');
  });

  it('drops the meta row from a block too short to hold it', () => {
    const short: CalendarEventWithLinks = {
      ...lecture,
      id: 'evt-short',
      title: 'Quick sync',
      end_time: new Date(2026, 8, 22, 10, 45).toISOString(),
    };
    const html = render([short], TUESDAY);

    // Title only, rather than a title and the top half of a second line.
    expect(html).toContain('Quick sync');
    expect(html).not.toContain('ECSC 116');
    expect(html).not.toMatch(/10:00\s*–/);
  });

  it('leaves an hour-long block at the roomier padding', () => {
    const html = render([lecture], TUESDAY);
    expect(html).not.toContain('px-2 py-1');
  });

  it('starts a block’s content at the top, however tall the block is', () => {
    // A <button> centres its content vertically, so a two-hour block drew its
    // title down the middle of the slot. It is a top-aligned column instead.
    const long: CalendarEventWithLinks = {
      ...lecture,
      id: 'evt-long',
      title: 'Long OH',
      end_time: new Date(2026, 8, 22, 12, 0).toISOString(),
    };
    const html = render([long], TUESDAY);

    expect(html).toContain('height:8rem');
    expect(html).toContain('flex flex-col justify-start items-stretch');
  });

  it('sizes a block by its duration and leaves a gap under it', () => {
    // One hour of grid is 4rem, so a one-hour lecture is 4rem tall — not the
    // height of whatever text happens to be in it. `pb-1` is inside that
    // height, so the next block does not touch this one.
    const html = render([lecture], TUESDAY);
    expect(html).toContain('height:4rem');
    expect(html).toContain('pb-1');
    // And the card fills what the grid measured for it.
    expect(html).toContain('h-full flex flex-col min-h-0');
  });

  it('keeps the icons out of a block’s accessible name', () => {
    // antd renders an icon as role="img" with aria-label="clock-circle", which
    // a screen reader reads out in the middle of the event's name.
    const html = render([lecture], TUESDAY);
    expect(html).toContain('aria-label="clock-circle" aria-hidden="true"');
  });

  it('hides the all-day strip when the week has nothing for it', () => {
    expect(render([lecture], TUESDAY)).not.toContain('All day');
  });

  it('keeps the strip on screen for a caller that can drop onto it', () => {
    // Staff only: the strip is the one drop target that changes an event's day
    // without rewriting its time, so it has to exist on an empty week.
    const html = render([lecture], TUESDAY, weekOf(TUESDAY), { alwaysShowAllDay: true });
    expect(html).toContain('All day');
  });

  it('shows the strip, with the due time, as soon as one day has a deadline', () => {
    const html = render([lecture, deadline], TUESDAY);
    expect(html).toContain('All day');
    expect(html).toContain('due 11:59 PM');
  });
});

describe('WeekGrid — the rendered window', () => {
  it('draws the default 8 AM…10 PM band when nothing asks for more', () => {
    const html = render([], TUESDAY);
    expect(html).toContain('>8 AM<');
    expect(html).toContain('>10 PM<');
    expect(html).not.toContain('>11 PM<');
  });

  it('draws an 11 PM row when the window reaches midnight', () => {
    // `hourRange` widens to 24 for an 11:59 PM deadline; the grid draws the
    // row that gives its line somewhere to land.
    const html = render([deadline], TUESDAY, weekOf(TUESDAY), { endHour: 24 });
    expect(html).toContain('>11 PM<');
    // And 24 prints as 12 AM, never 0 AM — but it is the EXCLUSIVE end, so
    // there is no row for it.
    expect(html).not.toContain('>0 AM<');
  });

  it('opens upward to an early start and rebases everything on it', () => {
    const html = render([], TUESDAY, weekOf(TUESDAY), { startHour: 6 });
    expect(html).toContain('>6 AM<');
    // The gutter labels are offsets from the top of the window, so 6 AM is now
    // the row at zero.
    expect(html).toContain('top:calc(0rem + 4px)');
  });

  it('gives a 10:30 PM event a block instead of exiling it to the strip', () => {
    const late: CalendarEventWithLinks = {
      ...lecture,
      id: 'evt-late',
      title: 'Late review',
      start_time: new Date(2026, 8, 22, 22, 30).toISOString(),
      end_time: new Date(2026, 8, 22, 23, 30).toISOString(),
    };
    const html = render([late], TUESDAY, weekOf(TUESDAY), { endHour: 24 });

    expect(html).toContain('Late review');
    expect(html).not.toContain('All day');
  });

  it('clips an event that crosses midnight at the bottom edge', () => {
    const crossing: CalendarEventWithLinks = {
      ...lecture,
      id: 'evt-crossing',
      title: 'Night lab',
      start_time: new Date(2026, 8, 22, 23, 0).toISOString(),
      end_time: new Date(2026, 8, 23, 1, 0).toISOString(),
    };
    const html = render([crossing], TUESDAY, weekOf(TUESDAY), { endHour: 24 });

    expect(html).toContain('Night lab');
    // Two hours of event, one hour of grid left: it stops at the last row
    // rather than hanging 4rem below the calendar.
    expect(html).toContain('height:4rem');
    expect(html).not.toContain('height:8rem');
  });
});

describe('WeekGrid — deadline lines', () => {
  const ROSE_LINE = 'border-t-2 border-rose-500/80';

  it('draws a line and a pill for a deadline inside the window', () => {
    const html = render([deadline], TUESDAY, weekOf(TUESDAY), { endHour: 24 });

    expect(html).toContain(ROSE_LINE);
    expect(html).toContain('11:59 PM · Short Assignment 1');
    // "Due: " is chrome in a 107px column; the pill is already rose, already
    // on the line, and already says "Deadline" to a screen reader.
    expect(html).toContain('aria-label="Deadline: Short Assignment 1, due 11:59 PM"');
    // Truncated in the column, so the whole label stays on hover.
    expect(html).toContain('title="11:59 PM · Short Assignment 1"');
  });

  it('keeps an 11:59 PM pill inside the grid by hanging it above its line', () => {
    const html = render([deadline], TUESDAY, weekOf(TUESDAY), { endHour: 24 });
    // The line sits at the very bottom of a 16-row grid; the pill is anchored
    // to it and pulled up by its own height, which is the only placement that
    // cannot fall off the bottom edge.
    expect(html).toContain('transform:translateY(-100%)');
  });

  it('dashes the line of an unpublished deadline, and only that one', () => {
    const published = render([deadline], TUESDAY, weekOf(TUESDAY), { endHour: 24 });
    expect(published).not.toContain('border-dashed');

    const draft = render([{ ...deadline, is_unpublished: true }], TUESDAY, weekOf(TUESDAY), {
      endHour: 24,
    });
    expect(draft).toContain('border-dashed');
  });

  it('draws no line for a deadline due before the window opens', () => {
    // 2 AM, below the 6 AM floor: it keeps its all-day chip and nothing else.
    // A line at an hour the grid does not draw would have to be drawn at an
    // hour that is not its own.
    const early: CalendarEventWithLinks = {
      ...deadline,
      id: 'deadline-early',
      start_time: new Date(2026, 8, 23, 2, 0).toISOString(),
      end_time: new Date(2026, 8, 23, 2, 0).toISOString(),
    };
    const html = render([early], TUESDAY);

    expect(html).toContain('All day');
    expect(html).toContain('due 2 AM');
    expect(html).not.toContain(ROSE_LINE);
  });

  it('keeps the strip chip as well as the line', () => {
    // The chip is the draggable one — rescheduling stays there — so the line
    // is an addition, never a move.
    const html = render([deadline], TUESDAY, weekOf(TUESDAY), { endHour: 24 });
    expect(html).toContain('All day');
    expect(html).toContain('due 11:59 PM');
  });

  it('stacks two deadlines due at the same minute rather than overlapping them', () => {
    const second: CalendarEventWithLinks = {
      ...deadline,
      id: 'deadline-2',
      title: 'Due: Reading Response',
    };
    const html = render([deadline, second], TUESDAY, weekOf(TUESDAY), { endHour: 24 });

    expect(html).toContain('11:59 PM · Short Assignment 1');
    expect(html).toContain('11:59 PM · Reading Response');
    // One bottom-anchored column holds both, so the second lands above the
    // first instead of on top of it.
    expect((html.match(/transform:translateY\(-100%\)/g) ?? [])).toHaveLength(1);
    expect(html).toContain('flex flex-col items-end gap-0.5');
  });

  it('gives a form close its own wording, unchanged', () => {
    const formClose: CalendarEventWithLinks = {
      id: 'form-close-1',
      title: 'Week 1 Survey closes',
      start_time: new Date(2026, 8, 23, 17, 0).toISOString(),
      end_time: new Date(2026, 8, 23, 17, 0).toISOString(),
      event_type: 'DEADLINE',
      is_deadline: true,
      is_form_close: true,
    };
    const html = render([formClose], TUESDAY);

    expect(html).toContain('5 PM · Week 1 Survey closes');
  });

  it('puts the line behind the blocks and the pill in front of them', () => {
    // Both on Tuesday: the three layers only stack within ONE column.
    const sameDay: CalendarEventWithLinks = {
      ...deadline,
      start_time: new Date(2026, 8, 22, 23, 59).toISOString(),
      end_time: new Date(2026, 8, 22, 23, 59).toISOString(),
    };
    const html = render([lecture, sameDay], TUESDAY, weekOf(TUESDAY), { endHour: 24 });

    const line = html.indexOf(ROSE_LINE);
    const block = html.indexOf('Week 1 Lecture');
    const pill = html.indexOf('11:59 PM · Short Assignment 1');

    // Same stacking context, no z-index on any of them: paint order IS
    // document order.
    expect(line).toBeLessThan(block);
    expect(block).toBeLessThan(pill);
  });
});
