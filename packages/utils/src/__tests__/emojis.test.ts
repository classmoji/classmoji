import { describe, it, expect } from 'vitest';
import {
  emojis,
  DEFAULT_EMOJI_MAPPINGS,
  DEFAULT_EMOJI_GRADE_MAPPINGS,
  DEFAULT_LETTER_GRADE_MAPPINGS,
  getEmojiSymbol,
} from '../emojis.ts';

describe('DEFAULT_EMOJI_GRADE_MAPPINGS', () => {
  it('mirrors DEFAULT_EMOJI_MAPPINGS as a {emoji: grade} record', () => {
    for (const entry of DEFAULT_EMOJI_MAPPINGS) {
      expect(DEFAULT_EMOJI_GRADE_MAPPINGS[entry.emoji]).toBe(entry.grade);
    }
    expect(Object.keys(DEFAULT_EMOJI_GRADE_MAPPINGS)).toHaveLength(DEFAULT_EMOJI_MAPPINGS.length);
  });
});

describe('DEFAULT_LETTER_GRADE_MAPPINGS', () => {
  it('is sorted from highest to lowest min_grade', () => {
    for (let i = 1; i < DEFAULT_LETTER_GRADE_MAPPINGS.length; i++) {
      expect(DEFAULT_LETTER_GRADE_MAPPINGS[i - 1].min_grade).toBeGreaterThanOrEqual(
        DEFAULT_LETTER_GRADE_MAPPINGS[i].min_grade
      );
    }
  });
});

describe('emojis lookup table', () => {
  it('contains the canonical github reaction set', () => {
    expect(emojis.HEART.githubValue).toBe('heart');
    expect(emojis.THUMBS_UP.githubValue).toBe('+1');
    expect(emojis.ROCKET.emoji).toBe('\u{1F680}');
  });
});

describe('getEmojiSymbol', () => {
  it('returns ❓ for empty key', () => {
    expect(getEmojiSymbol('')).toBe('\u{2753}');
  });

  it('resolves a known shortcode', () => {
    expect(getEmojiSymbol('heart')).toBe('\u{2764}\u{FE0F}');
    expect(getEmojiSymbol('+1')).toBe('\u{1F44D}');
  });

  it('falls back to lowercase shortcode lookup', () => {
    expect(getEmojiSymbol('HEART')).toBe('\u{2764}\u{FE0F}');
  });

  it('returns the input when it already looks like an emoji', () => {
    expect(getEmojiSymbol('\u{1F600}')).toBe('\u{1F600}');
  });

  it('returns the input unchanged for unknown plain strings', () => {
    expect(getEmojiSymbol('not-a-real-shortcode')).toBe('not-a-real-shortcode');
  });
});
