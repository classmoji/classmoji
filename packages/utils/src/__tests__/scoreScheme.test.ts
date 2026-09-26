import { describe, expect, it } from 'vitest';
import { isScoreScheme, scoreEmojiId, SCORE_EMOJI_VALUES } from '../emojis';

describe('isScoreScheme', () => {
  it('is true for the built-in 0–100 scale', () => {
    expect(isScoreScheme(SCORE_EMOJI_VALUES.map(scoreEmojiId))).toBe(true);
  });

  it('is true for a hand-picked subset of scores', () => {
    expect(isScoreScheme(['score-0', 'score-50', 'score-100'])).toBe(true);
  });

  it('is false for the glyph scale and for a mix', () => {
    expect(isScoreScheme(['heart', '+1', 'eyes'])).toBe(false);
    expect(isScoreScheme(['score-100', 'heart'])).toBe(false);
  });

  it('is false for an empty scale', () => {
    expect(isScoreScheme([])).toBe(false);
  });
});
