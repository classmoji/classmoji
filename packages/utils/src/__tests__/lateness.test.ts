import { describe, expect, it } from 'vitest';
import {
  extendedDeadlineMs,
  isPastDeadlineIgnoringOverride,
  netExtensionHours,
} from '../lateness.ts';

const HOUR = 3_600_000;
const deadline = new Date('2026-03-01T00:00:00Z');
const tx = (...hours: (number | null)[]) => hours.map(h => ({ hours_purchased: h }));

describe('netExtensionHours', () => {
  it('sums every transaction, refunds included, never below zero', () => {
    expect(netExtensionHours(tx(3, 2))).toBe(5);
    expect(netExtensionHours(tx(3, -3))).toBe(0);
    expect(netExtensionHours(tx(-2))).toBe(0);
    expect(netExtensionHours(tx(null, 1))).toBe(1);
    expect(netExtensionHours(null)).toBe(0);
  });
});

describe('extendedDeadlineMs', () => {
  it('pushes the deadline out by the net hours bought', () => {
    expect(extendedDeadlineMs(deadline, tx(4))).toBe(deadline.getTime() + 4 * HOUR);
    expect(extendedDeadlineMs(deadline.toISOString(), tx(4, -4))).toBe(deadline.getTime());
  });

  it('is null without a valid deadline', () => {
    expect(extendedDeadlineMs(null, tx(4))).toBeNull();
    expect(extendedDeadlineMs('not a date', tx(4))).toBeNull();
  });
});

describe('isPastDeadlineIgnoringOverride', () => {
  const row = (closedAt: Date | null, hours: number[] = []) => ({
    closed_at: closedAt,
    assignment: { student_deadline: deadline },
    token_transactions: tx(...hours),
  });

  it('measures a submission from the deadline plus the hours bought, in whole hours', () => {
    const at = (h: number) => new Date(deadline.getTime() + h * HOUR);
    expect(isPastDeadlineIgnoringOverride(row(at(3), [3]))).toBe(false);
    expect(isPastDeadlineIgnoringOverride(row(at(4), [3]))).toBe(true);
    expect(isPastDeadlineIgnoringOverride(row(at(3), [3, -3]))).toBe(true);
    expect(isPastDeadlineIgnoringOverride(row(at(0.5)))).toBe(false);
  });

  it('counts an unsubmitted row late once the extended deadline has passed', () => {
    const now = new Date(deadline.getTime() + 2 * HOUR);
    expect(isPastDeadlineIgnoringOverride(row(null, [3]), now)).toBe(false);
    expect(isPastDeadlineIgnoringOverride(row(null, [1]), now)).toBe(true);
  });

  it('is never late without a deadline', () => {
    expect(
      isPastDeadlineIgnoringOverride({ closed_at: new Date(), assignment: null }, new Date())
    ).toBe(false);
  });
});
