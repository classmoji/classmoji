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
import { MemoryRouter } from 'react-router';
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

describe('MonthGrid — the starred resource', () => {
  const renderStarred = (
    featured: CalendarEventWithLinks['featured_resource'],
    extra: Partial<CalendarEventWithLinks> = {}
  ) =>
    // A starred assignment links through `NavLink`, which needs a router in
    // scope — the app always has one, this test has to bring its own.
    renderToStaticMarkup(
      <MemoryRouter>
        <MonthGrid
          dates={monthDates()}
          currentDate={SEPTEMBER}
          now={SEPTEMBER}
          eventsFor={date =>
            date.getDate() === 15 && date.getMonth() === 8
              ? [{ ...event('Week 1 Lecture', 9), featured_resource: featured, ...extra }]
              : []
          }
          classSlug="cs52-26f"
          rolePrefix="admin"
          pagesUrl="https://pages.test"
          slidesUrl="https://slides.test"
        />
      </MemoryRouter>
    );

  it('shows nothing under an event that has no star', () => {
    // The default, and what every event looked like before the star existed.
    expect(renderStarred(null)).not.toContain('https://pages.test');
  });

  it('links a starred page where the link list sends one', () => {
    const html = renderStarred({
      kind: 'page',
      id: 'p-1',
      title: 'Week 1 reading',
      is_draft: false,
    });

    expect(html).toContain('href="https://pages.test/cs52-26f/p-1"');
    expect(html).toContain('Week 1 reading');
  });

  it('names the kind as well as the title, so three chips are tellable apart', () => {
    expect(
      renderStarred({ kind: 'page', id: 'p-1', title: 'Logistics', is_draft: false })
    ).toContain('aria-label="Open page Logistics"');
    expect(renderStarred({ kind: 'slide', id: 's-1', title: 'Week 1', is_draft: false })).toContain(
      'aria-label="Open slide deck Week 1"'
    );
    expect(
      renderStarred({ kind: 'assignment', id: 'a-1', title: 'HW 1', is_draft: false })
    ).toContain('aria-label="Open assignment HW 1"');
  });

  it('wears the muted style rather than the global link colour, whatever the element', () => {
    // Without this the /admin anchor inherited the app's green while the peek
    // button inherited nothing, and one line read as two different things.
    //
    // The `!` is load-bearing and is asserted as part of the class: antd
    // injects an UNLAYERED `a { color: colorLink }`, and Tailwind v4 utilities
    // live in `@layer utilities`, which loses to unlayered CSS whatever the
    // specificity. The colour this actually computes to is checked in the
    // browser, by tests/owner/calendar/event-modals.spec.ts.
    for (const featured of [
      { kind: 'page' as const, id: 'p-1', title: 'A', is_draft: false },
      { kind: 'slide' as const, id: 's-1', title: 'B', is_draft: false },
      { kind: 'assignment' as const, id: 'a-1', title: 'C', is_draft: false },
    ]) {
      const html = renderStarred(featured);
      expect(html).toContain('text-ink-2!');
      expect(html).toContain('hover:text-ink-0!');
    }
  });

  it('keeps the whole title as a tooltip, because the line truncates', () => {
    expect(
      renderStarred({ kind: 'slide', id: 's-1', title: 'A very long deck name', is_draft: false })
    ).toContain('title="A very long deck name"');
  });

  it('links a starred deck to the slides viewer', () => {
    expect(
      renderStarred({ kind: 'slide', id: 's-1', title: 'Lecture 1', is_draft: false })
    ).toContain('href="https://slides.test/s-1"');
  });

  it('links a starred assignment to its repository anchor under this role', () => {
    // The anchor is the REPOSITORY's slug, which is not part of the starred
    // resource — it comes off the event's own assignment list.
    const html = renderStarred(
      { kind: 'assignment', id: 'a-1', title: 'HW 1', is_draft: false },
      {
        assignments: [
          {
            assignment: { id: 'a-1', title: 'HW 1', is_published: true },
            repository: { slug: 'homework', is_published: true },
          },
        ],
      }
    );

    expect(html).toContain('href="/admin/cs52-26f/repos#homework"');
  });

  it('marks a starred draft, so staff can see what the class cannot', () => {
    // A student is never handed a draft here — the service answers null — so
    // this pill only ever appears for staff.
    expect(
      renderStarred({ kind: 'page', id: 'p-1', title: 'Unfinished', is_draft: true })
    ).toContain('Draft');
    expect(
      renderStarred({ kind: 'page', id: 'p-1', title: 'Published', is_draft: false })
    ).not.toContain('Draft');
  });

  it('keeps the starred line outside the event button', () => {
    // A link inside a button is not something a browser can render, so the
    // chip's button has to close before the starred line opens.
    const html = renderStarred({ kind: 'slide', id: 's-1', title: 'Deck', is_draft: false });

    const buttonClose = html.indexOf('</button>');
    expect(buttonClose).toBeGreaterThan(-1);
    expect(html.indexOf('https://slides.test')).toBeGreaterThan(buttonClose);
  });

  it('leaves the three-chip cap alone', () => {
    // The starred line is not an event, so it must not eat a cell's slots.
    const withStar = (title: string, hour: number): CalendarEventWithLinks => ({
      ...event(title, hour),
      featured_resource: {
        kind: 'slide',
        id: `s-${title}`,
        title: `${title} deck`,
        is_draft: false,
      },
    });

    const html = renderToStaticMarkup(
      <MonthGrid
        dates={monthDates()}
        currentDate={SEPTEMBER}
        now={SEPTEMBER}
        eventsFor={date =>
          date.getDate() === 15 && date.getMonth() === 8
            ? [withStar('One', 9), withStar('Two', 10), withStar('Three', 11), withStar('Four', 12)]
            : []
        }
        slidesUrl="https://slides.test"
      />
    );

    expect(html).toContain('One deck');
    expect(html).toContain('Three deck');
    expect(html).not.toContain('Four');
    expect(html).toContain('+1 more');
  });
});
