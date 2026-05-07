import { describe, it, expect } from 'vitest';
import {
  computeGradeMedian,
  computeMedianTimeToGradeHours,
  emojiToGrade,
} from '../dashboard.service.ts';

describe('computeGradeMedian', () => {
  it('returns null on empty', () => {
    expect(computeGradeMedian([])).toBeNull();
  });

  it('filters null/undefined/NaN', () => {
    expect(computeGradeMedian([null, undefined, NaN, 50])).toBe(50);
  });

  it('computes odd-length median', () => {
    expect(computeGradeMedian([1, 9, 5])).toBe(5);
  });

  it('computes even-length median', () => {
    expect(computeGradeMedian([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('emojiToGrade', () => {
  it('prefers classroom mapping over default', () => {
    const map = new Map([['heart', 95]]);
    expect(emojiToGrade('heart', map)).toBe(95);
  });

  it('falls back to default mapping', () => {
    expect(emojiToGrade('heart', new Map())).toBe(100);
  });

  it('returns null for unknown emoji', () => {
    expect(emojiToGrade('unknown-emoji-xyz', new Map())).toBeNull();
  });
});

describe('computeMedianTimeToGradeHours', () => {
  it('returns null on empty', () => {
    expect(computeMedianTimeToGradeHours([])).toBeNull();
  });

  it('ignores rows missing either timestamp', () => {
    const graded = new Date('2026-01-01T10:00:00Z');
    expect(
      computeMedianTimeToGradeHours([
        { submittedAt: null, gradedAt: graded },
        { submittedAt: graded, gradedAt: null },
      ])
    ).toBeNull();
  });

  it('computes hour diff median', () => {
    const submit = new Date('2026-01-01T00:00:00Z');
    const g1 = new Date('2026-01-01T02:00:00Z'); // 2h
    const g2 = new Date('2026-01-01T04:00:00Z'); // 4h
    const g3 = new Date('2026-01-01T06:00:00Z'); // 6h
    expect(
      computeMedianTimeToGradeHours([
        { submittedAt: submit, gradedAt: g1 },
        { submittedAt: submit, gradedAt: g2 },
        { submittedAt: submit, gradedAt: g3 },
      ])
    ).toBe(4);
  });

  it('skips negative diffs', () => {
    const submit = new Date('2026-01-02T00:00:00Z');
    const graded = new Date('2026-01-01T00:00:00Z');
    expect(computeMedianTimeToGradeHours([{ submittedAt: submit, gradedAt: graded }])).toBeNull();
  });
});
