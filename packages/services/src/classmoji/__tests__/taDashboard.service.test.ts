import { describe, it, expect } from 'vitest';
import {
  bucketGrades,
  computeStreakDays,
  padDailyBuckets,
  toDayKey,
} from '../taDashboard.service.ts';

describe('toDayKey', () => {
  it('formats UTC YYYY-MM-DD', () => {
    expect(toDayKey(new Date('2026-04-19T23:59:59.000Z'))).toBe('2026-04-19');
  });
});

describe('padDailyBuckets', () => {
  it('zero-fills 7 days ending on endDay', () => {
    const counts = new Map<string, number>([
      ['2026-04-19', 3],
      ['2026-04-17', 1],
    ]);
    const out = padDailyBuckets(counts, '2026-04-19', 7);
    expect(out).toHaveLength(7);
    expect(out[0].date).toBe('2026-04-13');
    expect(out[6]).toEqual({ date: '2026-04-19', count: 3 });
    expect(out[4]).toEqual({ date: '2026-04-17', count: 1 });
    expect(out[5]).toEqual({ date: '2026-04-18', count: 0 });
  });

  it('handles empty counts map', () => {
    const out = padDailyBuckets(new Map(), '2026-04-19', 7);
    expect(out).toHaveLength(7);
    expect(out.every(b => b.count === 0)).toBe(true);
  });
});

describe('computeStreakDays', () => {
  it('returns 0 on empty', () => {
    expect(computeStreakDays([])).toEqual({ days: 0, lastDay: null });
  });

  it('counts consecutive days ending at most recent', () => {
    expect(computeStreakDays(['2026-04-17', '2026-04-18', '2026-04-19'])).toEqual({
      days: 3,
      lastDay: '2026-04-19',
    });
  });

  it('stops at first gap', () => {
    expect(computeStreakDays(['2026-04-10', '2026-04-17', '2026-04-18', '2026-04-19'])).toEqual({
      days: 3,
      lastDay: '2026-04-19',
    });
  });

  it('deduplicates repeats on the same day', () => {
    expect(computeStreakDays(['2026-04-19', '2026-04-19', '2026-04-18'])).toEqual({
      days: 2,
      lastDay: '2026-04-19',
    });
  });

  it('single-day streak', () => {
    expect(computeStreakDays(['2026-04-19'])).toEqual({
      days: 1,
      lastDay: '2026-04-19',
    });
  });
});

describe('bucketGrades', () => {
  it('produces 10 buckets', () => {
    const out = bucketGrades([]);
    expect(out).toHaveLength(10);
    expect(out[0].bucket).toBe('0-10');
    expect(out[9].bucket).toBe('90-100');
    expect(out.every(b => b.count === 0)).toBe(true);
  });

  it('bins by floor(grade/10)', () => {
    const out = bucketGrades([0, 9.9, 10, 55, 89.9, 90]);
    expect(out[0].count).toBe(2); // 0, 9.9
    expect(out[1].count).toBe(1); // 10
    expect(out[5].count).toBe(1); // 55
    expect(out[8].count).toBe(1); // 89.9
    expect(out[9].count).toBe(1); // 90
  });

  it('puts exactly 100 in the last bucket', () => {
    const out = bucketGrades([100, 100]);
    expect(out[9].count).toBe(2);
  });

  it('clamps out-of-range values', () => {
    const out = bucketGrades([-5, 150]);
    expect(out[0].count).toBe(1);
    expect(out[9].count).toBe(1);
  });

  it('ignores non-finite values', () => {
    const out = bucketGrades([NaN, Infinity, -Infinity, 50]);
    expect(out[5].count).toBe(1);
    const total = out.reduce((a, b) => a + b.count, 0);
    expect(total).toBe(1);
  });
});
