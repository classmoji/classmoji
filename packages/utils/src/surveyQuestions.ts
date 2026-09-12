/**
 * Product questions the webapp asks a signed-in user once, on the classroom
 * picker. Answers are stored in `survey_responses`; this file is the only
 * definition of what gets asked, so adding a question is a new entry here, not
 * a migration. Plain data, safe to import on the client.
 */

export type SurveyAudience = 'all' | 'instructor' | 'student';

export interface SurveyOption {
  /** Stored as the row's `answer` when this is the picked leaf. */
  value: string;
  label: string;
  emoji: string;
  /** Placeholder for a free-text field shown once this option is picked. */
  detailPrompt?: string;
  /** One-tap answers for that field, shown as chips above it. */
  detailSuggestions?: string[];
  /** Keep this option at the bottom when the rest are shuffled (the catch-all). */
  pinLast?: boolean;
}

export interface SurveyQuestion {
  /** Stable id stored on the response row. Never rename once answers exist. */
  key: string;
  prompt: string;
  options: SurveyOption[];
  /** Who gets asked. `instructor`/`student` use the same role signal the
   *  response's `context` column records; `unknown` users are asked either way. */
  audience: SurveyAudience;
}

/** Answer recorded when the user dismisses the prompt without choosing. */
export const SURVEY_SKIPPED = 'skipped';

export const SURVEY_QUESTIONS: SurveyQuestion[] = [
  {
    key: 'referral_source',
    prompt: 'How did you hear about Classmoji?',
    // Students overwhelmingly skip this (they are here because their instructor
    // said so), so only people who are not yet a student anywhere get asked.
    audience: 'instructor',
    options: [
      { value: 'colleague', emoji: '🗣️', label: 'A colleague or friend' },
      { value: 'instructor', emoji: '🎓', label: 'My instructor or a course' },
      {
        value: 'conference',
        emoji: '🎤',
        label: 'A conference, workshop, or talk',
        detailPrompt: 'Which one? (SIGCSE, CCSC, a campus event…)',
      },
      { value: 'search', emoji: '🔍', label: 'Web search' },
      { value: 'ai', emoji: '🤖', label: 'ChatGPT, Claude, or another AI assistant' },
      { value: 'github', emoji: '🐙', label: 'Github' },
      {
        value: 'social',
        emoji: '📱',
        label: 'Social media',
        detailPrompt: 'Which platform?',
        detailSuggestions: ['Reddit', 'LinkedIn'],
      },
      { value: 'publication', emoji: '📰', label: 'A newsletter, blog post, or podcast' },
      {
        value: 'other',
        emoji: '✨',
        label: 'Somewhere else',
        detailPrompt: 'Where?',
        pinLast: true,
      },
    ],
  },
];

export const getSurveyQuestion = (key: string): SurveyQuestion | undefined =>
  SURVEY_QUESTIONS.find(q => q.key === key);

export const findSurveyOption = (
  question: SurveyQuestion,
  value: string
): SurveyOption | undefined => question.options.find(o => o.value === value);

// FNV-1a, then mulberry32: enough to turn "user id + question key" into a
// stable shuffle. Not for anything that needs real randomness.
const hashSeed = (input: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * The question with its options in a per-seed order, so the first slot is not
 * always the same choice (top options get over-picked). Pinned options keep
 * their place at the end. Same seed, same order, so a user's list does not
 * reshuffle between renders.
 */
export const randomizeSurveyOptions = (question: SurveyQuestion, seed: string): SurveyQuestion => {
  const rand = seededRandom(hashSeed(`${seed}:${question.key}`));
  const shuffled = question.options.filter(o => !o.pinLast);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return { ...question, options: [...shuffled, ...question.options.filter(o => o.pinLast)] };
};
