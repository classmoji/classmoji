/**
 * The navigation rules both calendars now share.
 *
 * `stepDate` and `toggleTypeIn` are exported separately from the hook precisely
 * so the two rules that used to differ between the calendars can be asserted
 * without a renderer: a week step is seven days, a month step is a month that
 * survives the end of the month (Jan 31 → Feb 28, not March 3), and an empty
 * type selection means "everything", not "nothing".
 *
 * The handlers themselves are exercised through a server render, which is
 * enough because the thing worth protecting about them is the CALL they make
 * outwards — `onMonthChange`, which is what tells the route to load the month
 * the reader has just moved to. State changes are not observable from a server
 * render and are not asserted here.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CALENDAR_VIEW_STORAGE_KEY,
  stepDate,
  toggleTypeIn,
  useCalendarNavigation,
} from '../useCalendarNavigation';
import type { CalendarNavigation } from '../useCalendarNavigation';

const at = (iso: string) => new Date(iso);

/** The hook's value, captured out of one render, with its fan-out spy. */
const mountNavigation = () => {
  const onMonthChange = vi.fn();
  let nav!: CalendarNavigation;
  const Probe = () => {
    nav = useCalendarNavigation(onMonthChange);
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  return { nav, onMonthChange };
};

describe('stepDate', () => {
  it('pages a week at a time in week view', () => {
    expect(stepDate(at('2026-09-20T09:00:00'), 'week', 1).toDateString()).toBe(
      at('2026-09-27T09:00:00').toDateString()
    );
    expect(stepDate(at('2026-09-20T09:00:00'), 'week', -1).toDateString()).toBe(
      at('2026-09-13T09:00:00').toDateString()
    );
  });

  it('pages a month at a time in month view', () => {
    expect(stepDate(at('2026-09-20T09:00:00'), 'month', 1).toDateString()).toBe(
      at('2026-10-20T09:00:00').toDateString()
    );
    expect(stepDate(at('2026-09-20T09:00:00'), 'month', -1).toDateString()).toBe(
      at('2026-08-20T09:00:00').toDateString()
    );
  });

  it('clamps a month step to the last day of a shorter month', () => {
    // Naive month arithmetic turns Jan 31 into March 3, which would skip
    // February entirely as you paged forward.
    expect(stepDate(at('2026-01-31T09:00:00'), 'month', 1).toDateString()).toBe(
      at('2026-02-28T09:00:00').toDateString()
    );
  });

  it('crosses a year boundary in both directions', () => {
    expect(stepDate(at('2026-12-20T09:00:00'), 'month', 1).getFullYear()).toBe(2027);
    expect(stepDate(at('2026-01-05T09:00:00'), 'week', -1).getFullYear()).toBe(2025);
  });

  it('leaves the date it was given alone', () => {
    const original = at('2026-09-20T09:00:00');
    stepDate(original, 'week', 1);
    expect(original.getDate()).toBe(20);
  });
});

describe('the stored view', () => {
  it('keeps the key both roles already shared', () => {
    // Changing this silently resets everyone's chosen view to Week, and would
    // split the staff and student calendars back into two preferences.
    expect(CALENDAR_VIEW_STORAGE_KEY).toBe('classmoji-calendar-view');
  });
});

describe('toggleTypeIn', () => {
  it('adds a type that is not chosen yet', () => {
    expect(toggleTypeIn([], 'LAB')).toEqual(['LAB']);
    expect(toggleTypeIn(['LECTURE'], 'LAB')).toEqual(['LECTURE', 'LAB']);
  });

  it('empties the list when the last chosen type is turned off', () => {
    // Empty means "no filter". Anything else here would leave the calendar
    // showing nothing after a reader clicked the same chip twice.
    expect(toggleTypeIn(['LAB'], 'LAB')).toEqual([]);
  });

  it('leaves the other choices alone', () => {
    expect(toggleTypeIn(['LECTURE', 'LAB', 'DEADLINE'], 'LAB')).toEqual(['LECTURE', 'DEADLINE']);
  });

  it('does not mutate the list it was given', () => {
    const types = ['LECTURE'];
    toggleTypeIn(types, 'LAB');
    expect(types).toEqual(['LECTURE']);
  });
});

describe('the month fan-out', () => {
  it('tells the route which month "next" landed on', () => {
    const { nav, onMonthChange } = mountNavigation();
    const expected = stepDate(nav.currentDate, nav.view, 1);

    nav.goNext();

    expect(onMonthChange).toHaveBeenCalledWith(expected.getFullYear(), expected.getMonth());
  });

  it('tells the route which month "previous" landed on', () => {
    const { nav, onMonthChange } = mountNavigation();
    const expected = stepDate(nav.currentDate, nav.view, -1);

    nav.goPrevious();

    expect(onMonthChange).toHaveBeenCalledWith(expected.getFullYear(), expected.getMonth());
  });

  it('fires for Today as well', () => {
    // Today is a move like any other: a reader can press it from a month the
    // loader has never fetched.
    const { nav, onMonthChange } = mountNavigation();
    const today = new Date();

    nav.goToday();

    expect(onMonthChange).toHaveBeenCalledWith(today.getFullYear(), today.getMonth());
  });

  it('fires for focusDay, with the month of the day being opened', () => {
    // A month cell's "+N more" can point at a padding day belonging to the
    // NEXT month, which is a month the loader may not hold yet.
    const { nav, onMonthChange } = mountNavigation();

    nav.focusDay(new Date(2027, 2, 14));

    expect(onMonthChange).toHaveBeenCalledWith(2027, 2);
  });

  it('survives a caller that does not want to be told', () => {
    let nav!: CalendarNavigation;
    const Probe = () => {
      nav = useCalendarNavigation();
      return null;
    };
    renderToStaticMarkup(createElement(Probe));

    expect(() => nav.goNext()).not.toThrow();
    expect(() => nav.focusDay(new Date(2027, 2, 14))).not.toThrow();
  });
});
