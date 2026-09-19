import { describe, it, expect } from 'vitest';
import {
  emojis,
  DEFAULT_EMOJI_MAPPINGS,
  DEFAULT_EMOJI_GRADE_MAPPINGS,
  DEFAULT_LETTER_GRADE_MAPPINGS,
  getEmojiSymbol,
  SCORE_EMOJI_VALUES,
  SCORE_EMOJI_MAPPINGS,
  parseScoreEmoji,
  scoreEmojiId,
  scoreEmojiDataUri,
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

describe('score emojis', () => {
  it('offers 21 values from 0 to 100 in steps of 5', () => {
    expect(SCORE_EMOJI_VALUES).toHaveLength(21);
    expect(SCORE_EMOJI_VALUES[0]).toBe(0);
    expect(SCORE_EMOJI_VALUES[20]).toBe(100);
    expect(SCORE_EMOJI_VALUES.every(v => v % 5 === 0)).toBe(true);
  });

  it('maps every value to a descending grade scale whose ids round-trip', () => {
    expect(SCORE_EMOJI_MAPPINGS).toHaveLength(21);
    for (let i = 1; i < SCORE_EMOJI_MAPPINGS.length; i++) {
      expect(SCORE_EMOJI_MAPPINGS[i - 1].grade).toBeGreaterThan(SCORE_EMOJI_MAPPINGS[i].grade);
    }
    for (const entry of SCORE_EMOJI_MAPPINGS) {
      expect(parseScoreEmoji(entry.emoji)).toBe(entry.grade);
      expect(entry.emoji).toBe(scoreEmojiId(entry.grade));
      expect(entry.emoji.length).toBeLessThanOrEqual(16);
    }
  });

  it('parses only lowercase score-N ids in the 0–100 range', () => {
    expect(parseScoreEmoji('score-0')).toBe(0);
    expect(parseScoreEmoji('score-83')).toBe(83);
    expect(parseScoreEmoji('score-100')).toBe(100);
    expect(parseScoreEmoji('score-101')).toBeNull();
    expect(parseScoreEmoji('score-')).toBeNull();
    expect(parseScoreEmoji('scores-5')).toBeNull();
    expect(parseScoreEmoji('SCORE-5')).toBeNull();
    expect(parseScoreEmoji('heart')).toBeNull();
    expect(parseScoreEmoji('')).toBeNull();
  });

  it('renders as the bare number in text contexts', () => {
    expect(getEmojiSymbol('score-85')).toBe('85');
    expect(getEmojiSymbol('score-0')).toBe('0');
  });

  it('produces an svg data uri containing the number', () => {
    const uri = scoreEmojiDataUri(0);
    expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
    expect(svg).toContain('<svg');
    expect(svg).toContain('>0</text>');
    expect(decodeURIComponent(scoreEmojiDataUri(100))).toContain('>100</text>');
  });
});
