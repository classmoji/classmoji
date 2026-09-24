/**
 * What the server renders for the week strip, which is also what the first
 * client render must reproduce for hydration to match. `renderToStaticMarkup`
 * takes the server snapshot of `useHydrated`, so this is the pre-hydration
 * frame: the loader's week, with no events and no "today" circle, neither of
 * which can be known without the browser's time zone.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import WeeklyCalendarCard, { type WeekEvent } from '../WeeklyCalendarCard';

const events: WeekEvent[] = [
  {
    id: 'e1',
    title: 'Wed lecture',
    start_time: '2026-09-23T18:00:00Z',
    event_type: 'LECTURE',
    is_deadline: false,
  },
];

const render = (weekStart: string) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <WeeklyCalendarCard events={events} weekStart={weekStart} classSlug="cs52" />
    </MemoryRouter>
  );

describe('WeeklyCalendarCard server render', () => {
  it("shows the loader's week as given, Sunday first", () => {
    const html = render('2026-09-20');
    expect(html).toContain('September 20–26');
    const dates = [...html.matchAll(/rounded-full text-sm font-semibold mt-1[^>]*>(\d+)</g)].map(
      m => m[1]
    );
    expect(dates).toEqual(['20', '21', '22', '23', '24', '25', '26']);
  });

  it('leaves out the time-zone-dependent parts until hydration', () => {
    const html = render('2026-09-20');
    expect(html).not.toContain('Wed lecture');
    expect(html).not.toContain('--accent');
  });
});
