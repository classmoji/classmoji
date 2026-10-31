/**
 * The UI copy Ask Moji shows every user: the welcome text, the suggested
 * questions, and the fixed lines a failure may show. The widget shows an
 * error only when its text is one of these (`ASK_MOJI_ERROR_COPY`); the task
 * and the session route send codes, never their own text. Both read this one
 * module, so the two can never drift apart.
 *
 * Copy only: no mechanics, no timing. No model-facing text lives here.
 */
import type { AskMojiRole } from './tools.ts';

/** Shown above the first reply (today's wording). */
export const ASK_MOJI_WELCOME =
  "Hi! I'm your course assistant. Ask me anything about the syllabus, assignments, or course content!";

export type AskMojiSuggestion = { text: string; icon: string };

/** Suggested questions for students and assistants (today's set). */
export const ASK_MOJI_STUDENT_SUGGESTIONS: readonly AskMojiSuggestion[] = [
  { text: 'What assignments are due this week?', icon: 'calendar' },
  { text: 'How do I check my quiz scores?', icon: 'chart' },
  { text: "What's the late policy?", icon: 'clock' },
  { text: 'How do I get help with an assignment?', icon: 'help' },
];

/** Suggested questions for instructors (today's set). */
export const ASK_MOJI_INSTRUCTOR_SUGGESTIONS: readonly AskMojiSuggestion[] = [
  { text: 'Show class grade distribution', icon: 'chart' },
  { text: 'Which students have missing submissions?', icon: 'alert' },
  { text: 'What quizzes are available this week?', icon: 'quiz' },
  { text: 'How are students performing on recent assignments?', icon: 'analytics' },
];

/** TEACHER and OWNER get the instructor set; ASSISTANT and STUDENT the student set. */
export function suggestionsForRole(role: AskMojiRole | string): readonly AskMojiSuggestion[] {
  return role === 'TEACHER' || role === 'OWNER'
    ? ASK_MOJI_INSTRUCTOR_SUGGESTIONS
    : ASK_MOJI_STUDENT_SUGGESTIONS;
}

/**
 * Every fixed line, by code. The first block is today's wording, word for
 * word (the webapp's syllabus-bot route and hook, the ai-agent's error
 * lines); the rest is new with the Trigger runtime.
 */
export const ASK_MOJI_COPY = {
  INIT_FAILED: 'Could not start the assistant. Please try again.',
  SEND_FAILED: 'Could not send your message. Please try again.',
  SESSION_ENDED: 'This conversation has ended. Start a new one to keep asking.',
  CONVERSATION_ENDED: 'This conversation has ended. Start a new one to keep asking.',
  UNAVAILABLE: "Ask Moji isn't available in this class.",
  NOT_ENABLED: 'Ask Moji is not enabled for this course.',
  BUSY: 'The AI service is temporarily busy. Please wait a moment and try again.',
  RATE_LIMITED: 'Too many requests. Please wait a moment before continuing.',
  CONNECTION_FAILED: "I'm having trouble connecting right now. Please try again.",
  /** A reply that could not be finished (it failed, or ran out of steps or time). */
  REPLY_FAILED: "Ask Moji couldn't finish that answer. Please ask again.",
  ERROR: 'Ask Moji hit an error.',

  MCP_UNAVAILABLE: "Ask Moji can't read the course materials right now. Please try again later.",
  NO_API_KEY: "Ask Moji isn't available in this class.",
  PACE: 'One message at a time, please. Send it again in a moment.',
  CLASSROOM_LOCKED: 'This class is in read-only mode. The owner has locked it.',
  CLASSROOM_UNPUBLISHED: 'This class has been unpublished by the owner.',
  NOT_A_MEMBER: "Ask Moji isn't available in this class.",
  NOT_FOUND: 'This conversation has ended. Start a new one to keep asking.',
  INVALID_MESSAGE: 'Could not send your message. Please try again.',
  NOT_ALLOWED: "This conversation can't continue. Start a new one to keep asking.",
  /** A turn is in flight elsewhere (another tab or device); the widget joins it. */
  BUSY_ELSEWHERE: 'Ask Moji is answering in another window.',
} as const;

export type AskMojiCopyCode = keyof typeof ASK_MOJI_COPY;

/** Every code above, the `data-notice` part's allow-list. */
export const ASK_MOJI_COPY_CODES = Object.keys(ASK_MOJI_COPY) as [
  AskMojiCopyCode,
  ...AskMojiCopyCode[],
];

/** The line for a code; an unknown code gets the generic error line. */
export const askMojiCopyFor = (code: string): string =>
  Object.prototype.hasOwnProperty.call(ASK_MOJI_COPY, code)
    ? ASK_MOJI_COPY[code as AskMojiCopyCode]
    : ASK_MOJI_COPY.ERROR;

/** Every line above, each once: the only error text the widget shows. */
export const ASK_MOJI_ERROR_COPY: readonly string[] = [...new Set(Object.values(ASK_MOJI_COPY))];

/** Whether a text is one of the fixed lines (the widget's check before it shows an error). */
export const isAskMojiErrorCopy = (text: unknown): text is string =>
  typeof text === 'string' && ASK_MOJI_ERROR_COPY.includes(text);

/** Shown while the session starts (the widget's opening state). */
export const ASK_MOJI_STARTING = 'Reading the course materials…';

/**
 * Why Ask Moji is not available in a classroom, by code (askMojiSession's
 * `askMojiAvailable`). Staff see the line on the AI settings page; members
 * see `ASK_MOJI_COPY.UNAVAILABLE` whatever the reason.
 */
export const ASK_MOJI_AVAILABILITY_COPY = {
  RUNTIME_OFF: "Ask Moji isn't switched on for this server yet.",
  TRIGGER_NOT_CONFIGURED: "Ask Moji isn't set up on this server.",
  NO_API_KEY: 'Ask Moji needs an Anthropic API key: add one in AI settings.',
  PRO_REQUIRED: 'Ask Moji needs a Pro subscription.',
  NOT_ENABLED: 'Ask Moji is switched off for this class.',
} as const;

export type AskMojiAvailabilityCode = keyof typeof ASK_MOJI_AVAILABILITY_COPY;
