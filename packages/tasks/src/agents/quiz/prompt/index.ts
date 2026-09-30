import { baseSystemPrompt } from './base.ts';
import { codeAwareAgentPrompt } from './codeAware.ts';
import { buildMaterialPrompt, type MaterialDoc } from './material.ts';

export { baseSystemPrompt } from './base.ts';
export { codeAwareAgentPrompt } from './codeAware.ts';
export { buildMaterialPrompt, usableMaterial, type MaterialDoc } from './material.ts';

const RULE = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

export type QuizPromptInput = {
  /** The instructor's override, carried through byte-exact. */
  quizSystemPrompt: string | null;
  /** The grading rubric, carried through byte-exact. */
  rubricPrompt: string | null;
  questionCount: number;
  subject: string | null;
  difficultyLevel: string | null;
  isCodeAware: boolean;
  /** Student-visible linked documents, in material order. */
  sourceMaterial: MaterialDoc[] | null;
  /** `org/slug`, the classroom the content tools would be confined to. */
  classroomRef: string | null;
  /** Whole-course search; only meaningful with content tools. */
  courseSearchEnabled?: boolean;
  /** Content tools registered for this run. Off tonight: the prompt names none. */
  contentToolsAvailable?: boolean;
};

/**
 * A quiz's instructions, split at the cache boundary into the two system
 * blocks the loop sends (each with its own cache breakpoint).
 *
 *   staticPrompt  - the fleet-wide instructions, byte-identical for every quiz
 *                   of the same mode, plus this quiz's SOURCE MATERIAL block
 *                   when it has one: one cache entry per quiz.
 *   dynamicPrompt - QUIZ PARAMETERS, the instructor's override, the rubric.
 *                   Fixed for the attempt's life; nothing per turn.
 *
 * The instructions never interpolate the subject or the question count: they
 * name the values by reference to QUIZ PARAMETERS, so the fleet-wide text
 * stays one cache entry. The override and the rubric are never edited.
 */
export function buildQuizPrompt({
  quizSystemPrompt = null,
  rubricPrompt = null,
  questionCount,
  subject = null,
  difficultyLevel = null,
  isCodeAware = false,
  sourceMaterial = null,
  classroomRef = null,
  courseSearchEnabled = false,
  contentToolsAvailable = false,
}: QuizPromptInput): { staticPrompt: string; dynamicPrompt: string } {
  const fleetStatic = isCodeAware
    ? `${baseSystemPrompt}\n\n${codeAwareAgentPrompt}`
    : baseSystemPrompt;

  const materialPrompt = buildMaterialPrompt({
    sourceMaterial,
    classroomRef,
    courseSearchEnabled,
    contentToolsAvailable,
    isCodeAware,
  });
  const staticPrompt = materialPrompt ? `${fleetStatic}\n\n${materialPrompt}` : fleetStatic;

  let dynamicPrompt = `${RULE}
QUIZ PARAMETERS
SUBJECT: ${subject || '[Subject not specified]'}
NUM_QUESTIONS: ${questionCount}
DIFFICULTY_LEVEL: ${difficultyLevel || 'Intermediate'}
${RULE}`;

  if (quizSystemPrompt) {
    dynamicPrompt += `\n\n${quizSystemPrompt}`;
  }

  if (rubricPrompt) {
    dynamicPrompt += `\n\n${RULE}
GRADING RUBRIC:
${rubricPrompt}

Use this rubric to guide your ${isCodeAware ? 'exploration and ' : ''}questioning.
${RULE}`;
  }

  return { staticPrompt, dynamicPrompt };
}

/**
 * The user-role notice for a turn of a code-aware quiz whose repository was
 * not found for this attempt: the turn runs the standard instructions, with no
 * explore_codebase, so the model is told to leave the student's code out.
 * Fixed text, never persisted and never shown.
 */
export const CODE_UNAVAILABLE_NOTICE =
  "SYSTEM NOTICE (not from the student; do not mention it): this quiz is meant to be about the student's own code, " +
  'but their code is not available for this reply. Ask about the quiz topic and the rubric concepts directly, ' +
  "with no code_snippet, and do not quote, describe or guess at the student's code. " +
  'Never mention the repository, access or any problem to the student.';

/** What the notice needs of the attempt's progress (`AttemptProgress` fits). */
export type EvaluationNoticeProgress = {
  questionCount: number;
  presented: number;
  finalized: readonly number[];
};

/**
 * The user-role notice for a recovery call (design §4.2, Q17): the turn ended
 * without an evaluation although the student has moved on from the last
 * question, or every question is recorded. Today's SYSTEM NOTICE, rewritten
 * for the typed tools, with the presented questions that still lack a result
 * named from the stored progress. Never persisted and never shown.
 */
export function evaluationNotice(p: EvaluationNoticeProgress): string {
  const finalized = new Set(p.finalized);
  const presented = Math.min(Math.max(p.presented, 0), p.questionCount);
  const missing: number[] = [];
  for (let n = 1; n <= presented; n++) if (!finalized.has(n)) missing.push(n);

  const recordLine =
    missing.length > 0
      ? `These presented questions have no recorded result yet: ${missing.join(', ')}. ` +
        'Call record_question_result for each of them FIRST, rating every real answer the ' +
        'student gave with its level and the hints before it (an empty answers list if the ' +
        'student gave none). '
      : 'Every presented question has a recorded result. ';

  return (
    'SYSTEM NOTICE (not from the student; do not mention it): your previous response did NOT ' +
    'include a successful submit_quiz_evaluation tool call. Do NOT apologize. Do NOT write the ' +
    'evaluation as plain text. Follow rule 6 of the transition rules. ' +
    recordLine +
    'Then call submit_quiz_evaluation with all required fields: final_acknowledgment, ' +
    'quiz_complete=true, evaluation, numeric_score, feedback_summary, feedback_strengths ' +
    '(array), feedback_improvements (array), feedback_recommendation, feedback_effort_note.'
  );
}
