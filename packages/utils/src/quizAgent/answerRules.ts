/**
 * A quiz's answer rules: what a hint costs and how many answers a student
 * gives to one question. Numbers and fixed copy only; read by the quiz form
 * and its action, the quiz service, the grading service, the chat and the
 * MCP quiz tools.
 *
 * A quiz sets both (`Quiz.hint_cost`, `Quiz.max_answers`); an attempt pins
 * them at its first admission (`agent_config.hintCost` / `maxAnswers`, next to
 * `questionCount`), so an edit to the quiz mid-attempt does not change them.
 * An attempt pinned before the rules existed (`questionCount` pinned, no
 * `hintCost`) keeps the old behaviour: hints cost `HINT_COST` and the answer
 * limit is the prompt's alone (`maxAnswers: null`, no server limit).
 */
import { HINT_COST } from './grading.ts';

/** Points taken off each answer given after a hint: the form's and the MCP's range. */
export const HINT_COST_MIN = 0;
export const HINT_COST_MAX = 50;

/** Answers a student may give to one question: the form's and the MCP's range. */
export const MAX_ANSWERS_MIN = 1;
export const MAX_ANSWERS_MAX = 20;

/** A new quiz's answers per question (the column default). */
export const DEFAULT_MAX_ANSWERS = 5;

/**
 * The answer limit the prompt states for an attempt with no server limit (one
 * pinned before the rules existed): the five answers it always stated.
 */
export const LEGACY_PROMPT_MAX_ANSWERS = 5;

/** What an attempt (or a quiz not yet started) works under. */
export type AnswerRules = {
  /** Points off each answer given after a hint. */
  hintCost: number;
  /** Answers per question the server allows; null = no server limit (legacy). */
  maxAnswers: number | null;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** A quiz's own rules, from its columns (defaults for a value that is not one). */
export const quizAnswerRules = (
  quiz: { hint_cost?: unknown; max_answers?: unknown } | null | undefined
): { hintCost: number; maxAnswers: number } => {
  const hintCost = quiz?.hint_cost;
  const maxAnswers = quiz?.max_answers;
  return {
    hintCost: inRange(hintCost, HINT_COST_MIN, HINT_COST_MAX) ? hintCost : HINT_COST,
    maxAnswers: inRange(maxAnswers, MAX_ANSWERS_MIN, MAX_ANSWERS_MAX)
      ? maxAnswers
      : DEFAULT_MAX_ANSWERS,
  };
};

/**
 * The rules an attempt works under, the one reading for every surface:
 * - pinned with `hintCost` (its first admission came after the rules
 *   existed): the pinned values;
 * - pinned (`questionCount`) without them: a legacy attempt, cost
 *   `HINT_COST` and no server limit;
 * - not pinned yet (no admission so far): the quiz's own values, which the
 *   first admission is about to pin.
 */
export const attemptAnswerRules = (
  agentConfig: unknown,
  quiz: { hint_cost?: unknown; max_answers?: unknown } | null | undefined
): AnswerRules => {
  const config = isObject(agentConfig) ? agentConfig : {};
  const pinnedCount = config.questionCount;
  const started =
    typeof pinnedCount === 'number' && Number.isInteger(pinnedCount) && pinnedCount > 0;
  const hintCost = config.hintCost;
  const maxAnswers = config.maxAnswers;
  if (inRange(hintCost, HINT_COST_MIN, HINT_COST_MAX)) {
    return {
      hintCost,
      maxAnswers: inRange(maxAnswers, MAX_ANSWERS_MIN, MAX_ANSWERS_MAX) ? maxAnswers : null,
    };
  }
  if (started) return { hintCost: HINT_COST, maxAnswers: null };
  return quizAnswerRules(quiz);
};

/**
 * A submitted value checked against its range: an integer within it, from a
 * number or a numeric string (the form posts JSON numbers; older clients
 * strings). Anything else is refused with a message for the person saving.
 */
const checkRange = (
  value: unknown,
  min: number,
  max: number,
  label: string
): { ok: true; value: number } | { ok: false; error: string } => {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    return { ok: false, error: `${label} must be a whole number from ${min} to ${max}.` };
  }
  return { ok: true, value: n };
};

export const checkHintCost = (value: unknown) =>
  checkRange(value, HINT_COST_MIN, HINT_COST_MAX, 'Hint cost');

export const checkMaxAnswers = (value: unknown) =>
  checkRange(value, MAX_ANSWERS_MIN, MAX_ANSWERS_MAX, 'Answers per question');

// ─── Copy (fixed text, filled from data) ────────────────────────────────────

/** The quiz's rules, one line, shown to a student as the attempt starts. */
export const answerRulesLine = (rules: AnswerRules): string => {
  const answers =
    rules.maxAnswers === null
      ? ''
      : rules.maxAnswers === 1
        ? 'One answer per question.'
        : `Up to ${rules.maxAnswers} answers per question.`;
  const hints =
    rules.hintCost === 0
      ? 'Hints are free.'
      : `Each hint costs ${rules.hintCost} points on that question.`;
  return answers ? `${answers} ${hints}` : hints;
};

/** The hint button's tooltip. */
export const hintCostTooltip = (hintCost: number): string =>
  hintCost === 0
    ? 'Hints are free on this quiz.'
    : `This hint costs ${hintCost} points on this question.`;

/** The answer counter beside the composer, by state. */
export const ANSWER_COUNTER_COPY = {
  answer: (k: number, n: number) => `Answer ${k} of ${n}`,
  last: (n: number) => `Answer ${n} of ${n} · last`,
  none: 'No answers left',
} as const;

/** The composer's placeholder while a question is open. */
export const ANSWER_PLACEHOLDER = {
  open: 'Type your answer…',
  last: 'Your last answer for this question…',
} as const;
