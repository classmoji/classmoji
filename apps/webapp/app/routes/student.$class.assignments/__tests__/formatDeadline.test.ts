import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { formatDeadline } from '../formatDeadline';

const now = dayjs('2026-09-23T12:00:00');

describe('formatDeadline', () => {
  it('never calls a completed (submitted) row overdue: plain date only', () => {
    expect(formatDeadline('2026-09-20T12:00:00', 'completed', now)).toBe('Sep 20');
    expect(formatDeadline('2026-09-23T18:00:00', 'completed', now)).toBe('Sep 23');
    expect(formatDeadline('2026-09-24T18:00:00', 'completed', now)).toBe('Sep 24');
  });

  it('counts down, and past, for a current row', () => {
    expect(formatDeadline('2026-09-20T12:00:00', 'current', now)).toBe('overdue · Sep 20');
    expect(formatDeadline('2026-09-23T18:00:00', 'current', now)).toBe('due today');
    expect(formatDeadline('2026-09-24T18:00:00', 'current', now)).toBe('due tomorrow');
    expect(formatDeadline('2026-10-01T18:00:00', 'current', now)).toBe('Oct 1');
  });
});
