/**
 * The navigation rules both calendars now share.
 *
 * `stepDate` is exported separately from the hook precisely so the paging rule
 * can be asserted without a renderer: a week step is seven days, a month step
 * is a month that survives the end of the month (Jan 31 → Feb 28, not March 3),
 * and neither is allowed to quietly become the other.
 */

import { describe, expect, it } from 'vitest';
import { CALENDAR_VIEW_STORAGE_KEY, stepDate } from '../useCalendarNavigation';

const at = (iso: string) => new Date(iso);

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
