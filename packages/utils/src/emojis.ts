export interface EmojiEntry {
  emoji: string;
  githubValue: string;
}

export interface EmojiMappingEntry {
  emoji: string;
  grade: number;
  extra_tokens: number;
  description: string;
}

export interface LetterGradeMappingEntry {
  letter_grade: string;
  min_grade: number;
}

export const emojis: Record<string, EmojiEntry> = {
  THUMBS_UP: { emoji: '\u{1F44D}', githubValue: '+1' },
  THUMBS_DOWN: { emoji: '\u{1F44E}', githubValue: '-1' },
  LAUGH: { emoji: '\u{1F604}', githubValue: 'laugh' },
  HOORAY: { emoji: '\u{1F389}', githubValue: 'hooray' },
  CONFUSED: { emoji: '\u{1F615}', githubValue: 'confused' },
  HEART: { emoji: '\u{2764}\u{FE0F}', githubValue: 'heart' },
  ROCKET: { emoji: '\u{1F680}', githubValue: 'rocket' },
  EYES: { emoji: '\u{1F440}', githubValue: 'eyes' },
};

/**
 * Default emoji mappings with full metadata.
 * Single source of truth for both admin settings and quiz grading.
 */
export const DEFAULT_EMOJI_MAPPINGS: EmojiMappingEntry[] = [
  { emoji: 'heart', grade: 100, extra_tokens: 0, description: 'Excellent work!' },
  { emoji: '+1', grade: 90, extra_tokens: 0, description: 'Great job!' },
  { emoji: 'eyes', grade: 80, extra_tokens: 0, description: 'Good work' },
  { emoji: '-1', grade: 60, extra_tokens: 0, description: 'Needs improvement' },
  { emoji: 'sob', grade: 0, extra_tokens: 0, description: 'Not submitted' },
];

/**
 * Simplified emoji-to-grade map derived from DEFAULT_EMOJI_MAPPINGS.
 * Used for quick lookups in quiz grading (gradeToEmoji function).
 */
export const DEFAULT_EMOJI_GRADE_MAPPINGS: Record<string, number> = DEFAULT_EMOJI_MAPPINGS.reduce(
  (acc, m) => {
    acc[m.emoji] = m.grade;
    return acc;
  },
  {} as Record<string, number>
);

/**
 * Default letter grade mappings with standard academic scale.
 * Single source of truth for admin settings.
 */
export const DEFAULT_LETTER_GRADE_MAPPINGS: LetterGradeMappingEntry[] = [
  { letter_grade: 'A', min_grade: 90 },
  { letter_grade: 'B', min_grade: 80 },
  { letter_grade: 'C', min_grade: 70 },
  { letter_grade: 'D', min_grade: 60 },
  { letter_grade: 'F', min_grade: 0 },
];

/**
 * Extended emoji map for quiz progress indicators.
 * Maps GitHub-style shortcodes to emoji symbols.
 */
export const emojiShortcodes: Record<string, string> = {
  '+1': '\u{1F44D}',
  '-1': '\u{1F44E}',
  laugh: '\u{1F604}',
  hooray: '\u{1F389}',
  confused: '\u{1F615}',
  heart: '\u{2764}\u{FE0F}',
  rocket: '\u{1F680}',
  eyes: '\u{1F440}',
  sob: '\u{1F62D}',
  star: '\u{2B50}',
  fire: '\u{1F525}',
  sparkles: '\u{2728}',
  trophy: '\u{1F3C6}',
  medal: '\u{1F3C5}',
  '100': '\u{1F4AF}',
  brain: '\u{1F9E0}',
  bulb: '\u{1F4A1}',
  checkmark: '\u{2705}',
  x: '\u{274C}',
  question: '\u{2753}',
  thinking: '\u{1F914}',
  clap: '\u{1F44F}',
  muscle: '\u{1F4AA}',
  tada: '\u{1F389}',
  rainbow: '\u{1F308}',
  gem: '\u{1F48E}',
  crown: '\u{1F451}',
  ROCKET: '\u{1F680}',
  STAR: '\u{2B50}',
  FIRE: '\u{1F525}',
  HEART: '\u{2764}\u{FE0F}',
};

/**
 * Convert an emoji shortcode to the actual emoji symbol.
 * Handles both lowercase (from DB) and uppercase (from legacy code).
 */
export const getEmojiSymbol = (key: string): string => {
  if (!key) return '\u{2753}';

  if (emojiShortcodes[key]) {
    return emojiShortcodes[key];
  }

  const lowerKey = key.toLowerCase();
  if (emojiShortcodes[lowerKey]) {
    return emojiShortcodes[lowerKey];
  }

  if (/^[\u{1F300}-\u{1F9FF}]|^[\u{2600}-\u{26FF}]|^[\u{2700}-\u{27BF}]/u.test(key)) {
    return key;
  }

  return key;
};
