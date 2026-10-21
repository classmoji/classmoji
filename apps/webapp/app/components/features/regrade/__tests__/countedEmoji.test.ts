/**
 * The resolve modal's "Counted" line: what a picked emoji counts for after
 * the late penalty (D2: the adjustment applies before the penalty), as the
 * nearest emoji on the classroom's scale.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));

const { countedEmojiFor } = await import('../ResolveQuizRegradeModal');

const NUMERIC = Object.fromEntries(
  Array.from({ length: 11 }, (_, i) => [`score-${i * 10}`, i * 10])
);
const EMOJI = { rocket: 100, '+1': 90, eyes: 80, '-1': 60, sob: 0 };

describe('countedEmojiFor', () => {
  it('is the picked emoji itself when the attempt was on time', () => {
    expect(countedEmojiFor('eyes', EMOJI, 0, 5)).toBe('eyes');
    expect(countedEmojiFor('score-90', NUMERIC, 0, 5)).toBe('score-90');
  });

  it('takes the penalty off the picked value, then reads the nearest emoji', () => {
    // 90 − 6h × 1 = 84 → score-80.
    expect(countedEmojiFor('score-90', NUMERIC, 6, 1)).toBe('score-80');
    // 90 − 30h × 1 = 60 → 👎.
    expect(countedEmojiFor('+1', EMOJI, 30, 1)).toBe('-1');
    // Never below 0.
    expect(countedEmojiFor('score-10', NUMERIC, 100, 5)).toBe('score-0');
  });

  it('is nothing until an emoji is picked', () => {
    expect(countedEmojiFor(null, NUMERIC, 3, 1)).toBeNull();
  });
});
