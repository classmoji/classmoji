/**
 * The shared month grid, asserted against the markup it renders.
 *
 * The claims worth holding are the ones the two calendars disagreed about
 * before they were merged: the day-name row, the cell height, the three-chip
 * cap, and — the one that was not a disagreement but a gap — that the overflow
 * count is a real control rather than a sentence about a control. Seed data
 * never puts four events on one day, so this is where "+N more" is checked at
 * all.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MonthGrid from '../MonthGrid';
import type { CalendarEventWithLinks } from '../types';

const SEPTEMBER = new Date(2026, 8, 15);

/** The 42 cells of September 2026, exactly as the hook builds them. */
const monthDates = (): Date[] => {
  const first = new Date(2026, 8, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
};

const event = (title: string, hour: number): CalendarEventWithLinks => ({
  id: `evt-${title}`,
  title,
  start_time: new Date(2026, 8, 15, hour, 0).toISOString(),
  end_time: new Date(2026, 8, 15, hour + 1, 0).toISOString(),
  event_type: 'LECTURE',
});

const render = (events: CalendarEventWithLinks[], onShowMore?: (date: Date) => void): string =>
  renderToStaticMarkup(
    <MonthGrid
      dates={monthDates()}
      currentDate={SEPTEMBER}
      now={SEPTEMBER}
      eventsFor={date => (date.getDate() === 15 && date.getMonth() === 8 ? events : [])}
      onShowMore={onShowMore}
    />
  );

describe('MonthGrid', () => {
  it('draws the uppercase SUN…SAT day-name row', () => {
    const html = render([]);
    for (const day of ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']) {
      expect(html).toContain(`>${day}<`);
    }
    // The staff grid drew Sun/Mon/Tue; one casing for both roles.
    expect(html).not.toContain('>Sun<');
  });

  it('gives every cell the same 120px floor', () => {
    expect(render([]).match(/min-h-\[120px\]/g)).toHaveLength(42);
  });

  it('shows three chips and offers the rest as a button', () => {
    const html = render(
      [event('One', 9), event('Two', 10), event('Three', 11), event('Four', 12), event('Five', 13)],
      () => {}
    );

    expect(html).toContain('One');
    expect(html).toContain('Three');
    expect(html).not.toContain('Four');
    // The overflow count is a control, not prose: it opens that day in week
    // view. It was a <span> in the student grid and a <div> in the staff one.
    expect(html).toContain('+2 more</button>');
    // "+2 more" says nothing on its own, which is how it is announced.
    expect(html).toContain('aria-label="Show 2 more events on Tue Sep 15"');
  });

  it('puts the day on the today pill the hook says it is, not a fresh clock', () => {
    // `now` is a prop so the whole calendar agrees within one render — and so
    // this assertion does not depend on the day the suite runs.
    const html = render([]);
    expect(html).toContain('background-color:var(--accent)">15</span>');
  });

  it('leaves the overflow count as text when there is nowhere to send the reader', () => {
    const html = render([event('One', 9), event('Two', 10), event('Three', 11), event('Four', 12)]);
    expect(html).toContain('+1 more</span>');
  });

  it('makes each chip a real button rather than a clickable div', () => {
    const html = render([event('Week 1 Lecture', 9)]);
    expect(html).toContain('<button type="button"');
    expect(html).toContain('Week 1 Lecture');
  });
});
