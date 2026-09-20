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
 * Built-in numeric grade emojis: `score-0` … `score-100`.
 *
 * Every emoji in Classmoji is a shortcode string. This is a second family of
 * shortcodes that resolves to a generated SVG badge (a number in a rounded square)
 * instead of a unicode glyph. Nothing beyond the shortcode is stored, so the
 * ids drop into EmojiMapping / AssignmentGrade unchanged.
 */
export const SCORE_EMOJI_PREFIX = 'score-';
export const SCORE_EMOJI_STEP = 5;
/**
 * Sampled from Apple's keycap number emojis (1️⃣ … 🔟): a pale sheen at the
 * top, blue-slate body, darker edge. The badges then read as one family with
 * them. One palette for the whole set.
 */
export const SCORE_EMOJI_COLORS = {
  highlight: '#b4c9db', // thin sheen along the top edge
  top: '#7a9fbf',
  bottom: '#5b758d',
  edge: '#54708b',
};

/** 0, 5, 10 … 100 — the 21 values the picker and the populate button offer. */
export const SCORE_EMOJI_VALUES: number[] = Array.from(
  { length: 100 / SCORE_EMOJI_STEP + 1 },
  (_, i) => i * SCORE_EMOJI_STEP
);

export const scoreEmojiId = (value: number): string => `${SCORE_EMOJI_PREFIX}${value}`;

/**
 * Whether a grading scale is the numeric one: every emoji in it is a
 * `score-N` badge. Such a scale is graded with one number per grader, not by
 * stacking emojis.
 */
export const isScoreScheme = (emojiKeys: string[]): boolean =>
  emojiKeys.length > 0 && emojiKeys.every(key => parseScoreEmoji(key) !== null);

/**
 * The numeric value of a score shortcode, or null when `key` is not one.
 * Accepts any integer 0–100 (not only multiples of 5) so a hand-entered
 * `score-83` still renders. Case-sensitive: ids are always lowercase.
 */
export const parseScoreEmoji = (key: string): number | null => {
  const match = /^score-(\d{1,3})$/.exec(key ?? '');
  if (!match) return null;
  const value = Number(match[1]);
  return value >= 0 && value <= 100 ? value : null;
};

/** SVG markup for one badge: a white bold number centered in a rounded slate square. */
export const scoreEmojiSvg = (value: number): string => {
  // Three digits need a smaller face; both get a little tracking so the digits
  // do not touch.
  const fontSize = value >= 100 ? 20 : 26;
  const letterSpacing = value >= 100 ? 1 : 1.5;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
    `<stop offset="0" stop-color="${SCORE_EMOJI_COLORS.highlight}"/>` +
    `<stop offset="0.14" stop-color="${SCORE_EMOJI_COLORS.top}"/>` +
    `<stop offset="1" stop-color="${SCORE_EMOJI_COLORS.bottom}"/>` +
    '</linearGradient></defs>' +
    `<rect x="0.5" y="0.5" width="63" height="63" rx="16" fill="url(#g)" stroke="${SCORE_EMOJI_COLORS.edge}"/>` +
    `<text x="32" y="32" fill="#fff" font-family="system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" ` +
    `font-size="${fontSize}" font-weight="700" letter-spacing="${letterSpacing}" text-anchor="middle" dominant-baseline="central">${value}</text>` +
    '</svg>'
  );
};

/** A `data:` URI for the badge, usable as an <img src> or an emoji-mart custom skin. */
export const scoreEmojiDataUri = (value: number): string =>
  `data:image/svg+xml,${encodeURIComponent(scoreEmojiSvg(value))}`;

/**
 * The 0–100 grade scale as emoji mappings, highest first (the `grade: desc`
 * order the settings table and the grade math expect).
 */
export const SCORE_EMOJI_MAPPINGS: EmojiMappingEntry[] = [...SCORE_EMOJI_VALUES]
  .reverse()
  .map(value => ({
    emoji: scoreEmojiId(value),
    grade: value,
    extra_tokens: 0,
    description: `${value} / 100`,
  }));

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

  // Score badges have no glyph; the number is the honest text form.
  const score = parseScoreEmoji(key);
  if (score !== null) return String(score);

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
