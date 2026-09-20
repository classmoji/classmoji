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

const render = (events: CalendarEventWithLinks[], now: Date, dates = weekOf(TUESDAY)): string =>
  renderToStaticMarkup(
    <WeekGrid
      dates={dates}
      now={now}
      eventsFor={date => events.filter(e => new Date(e.start_time).getDate() === date.getDate())}
    />
  );

describe('WeekGrid', () => {
  it('draws the 15 hour rows the window describes, with 8 AM first and 10 PM last', () => {
    const html = render([], TUESDAY);
    expect(html).toContain('>8</span><span>AM<');
    expect(html).toContain('>10</span><span>PM<');
    // Never "0 AM": midnight and noon are both 12.
    expect(html).not.toContain('>0</span>');
  });

  it('draws the now indicator when today is on screen', () => {
    const html = render([], TUESDAY);
    // The gutter badge is the piece with text, so it is the one to assert on.
    expect(html).toContain('>2:30<');
  });

  it('draws no part of the now indicator on another week', () => {
    const html = render([], TUESDAY, weekOf(new Date(2026, 10, 10)));
    expect(html).not.toContain('>2:30<');
    expect(html).not.toContain('--accent');
  });

  it('gives a timed event the shared block, with its end time and room', () => {
    const html = render([lecture], TUESDAY);
    expect(html).toContain('Week 1 Lecture');
    expect(html).toContain('ECSC 116');
    // Students only ever saw a start time here.
    expect(html).toMatch(/10:00\s*AM\s*-\s*11:00\s*AM/);
  });

  it('hides the all-day strip when the week has nothing for it', () => {
    expect(render([lecture], TUESDAY)).not.toContain('All day');
  });

  it('shows the strip, with the due time, as soon as one day has a deadline', () => {
    const html = render([lecture, deadline], TUESDAY);
    expect(html).toContain('All day');
    expect(html).toContain('due 11:59 PM');
  });
});
