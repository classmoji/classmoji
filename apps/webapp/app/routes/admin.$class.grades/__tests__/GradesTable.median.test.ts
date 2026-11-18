/**
 * The class median in the gradebook footer: the middle value, or the mean of
 * the two middle values, exactly as it was computed before simple-statistics
 * started interpolating (7.8.9).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/components/features/grading/EmojiGrader', () => ({ default: () => null }));
vi.mock('~/components', () => ({ UserThumbnailView: () => null }));
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));

const { classMedian } = await import('../GradesTable');

describe('classMedian', () => {
  it('takes the middle value of an odd count', () => {
    expect(classMedian([90, 70, 80])).toBe(80);
    expect(classMedian([42])).toBe(42);
  });

  it('averages the two middle values of an even count', () => {
    expect(classMedian([100, 0, 50, 75])).toBe(62.5);
    expect(classMedian([25, 25, 75, 75])).toBe(50);
  });

  it('computes (a + b) / 2, so the one-decimal display stays as it was', () => {
    // Interpolating (a + 0.5 * (b - a)) gives 14.55 here, shown as "14.6".
    expect(classMedian([0.99, 28.11])).toBe((0.99 + 28.11) / 2);
    expect(classMedian([0.99, 28.11]).toFixed(1)).toBe('14.5');
  });

  it('does not reorder the caller’s array', () => {
    const values = [3, 1, 2];
    classMedian(values);
    expect(values).toEqual([3, 1, 2]);
  });
});
