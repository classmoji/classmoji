export const emojis = {
  THUMBS_UP: { emoji: '👍', githubValue: '+1' },
  THUMBS_DOWN: { emoji: '👎', githubValue: '-1' },
  LAUGH: { emoji: '😄', githubValue: 'laugh' },
  HOORAY: { emoji: '🎉', githubValue: 'hooray' },
  CONFUSED: { emoji: '😕', githubValue: 'confused' },
  HEART: { emoji: '❤️', githubValue: 'heart' },
  ROCKET: { emoji: '🚀', githubValue: 'rocket' },
  EYES: { emoji: '👀', githubValue: 'eyes' },
};

/**
 * Default emoji mappings with full metadata.
 * Single source of truth for both admin settings and quiz grading.
 */
export const DEFAULT_EMOJI_MAPPINGS = [
  { emoji: 'heart', grade: 100, extra_tokens: 0, description: 'Excellent work!' },
  { emoji: '+1', grade: 90, extra_tokens: 0, description: 'Great job!' },
  { emoji: 'eyes', grade: 80, extra_tokens: 0, description: 'Good work' },
  { emoji: '-1', grade: 60, extra_tokens: 0, description: 'Needs improvement' },
  { emoji: 'sob', grade: 0, extra_tokens: 0, description: 'Not submitted' },
];

/**
 * Simplified emoji-to-grade map derived from DEFAULT_EMOJI_MAPPINGS.
 * Used for quick lookups in quiz grading (gradeToEmoji function).
 * Format: { emoji_shortcode: grade_value }
 */
export const DEFAULT_EMOJI_GRADE_MAPPINGS = DEFAULT_EMOJI_MAPPINGS.reduce((acc, m) => {
  acc[m.emoji] = m.grade;
  return acc;
}, {});

/**
 * Default letter grade mappings with standard academic scale.
 * Single source of truth for admin settings.
 */
export const DEFAULT_LETTER_GRADE_MAPPINGS = [
  { letter_grade: 'A', min_grade: 90 },
  { letter_grade: 'B', min_grade: 80 },
  { letter_grade: 'C', min_grade: 70 },
  { letter_grade: 'D', min_grade: 60 },
  { letter_grade: 'F', min_grade: 0 },
];

/**
 * Extended emoji map for quiz progress indicators.
 * Maps GitHub-style shortcodes to emoji symbols.
 * Used by ProgressDivider to display quiz performance emojis.
 */
export const emojiShortcodes = {
  // From emojis object (githubValue → emoji)
  '+1': '👍',
  '-1': '👎',
  laugh: '😄',
  hooray: '🎉',
  confused: '😕',
  heart: '❤️',
  rocket: '🚀',
  eyes: '👀',
  // Additional common quiz emojis
  sob: '😭',
  star: '⭐',
  fire: '🔥',
  sparkles: '✨',
  trophy: '🏆',
  medal: '🏅',
  '100': '💯',
  brain: '🧠',
  bulb: '💡',
  checkmark: '✅',
  x: '❌',
  question: '❓',
  thinking: '🤔',
  clap: '👏',
  muscle: '💪',
  tada: '🎉',
  rainbow: '🌈',
  gem: '💎',
  crown: '👑',
  // Fallback for case variations
  ROCKET: '🚀',
  STAR: '⭐',
  FIRE: '🔥',
  HEART: '❤️',
};

/**
 * Convert an emoji shortcode to the actual emoji symbol.
 * Handles both lowercase (from DB) and uppercase (from legacy code).
 *
 * @param {string} key - Emoji shortcode (e.g., 'rocket', 'star', 'ROCKET')
 * @returns {string} The emoji symbol, or the original key if not found
 */
export const getEmojiSymbol = key => {
  if (!key) return '❓';

  // First try exact match
  if (emojiShortcodes[key]) {
    return emojiShortcodes[key];
  }

  // Try lowercase version
  const lowerKey = key.toLowerCase();
  if (emojiShortcodes[lowerKey]) {
    return emojiShortcodes[lowerKey];
  }

  // If it looks like it's already an emoji (starts with common emoji ranges), return as-is
  if (/^[\u{1F300}-\u{1F9FF}]|^[\u{2600}-\u{26FF}]|^[\u{2700}-\u{27BF}]/u.test(key)) {
    return key;
  }

  // Return the key itself as fallback (might already be an emoji)
  return key;
};
