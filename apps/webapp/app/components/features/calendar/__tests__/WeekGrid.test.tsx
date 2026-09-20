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
  props: { alwaysShowAllDay?: boolean } = {}
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
