/**
 * The rule both event modals share when they turn one date and two clock times
 * into an event's start and end.
 *
 * It is a pure function in `utils.ts` precisely so it can be asserted here: the
 * modals that use it need a DOM, antd and a form instance, and none of that
 * makes the rule any clearer.
 */

import { describe, it, expect } from 'vitest';
import { buildEventWindow } from '../utils';

/** A local time on the modal's chosen date. */
const at = (h: number, m = 0) => new Date(2026, 8, 21, h, m);

describe('building an event’s start and end from one date and two times', () => {
  it('stamps both times onto the chosen date', () => {
    const { start, end } = buildEventWindow(new Date(2026, 8, 21), at(14), at(15, 30));

    expect(start.getHours()).toBe(14);
    expect(end.getHours()).toBe(15);
    expect(end.getMinutes()).toBe(30);
    expect(end.getDate()).toBe(21);
  });

  it('rolls the end onto the next day when it would land before the start', () => {
    // 11 PM → 12 AM is an hour-long event that crosses midnight, not a
    // twenty-three-hour negative one.
    const { start, end } = buildEventWindow(new Date(2026, 8, 21), at(23), at(0));

    expect(end.getTime()).toBeGreaterThan(start.getTime());
    expect(end.getDate()).toBe(22);
    expect(end.getTime() - start.getTime()).toBe(60 * 60 * 1000);
  });

  it('does NOT roll an end EQUAL to the start', () => {
    // Two identical times are a mistake, not a request for a day-long event.
    // Rolling it would answer the user silently and wrongly; leaving it as a
    // zero-length range lets the service refuse it and say so.
    const { start, end } = buildEventWindow(new Date(2026, 8, 21), at(9), at(9));

    expect(end.getTime()).toBe(start.getTime());
    expect(end.getDate()).toBe(21);
  });

  it('rolls only a real midnight crossing', () => {
    // One minute earlier than the start is a crossing; the same minute is not.
    const crossing = buildEventWindow(new Date(2026, 8, 21), at(9), at(8, 59));
    expect(crossing.end.getDate()).toBe(22);

    const equal = buildEventWindow(new Date(2026, 8, 21), at(9), at(9));
    expect(equal.end.getDate()).toBe(21);
  });

  it('leaves the date it was given alone', () => {
    const date = new Date(2026, 8, 21, 8, 15);
    buildEventWindow(date, at(23), at(0));

    expect(date.getDate()).toBe(21);
    expect(date.getHours()).toBe(8);
  });
});
