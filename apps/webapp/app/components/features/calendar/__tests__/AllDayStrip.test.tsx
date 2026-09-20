/**
 * The all-day strip on its own: when it exists at all, how many chips a day
 * shows, and whether the overflow count is a control.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AllDayStrip from '../AllDayStrip';
import type { CalendarEventWithLinks } from '../types';

const WEEK = Array.from({ length: 7 }, (_, i) => new Date(2026, 8, 20 + i));

const deadline = (n: number): CalendarEventWithLinks => ({
  id: `deadline-${n}`,
  title: `Due: Assignment ${n}`,
  start_time: new Date(2026, 8, 22, 23, 59).toISOString(),
  end_time: new Date(2026, 8, 22, 23, 59).toISOString(),
  event_type: 'DEADLINE',
  is_deadline: true,
});

const render = (items: CalendarEventWithLinks[], alwaysShow = false): string =>
  renderToStaticMarkup(
    <AllDayStrip
      dates={WEEK}
      itemsFor={date => (date.getDate() === 22 ? items : [])}
      alwaysShow={alwaysShow}
    />
  );

describe('AllDayStrip', () => {
  it('renders nothing at all when no day has an item', () => {
    expect(render([])).toBe('');
  });

  it('stays on screen for a caller that can drop onto it', () => {
    // Staff: this is the only drop target that moves an event to another day
    // and keeps its time of day, so an empty week still needs the row.
    const html = render([], true);
    expect(html).toContain('All day');
    expect(html.match(/min-h-\[2\.25rem\]/g)).toHaveLength(7);
  });

  it('caps a day at three chips and offers the rest as a button', () => {
    const html = render([deadline(1), deadline(2), deadline(3), deadline(4)]);
    expect(html).toContain('Due: Assignment 3');
    expect(html).not.toContain('Due: Assignment 4');
    // Dead text in both calendars before; here it opens the day in place,
    // because this row only exists in the view it would otherwise navigate to.
    expect(html).toContain('+1 more</button>');
    // It is a toggle, so it says both what it will do and which day it is on.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Show 1 more item on Tue Sep 22"');
  });

  it('says when a deadline is due', () => {
    expect(render([deadline(1)])).toContain('due 11:59 PM');
  });

  it('flags an unpublished item as a draft, dashed, for the staff who can see it', () => {
    const html = render([{ ...deadline(1), is_unpublished: true }]);
    expect(html).toContain('border-dashed');
    expect(html).toContain('Draft');
  });
});
