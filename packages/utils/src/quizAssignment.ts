/**
 * The rules for a quiz and its assignment, shared by the web actions, the MCP
 * tools and the services.
 *
 * A quiz's place in the course lives on its QUIZ Assignment: module, opens
 * (`release_at`), due, closes, weight, tokens per hour and published. Who may
 * write them:
 *
 *   - OWNER and TEACHER create, publish, weight, schedule and delete quizzes
 *     (`QUIZ_AUTHOR_ROLES`), and set how many questions it asks, how many
 *     attempts it allows and which attempt counts (`QUIZ_AUTHOR_SETTING_KEYS`).
 *   - ASSISTANT edits a quiz's content (rubric, prompts, source material, the
 *     code-context settings and excluded paths) and its name, and nothing on
 *     the assignment (`QUIZ_EDITOR_ROLES` minus the authors). A save from an
 *     assistant that carries any assignment field or author setting is
 *     refused whole.
 */

import { isClosed } from './assignmentVisibility.ts';

export const QUIZ_AUTHOR_ROLES = ['OWNER', 'TEACHER'] as const;
export const QUIZ_EDITOR_ROLES = ['OWNER', 'TEACHER', 'ASSISTANT'] as const;

export type QuizRole = string;

/** Whether a role may create, publish, schedule, weight or delete a quiz. */
export const canAuthorQuiz = (role: QuizRole | null | undefined): boolean =>
  !!role && (QUIZ_AUTHOR_ROLES as readonly string[]).includes(role);

/**
 * The keys of a quiz save that write its assignment: the nested `assignment`
 * object, and the old flat fields that are routed to it (`dueDate`,
 * `weight`, `status`) or name one of its columns.
 */
export const QUIZ_ASSIGNMENT_INPUT_KEYS = [
  'assignment',
  'moduleId',
  'releaseAt',
  'dueDate',
  'closesAt',
  'weight',
  'tokensPerHour',
  'isPublished',
  'status',
] as const;

/** The assignment keys a quiz save carries (present and not undefined). */
export const quizAssignmentKeysIn = (input: Record<string, unknown>): string[] =>
  QUIZ_ASSIGNMENT_INPUT_KEYS.filter(key => key in input && input[key] !== undefined);

/**
 * The keys of a quiz save that only an author may change, beyond the
 * assignment: how many questions the quiz asks, how many attempts it allows,
 * and which attempt counts.
 */
export const QUIZ_AUTHOR_SETTING_KEYS = [
  'questionCount',
  'maxAttempts',
  'gradingStrategy',
] as const;

/** The author-only setting keys a quiz save carries (present and not undefined). */
export const quizAuthorSettingKeysIn = (input: Record<string, unknown>): string[] =>
  QUIZ_AUTHOR_SETTING_KEYS.filter(key => key in input && input[key] !== undefined);

/**
 * The `Quiz.status` an assignment implies at `now`, written as a mirror so a
 * reader that still looks at the quiz agrees with the assignment: DRAFT while
 * unpublished, CLOSED once the close date has passed, PUBLISHED otherwise.
 */
export const mirroredQuizStatus = (
  assignment: { is_published: boolean; closes_at?: Date | string | null },
  now: Date | number
): 'DRAFT' | 'PUBLISHED' | 'CLOSED' => {
  if (!assignment.is_published) return 'DRAFT';
  return isClosed(assignment.closes_at, now) ? 'CLOSED' : 'PUBLISHED';
};

/** `Quiz.weight` is an integer; the assignment's weight is mirrored rounded. */
export const mirroredQuizWeight = (weight: number): number => Math.round(weight);

/**
 * The assignment fields a TEACHER may change on an existing assignment, by
 * its type. Everything else is the class owner's. On a QUIZ the teacher has
 * the whole schedule and the weight (they author quizzes); on REPO and FORM
 * rows the set is what it has always been.
 */
export const TEACHER_ASSIGNMENT_FIELDS: Record<'REPO' | 'QUIZ' | 'FORM', readonly string[]> = {
  REPO: ['grades_released', 'student_deadline'],
  QUIZ: ['student_deadline', 'weight', 'release_at', 'closes_at', 'tokens_per_hour', 'is_published'],
  FORM: ['grades_released', 'student_deadline'],
};

/** The fields of `fields` a TEACHER may not change on an assignment of `type`. */
export const ownerOnlyAssignmentFields = (type: string, fields: readonly string[]): string[] => {
  const allowed = TEACHER_ASSIGNMENT_FIELDS[type as keyof typeof TEACHER_ASSIGNMENT_FIELDS] ?? [];
  return fields.filter(field => !allowed.includes(field));
};
