import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { formatRelative } from '../ModuleSpotlightCard';

const now = dayjs('2026-09-23T12:00:00');

describe('spotlight assignment label', () => {
  it('says submitted, with the date, once the student has submitted', () => {
    expect(formatRelative('2026-09-20T12:00:00', true, now)).toBe('submitted · Sep 20');
    expect(formatRelative('2026-09-24T12:00:00', true, now)).toBe('submitted · Sep 24');
  });

  it('only calls an unsubmitted assignment overdue', () => {
    expect(formatRelative('2026-09-20T12:00:00', false, now)).toBe('overdue · Sep 20');
    expect(formatRelative('2026-09-23T18:00:00', false, now)).toBe('due today');
    expect(formatRelative('2026-09-24T18:00:00', false, now)).toBe('due tomorrow');
  });
});
