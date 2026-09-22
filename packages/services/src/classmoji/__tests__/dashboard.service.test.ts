import { describe, it, expect } from 'vitest';
import {
  computeGradeMedian,
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

