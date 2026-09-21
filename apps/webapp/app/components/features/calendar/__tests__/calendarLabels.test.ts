/**
 * The strings the header and the chips are made of, and the key the grids put
 * on a rendered occurrence.
 *
 * These are pure functions for one reason: they are what the two calendars
 * disagreed about, and a disagreement about a string is only visible if the
 * string can be asserted on its own.
 */

import { describe, expect, it } from 'vitest';
import {
  eventKey,
  formatDayRange,
  formatMonthYear,
  formatShortTime,
  formatTimeRange,
} from '../utils';

describe('formatMonthYear', () => {
  it('is the month and the full year', () => {
    expect(formatMonthYear(new Date(2026, 8, 20))).toBe('September 2026');
  });
});

describe('formatDayRange', () => {
  it('drops the month when the week is inside one', () => {
    // The primary label already says September; repeating it in the secondary
    // one is what made the student header wrap.
    expect(formatDayRange(new Date(2026, 8, 20), new Date(2026, 8, 26))).toBe('20 – 26');
  });

  it('names both months when the week straddles them', () => {
    expect(formatDayRange(new Date(2026, 8, 27), new Date(2026, 9, 3))).toBe('Sep 27 – Oct 3');
  });

  it('names both months when the week straddles a year', () => {
    expect(formatDayRange(new Date(2026, 11, 27), new Date(2027, 0, 2))).toBe('Dec 27 – Jan 2');
  });
});

describe('formatShortTime', () => {
  it('drops :00 minutes', () => {
    expect(formatShortTime(new Date(2026, 8, 20, 9, 0))).toBe('9 AM');
  });

  it('keeps minutes when there are any', () => {
    expect(formatShortTime(new Date(2026, 8, 20, 23, 59))).toBe('11:59 PM');
  });

  it('prints midnight and noon as 12, never as 0', () => {
    expect(formatShortTime(new Date(2026, 8, 20, 0, 0))).toBe('12 AM');
    expect(formatShortTime(new Date(2026, 8, 20, 12, 30))).toBe('12:30 PM');
  });
});

describe('formatTimeRange', () => {
  const on = (h: number, m: number) => new Date(2026, 8, 22, h, m);

  it('writes the meridiem once when both ends share it', () => {
    // The block has ONE line for the time and the room; `2:10 PM - 3:15 PM`
    // spends a third of it saying PM twice.
    expect(formatTimeRange(on(14, 10), on(15, 15))).toMatch(/^2:10\s*–\s*3:15\s*PM$/);
    expect(formatTimeRange(on(10, 0), on(11, 0))).toMatch(/^10:00\s*–\s*11:00\s*AM$/);
  });

  it('keeps both when they differ', () => {
    expect(formatTimeRange(on(11, 30), on(12, 30))).toMatch(/^11:30\s*AM\s*–\s*12:30\s*PM$/);
  });

  it('treats noon as PM and midnight as AM', () => {
    expect(formatTimeRange(on(12, 0), on(13, 0))).toMatch(/^12:00\s*–\s*1:00\s*PM$/);
    expect(formatTimeRange(on(23, 0), on(0, 30))).toMatch(/^11:00\s*PM\s*–\s*12:30\s*AM$/);
  });
});

describe('eventKey', () => {
  const base = {
    start_time: '2026-09-20T09:00:00.000Z',
    end_time: '2026-09-20T10:00:00.000Z',
    event_type: 'LECTURE',
  };

  it('separates two occurrences of one recurring event', () => {
    // Both rows carry the same id: keyed on the id alone, React reuses one
    // node for two different days.
    const monday = eventKey({ ...base, id: 'evt-1', occurrence_date: '2026-09-21' }, 0);
    const wednesday = eventKey({ ...base, id: 'evt-1', occurrence_date: '2026-09-23' }, 1);
    expect(monday).not.toBe(wednesday);
    expect(monday).toContain('evt-1');
  });

  it('is just the id for a one-off event', () => {
    expect(eventKey({ ...base, id: 'evt-2' }, 0)).toBe('evt-2');
  });

  it('falls back to the index when an item has no id at all', () => {
    expect(eventKey({ ...base }, 3)).toBe('index-3');
  });
});
