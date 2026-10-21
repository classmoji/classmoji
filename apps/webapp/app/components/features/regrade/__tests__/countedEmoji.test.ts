/**
 * The "Counted" line of the resolve modal and the attempt drawer: what a
 * picked emoji counts for after the late penalty (D2: the adjustment applies
 * before the penalty), as the nearest emoji on the classroom's scale. One
 * helper for both (`countedQuizEmoji`, and its per-scale map for the drawer).
 */
import { describe, expect, it } from 'vitest';
import { countedQuizEmoji as countedEmojiFor, countedQuizEmojiMap } from '@classmoji/utils';

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

  it('is the picked emoji itself when late but the penalty takes nothing off', () => {
    // Two entries share 90; the nearest to 90 is '+1' by the tie rule.
    const SHARED = { rocket: 100, '+1': 90, tada: 90, eyes: 80 };
    expect(countedEmojiFor('tada', SHARED, 3, 0)).toBe('tada');
    // A zero grade cannot drop further.
    expect(countedEmojiFor('sob', EMOJI, 3, 5)).toBe('sob');
    // With a penalty it is re-read from the lowered value.
    expect(countedEmojiFor('tada', SHARED, 2, 5)).toBe('eyes');
  });

  it('is nothing until an emoji is picked', () => {
    expect(countedEmojiFor(null, NUMERIC, 3, 1)).toBeNull();
  });
});

describe('countedQuizEmojiMap', () => {
  it('maps every emoji on the scale to what it counts for', () => {
    expect(countedQuizEmojiMap(EMOJI, 0, 5)).toEqual({
      rocket: 'rocket',
      '+1': '+1',
      eyes: 'eyes',
      '-1': '-1',
      sob: 'sob',
    });
    expect(countedQuizEmojiMap(NUMERIC, 6, 1)['score-90']).toBe('score-80');
  });
});
