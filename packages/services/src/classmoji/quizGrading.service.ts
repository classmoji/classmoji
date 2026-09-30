/**
 * Grading for quiz attempts served as chat agents (`agent_runtime: 'trigger_chat'`).
 *
 * Every write here is one transaction that:
 *   1. locks the attempt row (`SELECT … FOR UPDATE`), so tool calls from a
 *      retried or superseded run serialize with the live one;
 *   2. returns the stored output when the operation id (the tool call id) is
 *      already in the journal, so an exact re-delivery writes nothing;
 *   3. checks the turn fence set at admission, so a superseded run cannot write;
 *   4. appends one `quiz_attempt_events` row next to the domain change it records.
 *
 * The model never supplies a score. `finalizeQuestion` derives the credit from
 * the answer levels and hint counts (`deriveResult`), and the emoji from the
 * classroom's own mapping. `question_results_json` stays the projection the
 * existing readers use; it carries the legacy keys (`attempts`,
 * `eventually_correct`, `credit_earned`, `emoji`, `recorded_at`) plus the new
 * ones. The per-answer breakdown stays in the journal only.
 *
 * Error messages go back to the model as the tool's error, so each one says
 * what would be accepted.
 */

import { randomUUID } from 'node:crypto';
import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';
import { DEFAULT_EMOJI_GRADE_MAPPINGS, gradeToEmoji } from '@classmoji/utils';
import {
  QuizEvaluationFeedbackSchema,
  QuizEvaluationRecordV2Schema,
  QuestionCardSchema,
  RecordQuestionResultSchema,
  computeAttemptPercentages,
  deriveResult,
  gradeBandFor,
  scoreSoFar,
  type Answer,
  type AttemptProgress,
  type PresentQuestionOutput,
  type QuestionResultOutput,
  type QuizEvaluationFeedback,
  type QuizEvaluationRecordV2,
  type QuestionCard,
  type RecordQuestionResult,
  type StoredQuestionResult,
} from '@classmoji/utils/quiz-agent';
import { resolveAttemptQuestionCount } from './quizAttempt.service.ts';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Identifies one tool write: the attempt, the turn it belongs to, the call. */
export type Fenced = {
  attemptId: string;
  /** The `turn_fence` admission handed this run. */
  fence: string;
  /** The tool call id: the operation id a re-delivery is recognized by. */
  toolCallId: string;
  /** The admitted student message this turn answers; null for the begin action. */
  inputMessageId: string | null;
  runId: string;
};

export type { PresentQuestionOutput, QuestionResultOutput, StoredQuestionResult };

export type QuizGradingErrorCode =
  | 'attempt_not_found'
  | 'wrong_runtime'
  | 'stale_turn'
  | 'attempt_complete'
  | 'out_of_order'
  | 'invalid_input'
  | 'revision_refused'
  | 'already_recorded'
  | 'incomplete'
  | 'end_not_confirmed'
  | 'open_question_unrecorded'
  | 'operation_conflict';

/** A refused grading write. `message` is written for the model. */
export class QuizGradingError extends Error {
  readonly code: QuizGradingErrorCode;
  constructor(code: QuizGradingErrorCode, message: string) {
    super(message);
    this.name = 'QuizGradingError';
    this.code = code;
  }
}

export const isQuizGradingError = (error: unknown): error is QuizGradingError =>
  error instanceof QuizGradingError ||
  (error instanceof Error && error.name === 'QuizGradingError' && 'code' in error);

// ─── Constants ──────────────────────────────────────────────────────────────

export const TRIGGER_CHAT_RUNTIME = 'trigger_chat';

/**
 * Q16, decided: a question's result is final once it is recorded (the student
 * moved on). A later record for it that differs from the stored one is
 * refused (`revision_refused`). Results written while this was on can still
 * carry `revised: true` and a `result_revised` journal row; they are read and
 * shown as stored.
 */
export const RESULT_REVISIONS_ALLOWED = false;

/** Operation id of the server completion (Q17). One completion per attempt. */
export const SERVER_COMPLETION_OPERATION_ID = 'completion:server';

/** Prisma's 5 s default is tight when another run holds the row lock. */
export const LOCKED_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

export type QuizAttemptEventType =
  | 'input_admitted'
  | 'question_presented'
  | 'result_finalized'
  | 'result_revised'
  | 'evaluation_completed'
  | 'exploration_completed'
  | 'turn_refused';

// ─── Shared transaction helpers (also used by quizChat.service) ─────────────

export type Tx = Prisma.TransactionClient;

const LOCKED_ATTEMPT_SELECT = {
  id: true,
  user_id: true,
  quiz_id: true,
  conversation_id: true,
  agent_runtime: true,
  contract_version: true,
  completed_at: true,
  session_expires_at: true,
  questions_asked: true,
  question_results_json: true,
  agent_config: true,
  turn_fence: true,
  evaluation_json: true,
  chat_grant: true,
  quiz: {
    select: {
      classroom_id: true,
      question_count: true,
      status: true,
      classroom: { select: { status: true } },
    },
  },
} satisfies Prisma.QuizAttemptSelect;

export type LockedAttempt = Prisma.QuizAttemptGetPayload<{ select: typeof LOCKED_ATTEMPT_SELECT }>;

/**
 * Lock the attempt row, then read it. The lock is the first statement so every
 * field read after it is the committed value no other writer can change until
 * this transaction ends. Null when the attempt does not exist.
 */
export const lockAttempt = async (tx: Tx, attemptId: string): Promise<LockedAttempt | null> => {
  const locked = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM quiz_attempts WHERE id = ${attemptId} FOR UPDATE`;
  if (locked.length === 0) return null;
  return tx.quizAttempt.findUnique({ where: { id: attemptId }, select: LOCKED_ATTEMPT_SELECT });
};

/** How many questions the attempt asks (the count pinned at first admission, else the quiz's). */
export const attemptQuestionCount = (attempt: Pick<LockedAttempt, 'agent_config' | 'quiz'>) =>
  resolveAttemptQuestionCount(attempt.agent_config, attempt.quiz?.question_count);

export const findEvent = (tx: Tx, attemptId: string, operationId: string) =>
  tx.quizAttemptEvent.findUnique({
    where: { attempt_id_operation_id: { attempt_id: attemptId, operation_id: operationId } },
  });

/**
 * Append one journal row. Callers hold the attempt row lock, which is what
 * makes `MAX(seq) + 1` safe against the `(attempt_id, seq)` unique index.
 */
export const appendEvent = async (
  tx: Tx,
  attempt: Pick<LockedAttempt, 'id' | 'contract_version' | 'user_id'>,
  event: {
    type: QuizAttemptEventType;
    operationId: string;
    toolCallId?: string | null;
    fence?: string | null;
    inputMessageId?: string | null;
    runId?: string | null;
    payload: Prisma.InputJsonValue;
  }
) => {
  const [{ next }] = await tx.$queryRaw<{ next: number | bigint }[]>`
    SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM quiz_attempt_events WHERE attempt_id = ${attempt.id}`;
  return tx.quizAttemptEvent.create({
    data: {
      attempt_id: attempt.id,
      seq: Number(next),
      type: event.type,
      operation_id: event.operationId,
      tool_call_id: event.toolCallId ?? null,
      turn_fence: event.fence ?? null,
      input_message_id: event.inputMessageId ?? null,
      run_id: event.runId ?? null,
      contract_version: attempt.contract_version,
      payload: event.payload,
      actor_user_id: attempt.user_id,
    },
  });
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** JSON round trip: drops `undefined` so the value is storable as Json. */
export const toJson = <T>(value: T): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const storedOutput = <T>(event: { payload: Prisma.JsonValue }): T =>
  (isObject(event.payload) ? event.payload.output : undefined) as T;

const describeIssues = (error: {
  issues: { path: (string | number)[]; message: string }[];
}): string =>
  error.issues
    .map(issue => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');

/**
 * Parse the entries this service writes into `question_results_json`. Entries
 * missing a field are dropped. Only questions 1..`questionCount` are returned,
 * in order, one per number.
 */
export const readStoredResults = (json: unknown, questionCount: number): StoredQuestionResult[] => {
  const byNumber = new Map<number, StoredQuestionResult>();
  for (const entry of Array.isArray(json) ? json : []) {
    if (!isObject(entry)) continue;
    const n = entry.question_num;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > questionCount) continue;
    if (
      typeof entry.attempts !== 'number' ||
      typeof entry.eventually_correct !== 'boolean' ||
      typeof entry.credit_earned !== 'number' ||
      typeof entry.emoji !== 'string' ||
      typeof entry.recorded_at !== 'string'
    ) {
      continue;
    }
    byNumber.set(n, {
      question_num: n,
      attempts: entry.attempts,
      tries: typeof entry.tries === 'number' ? entry.tries : entry.attempts,
      eventually_correct: entry.eventually_correct,
      first_attempt_correct:
        typeof entry.first_attempt_correct === 'boolean'
          ? entry.first_attempt_correct
          : entry.attempts === 1 && entry.eventually_correct,
      credit_earned: entry.credit_earned,
      emoji: entry.emoji,
      brief_feedback: typeof entry.brief_feedback === 'string' ? entry.brief_feedback : '',
      ...(entry.revised === true ? { revised: true as const } : {}),
      ...(entry.skipped_by_end === true ? { skipped_by_end: true as const } : {}),
      recorded_at: entry.recorded_at,
    });
  }
  return [...byNumber.values()].sort((a, b) => a.question_num - b.question_num);
};

/** The latest admitted student action (`next` / `try_again`), from the journal. */
const readLastAction = async (tx: Tx | ReturnType<typeof getPrisma>, attemptId: string) => {
  const latest = await tx.quizAttemptEvent.findFirst({
    where: { attempt_id: attemptId, type: 'input_admitted' },
    orderBy: { seq: 'desc' },
    select: { payload: true },
  });
  const action = isObject(latest?.payload) ? latest.payload.action : undefined;
  return action === 'next' || action === 'try_again' ? action : undefined;
};

/** The button (`next` / `try_again`) an admitted student message was, from its journal row. */
const admittedAction = async (tx: Tx, attemptId: string, inputMessageId: string | null) => {
  if (!inputMessageId) return undefined;
  const admitted = await findEvent(tx, attemptId, inputMessageId);
  if (admitted?.type !== 'input_admitted') return undefined;
  const action = isObject(admitted.payload) ? admitted.payload.action : undefined;
  return action === 'next' || action === 'try_again' ? action : undefined;
};

/** Progress of a locked (or freshly read) attempt. */
export const progressOf = async (
  tx: Tx | ReturnType<typeof getPrisma>,
  attempt: Pick<
    LockedAttempt,
    | 'id'
    | 'agent_config'
    | 'quiz'
    | 'questions_asked'
    | 'question_results_json'
    | 'completed_at'
    | 'evaluation_json'
  >
): Promise<AttemptProgress> => {
  const questionCount = attemptQuestionCount(attempt);
  const lastAction = await readLastAction(tx, attempt.id);
  const results = readStoredResults(attempt.question_results_json, questionCount);
  return {
    questionCount,
    presented: attempt.questions_asked ?? 0,
    finalized: results.map(r => r.question_num),
    score: scoreSoFar(results),
    completed: Boolean(attempt.completed_at),
    hasEvaluation: attempt.evaluation_json !== null && attempt.evaluation_json !== undefined,
    ...(lastAction ? { lastAction } : {}),
  };
};

const loadEmojiMappings = async (tx: Tx, classroomId: string) => {
  const mappings = await tx.emojiMapping.findMany({
    where: { classroom_id: classroomId },
    select: { emoji: true, grade: true },
  });
  if (mappings.length === 0) return { ...DEFAULT_EMOJI_GRADE_MAPPINGS };
  return Object.fromEntries(mappings.map(m => [m.emoji, m.grade])) as Record<string, number>;
};

// ─── Guards ─────────────────────────────────────────────────────────────────

const requireAttempt = (attempt: LockedAttempt | null): LockedAttempt => {
  if (!attempt)
    throw new QuizGradingError('attempt_not_found', 'This quiz attempt does not exist.');
  if (attempt.agent_runtime !== TRIGGER_CHAT_RUNTIME) {
    throw new QuizGradingError('wrong_runtime', 'This quiz attempt is not served by this runtime.');
  }
  return attempt;
};

const requireOpen = (attempt: LockedAttempt) => {
  if (attempt.completed_at) {
    throw new QuizGradingError(
      'attempt_complete',
      'This quiz attempt is already complete; nothing more can be recorded.'
    );
  }
};

const requireFence = (attempt: LockedAttempt, fence: string) => {
  if (!fence || attempt.turn_fence !== fence) {
    throw new QuizGradingError(
      'stale_turn',
      'This turn is no longer current; a newer turn has taken over the attempt.'
    );
  }
};

/**
 * Run `body` in one locked transaction. A journal row with `f.toolCallId` as
 * its operation id and one of `replayTypes` returns that row's stored output
 * before any other check; the same id under another type is refused.
 */
const inLockedTx = <T>(
  attemptId: string,
  toolCallId: string | undefined,
  replayTypes: QuizAttemptEventType[],
  body: (tx: Tx, attempt: LockedAttempt) => Promise<T>
): Promise<T> =>
  getPrisma().$transaction(async tx => {
    const attempt = requireAttempt(await lockAttempt(tx, attemptId));
    if (toolCallId) {
      const existing = await findEvent(tx, attempt.id, toolCallId);
      if (existing) {
        if (replayTypes.includes(existing.type as QuizAttemptEventType)) {
          return storedOutput<T>(existing);
        }
        throw new QuizGradingError(
          'operation_conflict',
          'This tool call id was already used for a different operation.'
        );
      }
    }
    return body(tx, attempt);
  }, LOCKED_TX_OPTIONS);

// ─── present_question ───────────────────────────────────────────────────────

/**
 * Accept question `n = presented + 1` once question `n - 1` has a result, with
 * `n <= questionCount`; `total_questions` is set to the attempt's count. A
 * re-run of the question already presented (`n = presented`) returns the
 * ORIGINAL stored question and writes nothing.
 *
 * `q` is the card as the tool built it: a code quote is already resolved into
 * `code_snippet` and `source`, which are stored with the rest of the card.
 */
export const presentQuestion = (f: Fenced, q: QuestionCard): Promise<PresentQuestionOutput> =>
  inLockedTx(f.attemptId, f.toolCallId, ['question_presented'], async (tx, attempt) => {
    requireOpen(attempt);
    requireFence(attempt, f.fence);

    const parsed = QuestionCardSchema.safeParse(q);
    if (!parsed.success) {
      throw new QuizGradingError(
        'invalid_input',
        `Invalid question: ${describeIssues(parsed.error)}`
      );
    }
    const question = parsed.data;
    const questionCount = attemptQuestionCount(attempt);
    const presented = attempt.questions_asked ?? 0;
    const n = question.question_number;

    if (n === presented && n >= 1) {
      const original = await tx.quizAttemptEvent.findFirst({
        where: {
          attempt_id: attempt.id,
          type: 'question_presented',
          payload: { path: ['question_number'], equals: n },
        },
        orderBy: { seq: 'desc' },
      });
      if (original) return storedOutput<PresentQuestionOutput>(original);
    }

    if (presented >= questionCount) {
      throw new QuizGradingError(
        'out_of_order',
        `All ${questionCount} questions have been presented. Record the last result once the student moves on from it, then submit the evaluation.`
      );
    }
    if (n !== presented + 1) {
      throw new QuizGradingError(
        'out_of_order',
        `question_number must be ${presented + 1}: the next question to present is question ${presented + 1} of ${questionCount}.`
      );
    }
    const finalized = new Set(
      readStoredResults(attempt.question_results_json, questionCount).map(r => r.question_num)
    );
    if (n > 1 && !finalized.has(n - 1)) {
      throw new QuizGradingError(
        'out_of_order',
        `Record the result for question ${n - 1} with record_question_result before presenting question ${n}.`
      );
    }

    const card: QuestionCard = { ...question, question_number: n, total_questions: questionCount };
    const output: PresentQuestionOutput = {
      card,
      question_number: n,
      total_questions: questionCount,
    };
    await appendEvent(tx, attempt, {
      type: 'question_presented',
      operationId: f.toolCallId,
      toolCallId: f.toolCallId,
      fence: f.fence,
      inputMessageId: f.inputMessageId,
      runId: f.runId,
      payload: toJson({ question_number: n, output }),
    });
    await tx.quizAttempt.update({
      where: { id: attempt.id },
      data: { questions_asked: n, last_activity: new Date() },
    });
    return output;
  });

// ─── record_question_result ─────────────────────────────────────────────────

const sameAnswers = (a: unknown, b: Answer[]) =>
  Array.isArray(a) &&
  a.length === b.length &&
  a.every((x, i) => isObject(x) && x.level === b[i].level && x.hints_before === b[i].hints_before);

/**
 * The answers with each `hints_before` raised, where it is lower, to the Try
 * again clicks admitted before that answer. The model counts the hints; the
 * server knows the clicks, and a typed hint request can only add to them.
 *
 * Question n's messages are the ones admitted after its card went out and
 * before question n+1's card. A typed message (no button) can carry an
 * answer; answers are taken one per typed message, in order, so the k-th
 * answer came no earlier than the k-th typed message and the clicks before
 * that message are its floor. An answer past the last typed message takes the
 * last message's floor, so a click after the final answer (a hint, then Next)
 * counts for none of them. Floors never decrease, so the answers keep
 * `hints_before` non-decreasing.
 */
const floorHintsAtTryAgain = async (
  tx: Tx,
  attemptId: string,
  questionNum: number,
  answers: Answer[]
): Promise<Answer[]> => {
  if (answers.length === 0) return answers;
  const cards = await tx.quizAttemptEvent.findMany({
    where: { attempt_id: attemptId, type: 'question_presented' },
    select: { seq: true, payload: true },
  });
  const cardSeq = (n: number) =>
    cards.find(c => isObject(c.payload) && c.payload.question_number === n)?.seq;
  const from = cardSeq(questionNum);
  if (from === undefined) return answers;
  const to = cardSeq(questionNum + 1);
  const inputs = await tx.quizAttemptEvent.findMany({
    where: {
      attempt_id: attemptId,
      type: 'input_admitted',
      seq: { gt: from, ...(to !== undefined ? { lt: to } : {}) },
    },
    orderBy: { seq: 'asc' },
    select: { payload: true },
  });
  let clicks = 0;
  const floors: number[] = [];
  for (const { payload } of inputs) {
    const p = isObject(payload) ? payload : {};
    if (p.action === 'try_again') clicks += 1;
    else if (p.kind === 'message' && p.action === undefined) floors.push(clicks);
  }
  if (floors.length === 0) return answers;
  return answers.map((a, k) => {
    const floor = floors[Math.min(k, floors.length - 1)];
    return a.hints_before >= floor ? a : { ...a, hints_before: floor };
  });
};

/**
 * Write `entries` into the attempt's `question_results_json` in one update,
 * each in place of any stored entry for its question, in question order.
 * Returns the array written.
 */
const writeProjection = async (
  tx: Tx,
  attempt: LockedAttempt,
  questionCount: number,
  entries: StoredQuestionResult[]
): Promise<Prisma.InputJsonArray> => {
  const numbers = new Set(entries.map(e => e.question_num));
  const others = (
    Array.isArray(attempt.question_results_json) ? attempt.question_results_json : []
  ).filter(
    e => !(isObject(e) && typeof e.question_num === 'number' && numbers.has(e.question_num))
  );
  const numberOf = (e: unknown) =>
    isObject(e) && typeof e.question_num === 'number' ? e.question_num : questionCount + 1;
  const next = [...others, ...entries.map(toJson)].sort(
    (x, y) => numberOf(x) - numberOf(y)
  ) as Prisma.InputJsonArray;
  await tx.quizAttempt.update({
    where: { id: attempt.id },
    data: { question_results_json: next, last_activity: new Date() },
  });
  return next;
};

/**
 * Finalize a presented question from the answers the model rated. The server
 * scores it (`deriveResult`) and picks the emoji from the classroom mapping.
 * Each answer's hint count is first raised to the Try again clicks admitted
 * before it (`floorHintsAtTryAgain`); the journal keeps what the model sent
 * as `reported_answers` when that changed anything.
 *
 * - First record → `result_finalized`.
 * - The same answers again, in any turn (a retried call) → the stored result.
 * - Different answers in the run of the turn that wrote the result (same
 *   input message and turn fence) → refused (`already_recorded`): the stored
 *   result stands, and the model is told so rather than handed it back as if
 *   its own call had been kept.
 * - Different answers in a re-run of that turn (a redelivered message: same
 *   input message, new fence) → the stored result; the earlier run's stands.
 * - Different answers in a later turn → refused (`revision_refused`): the
 *   result is final (`RESULT_REVISIONS_ALLOWED`).
 */
export const finalizeQuestion = (
  f: Fenced,
  r: RecordQuestionResult
): Promise<QuestionResultOutput> =>
  inLockedTx(
    f.attemptId,
    f.toolCallId,
    ['result_finalized', 'result_revised'],
    async (tx, attempt) => {
      requireOpen(attempt);
      requireFence(attempt, f.fence);

      const parsed = RecordQuestionResultSchema.safeParse(r);
      if (!parsed.success) {
        throw new QuizGradingError(
          'invalid_input',
          `Invalid question result: ${describeIssues(parsed.error)}`
        );
      }
      const { question_num, brief_feedback } = parsed.data;
      const questionCount = attemptQuestionCount(attempt);
      const presented = attempt.questions_asked ?? 0;

      if (question_num > questionCount) {
        throw new QuizGradingError(
          'invalid_input',
          `question_num must be from 1 to ${questionCount} for this quiz (received ${question_num}).`
        );
      }
      if (question_num > presented) {
        throw new QuizGradingError(
          'out_of_order',
          `Question ${question_num} has not been presented yet (the latest presented is ${presented}). ` +
            'Present it with present_question and record its result after the student has answered it.'
        );
      }

      // Floored before any comparison, so a re-sent call with the same
      // counts matches the result stored from it.
      const answers = await floorHintsAtTryAgain(tx, attempt.id, question_num, parsed.data.answers);
      const floored = !sameAnswers(parsed.data.answers, answers);

      const history = await tx.quizAttemptEvent.findMany({
        where: {
          attempt_id: attempt.id,
          type: { in: ['result_finalized', 'result_revised'] },
          payload: { path: ['question_num'], equals: question_num },
        },
        orderBy: { seq: 'asc' },
      });
      const latest = history.at(-1);

      if (latest) {
        const latestPayload = isObject(latest.payload) ? latest.payload : {};
        if (sameAnswers(latestPayload.answers, answers)) {
          return storedOutput<QuestionResultOutput>(latest);
        }
        const sameTurn = (latest.input_message_id ?? null) === (f.inputMessageId ?? null);
        if (sameTurn) {
          if ((latest.turn_fence ?? null) === f.fence) {
            throw new QuizGradingError(
              'already_recorded',
              `Question ${question_num} already has a result from this turn, and it stands. ` +
                'Do not record it again in this turn.'
            );
          }
          return storedOutput<QuestionResultOutput>(latest);
        }
        // A recorded result is final. With RESULT_REVISIONS_ALLOWED, a change
        // would follow something the student said about the question (never
        // the Next click alone), once.
        if (
          !RESULT_REVISIONS_ALLOWED ||
          (await admittedAction(tx, attempt.id, f.inputMessageId)) === 'next' ||
          history.some(e => e.type === 'result_revised')
        ) {
          throw new QuizGradingError(
            'revision_refused',
            `That question's result is final: question ${question_num} is already recorded and ` +
              'cannot change. Do not record it again.'
          );
        }
      }

      const derived = deriveResult(answers);
      const emoji = gradeToEmoji(
        derived.credit_earned,
        await loadEmojiMappings(tx, attempt.quiz.classroom_id)
      );
      const revised = Boolean(latest);
      const entry: StoredQuestionResult = {
        question_num,
        attempts: derived.tries,
        tries: derived.tries,
        eventually_correct: derived.eventually_correct,
        first_attempt_correct: derived.first_attempt_correct,
        credit_earned: derived.credit_earned,
        emoji,
        brief_feedback,
        ...(revised ? { revised: true as const } : {}),
        recorded_at: new Date().toISOString(),
      };
      const output: QuestionResultOutput = {
        question_num,
        emoji,
        brief_feedback,
        ...(revised ? { revised: true as const } : {}),
      };

      await writeProjection(tx, attempt, questionCount, [entry]);
      const previous = latest && isObject(latest.payload) ? latest.payload : null;
      await appendEvent(tx, attempt, {
        type: revised ? 'result_revised' : 'result_finalized',
        operationId: f.toolCallId,
        toolCallId: f.toolCallId,
        fence: f.fence,
        inputMessageId: f.inputMessageId,
        runId: f.runId,
        payload: toJson({
          question_num,
          answers,
          ...(floored ? { reported_answers: parsed.data.answers } : {}),
          ...derived,
          emoji,
          brief_feedback,
          ...(previous
            ? {
                previous: {
                  answers: previous.answers,
                  credit_earned: previous.credit_earned,
                  emoji: previous.emoji,
                  brief_feedback: previous.brief_feedback,
                },
              }
            : {}),
          output,
        }),
      });
      return output;
    }
  );

// ─── submit_quiz_evaluation / server completion ─────────────────────────────

type CompletionInput = { source: 'model'; feedback: QuizEvaluationFeedback } | { source: 'server' };

const readEvaluation = (json: Prisma.JsonValue): QuizEvaluationRecordV2 =>
  QuizEvaluationRecordV2Schema.parse(json);

/**
 * Complete the attempt once questions 1..questionCount all have results:
 * `evaluation_json`, both percentages, `completed_at` and `session_status` in
 * one update, with an `evaluation_completed` journal row. The scores come from
 * the stored results, never from the model. An attempt already completed
 * returns its stored evaluation.
 *
 * The model's `ended_early: true` (the student confirmed ending the quiz
 * early) first records every question without a result as skipped
 * (`fillSkippedByEnd`), in the same transaction, so the score is over every
 * question. It is refused in a turn with no student message of its own (a
 * button click, or the begin action): the confirmation is that message. It is
 * also refused (`open_question_unrecorded`) while the latest presented
 * question has no result, unless its card went out in this same turn: the
 * student may have answered it, so the model records it first rather than
 * the server scoring it 0. Only questions after it (and a card of this turn)
 * are filled.
 *
 * The evaluation band (`evaluation`, `numeric_score`) is the server's, from
 * the partial credit (`gradeBandFor`): on the record for either source, and in
 * the model's feedback in place of what the model sent. The model's
 * `final_acknowledgment` is kept in the feedback.
 *
 * `source: 'server'` (Q17) records no feedback text, so no acknowledgment;
 * `toolCallId` is then optional and the journal row uses a fixed operation id.
 */
export const completeWithEvaluation = (
  f: Omit<Fenced, 'toolCallId'> & { toolCallId?: string },
  o: CompletionInput
): Promise<QuizEvaluationRecordV2> =>
  inLockedTx(f.attemptId, f.toolCallId, ['evaluation_completed'], (tx, attempt) =>
    completeLocked(tx, attempt, f, o)
  );

/**
 * `completeWithEvaluation`'s body, for a caller that already holds the attempt
 * row lock in `tx`.
 */
export const completeLocked = async (
  tx: Tx,
  attempt: LockedAttempt,
  f: Omit<Fenced, 'toolCallId'> & { toolCallId?: string },
  o: CompletionInput
): Promise<QuizEvaluationRecordV2> => {
  if (attempt.completed_at) {
    if (attempt.evaluation_json !== null && attempt.evaluation_json !== undefined) {
      return readEvaluation(attempt.evaluation_json);
    }
    requireOpen(attempt);
  }
  requireFence(attempt, f.fence);

  const questionCount = attemptQuestionCount(attempt);
  let stored: unknown = attempt.question_results_json;
  const recorded = new Set(readStoredResults(stored, questionCount).map(r => r.question_num));
  const missing = Array.from({ length: questionCount }, (_, i) => i + 1).filter(
    n => !recorded.has(n)
  );
  const endedEarly = o.source === 'model' && o.feedback.ended_early === true;
  let skippedByEnd: number[] = [];
  if (missing.length > 0) {
    if (!endedEarly) {
      throw new QuizGradingError(
        'incomplete',
        `${missing.length > 1 ? 'Questions' : 'Question'} ${missing.join(', ')} ` +
          `${missing.length > 1 ? 'have' : 'has'} no result. Record each one you presented once the ` +
          'student has moved on from it; present any not yet presented. Then submit again. ' +
          '(If the student confirmed ending early, submit with ended_early instead.)'
      );
    }
    // The student's own message confirms an early end: never a button click.
    const action = await admittedAction(tx, attempt.id, f.inputMessageId);
    if (!f.inputMessageId || action) {
      throw new QuizGradingError(
        'end_not_confirmed',
        "An early end needs the student's own message confirming it, and " +
          (action
            ? 'this turn began with a button click. '
            : 'this turn has no student message. ') +
          'Leave ended_early out and carry on with the quiz.'
      );
    }
    // A presented question with no result may have been answered: the model
    // records it (answers [] if the student gave none) rather than the server
    // scoring it 0 for good. A card that went out in this same turn has no
    // answer yet, so it is filled like the unpresented ones.
    const presented = attempt.questions_asked ?? 0;
    const presentedThisTurn =
      presented >= 1 &&
      missing.includes(presented) &&
      (await tx.quizAttemptEvent.findFirst({
        where: {
          attempt_id: attempt.id,
          type: 'question_presented',
          input_message_id: f.inputMessageId,
          payload: { path: ['question_number'], equals: presented },
        },
        select: { id: true },
      })) !== null;
    const unrecorded = missing.filter(
      n => n <= presented && !(n === presented && presentedThisTurn)
    );
    if (unrecorded.length > 0) {
      throw new QuizGradingError(
        'open_question_unrecorded',
        `Record question ${unrecorded[0]} first (answers [] if the student gave none; student_asked_to_move_on: true), ` +
          'then submit again with ended_early.'
      );
    }
    stored = await fillSkippedByEnd(tx, attempt, f, questionCount, missing);
    skippedByEnd = missing;
  }
  const results = readStoredResults(stored, questionCount);

  const percentages = computeAttemptPercentages(results);
  // The band follows the score, for either source: the model's own choice of
  // evaluation and numeric_score is replaced.
  const band = gradeBandFor(percentages.partial_credit_percentage);

  let feedback: Omit<QuizEvaluationFeedback, 'quiz_complete' | 'ended_early'> | undefined;
  if (o.source === 'model') {
    const parsed = QuizEvaluationFeedbackSchema.safeParse(o.feedback);
    if (!parsed.success) {
      throw new QuizGradingError(
        'invalid_input',
        `Invalid evaluation: ${describeIssues(parsed.error)}`
      );
    }
    const { quiz_complete: _complete, ended_early: _endedEarly, ...rest } = parsed.data;
    feedback = { ...rest, ...band };
  }

  const record: QuizEvaluationRecordV2 = QuizEvaluationRecordV2Schema.parse({
    v: 2,
    source: o.source,
    ...(feedback ? { feedback } : {}),
    ...band,
    ...percentages,
    question_results: results.map(({ recorded_at: _at, ...rest }) => rest),
  });

  const now = new Date();
  await tx.quizAttempt.update({
    where: { id: attempt.id },
    data: {
      evaluation_json: toJson(record),
      partial_credit_percentage: percentages.partial_credit_percentage,
      first_attempt_percentage: percentages.first_attempt_percentage,
      completed_at: now,
      session_status: 'completed',
      last_activity: now,
    },
  });
  const operationId = f.toolCallId ?? SERVER_COMPLETION_OPERATION_ID;
  await appendEvent(tx, attempt, {
    type: 'evaluation_completed',
    operationId,
    toolCallId: f.toolCallId ?? null,
    fence: f.fence,
    inputMessageId: f.inputMessageId,
    runId: f.runId,
    payload: toJson({
      source: o.source,
      ...(skippedByEnd.length > 0 ? { ended_early: true, skipped_by_end: skippedByEnd } : {}),
      output: record,
    }),
  });
  return record;
};

/**
 * Record each of `missing` as skipped because the student ended the quiz
 * early: the result of a skip (`deriveResult([])`, the classroom's emoji for
 * it), no feedback line, and `skipped_by_end` on the entry and its
 * `result_finalized` journal row. The caller holds the row lock and completes
 * in the same transaction. Returns the results array written.
 */
const fillSkippedByEnd = async (
  tx: Tx,
  attempt: LockedAttempt,
  f: Omit<Fenced, 'toolCallId'> & { toolCallId?: string },
  questionCount: number,
  missing: number[]
): Promise<Prisma.InputJsonArray> => {
  const derived = deriveResult([]);
  const emoji = gradeToEmoji(
    derived.credit_earned,
    await loadEmojiMappings(tx, attempt.quiz.classroom_id)
  );
  const recordedAt = new Date().toISOString();
  const operation = f.toolCallId ?? SERVER_COMPLETION_OPERATION_ID;
  const entries: StoredQuestionResult[] = [];
  for (const n of missing) {
    const output: QuestionResultOutput = { question_num: n, emoji, brief_feedback: '' };
    entries.push({
      question_num: n,
      attempts: derived.tries,
      tries: derived.tries,
      eventually_correct: derived.eventually_correct,
      first_attempt_correct: derived.first_attempt_correct,
      credit_earned: derived.credit_earned,
      emoji,
      brief_feedback: '',
      skipped_by_end: true,
      recorded_at: recordedAt,
    });
    await appendEvent(tx, attempt, {
      type: 'result_finalized',
      operationId: `${operation}:skipped_by_end:${n}`,
      toolCallId: f.toolCallId ?? null,
      fence: f.fence,
      inputMessageId: f.inputMessageId,
      runId: f.runId,
      payload: toJson({
        question_num: n,
        answers: [],
        ...derived,
        emoji,
        brief_feedback: '',
        skipped_by_end: true,
        output,
      }),
    });
  }
  return writeProjection(tx, attempt, questionCount, entries);
};

// ─── explore_codebase history ───────────────────────────────────────────────

/**
 * Journal one finished exploration (`exploration_completed`): the files read
 * and the excerpts returned to the model, so later turns can build on them. A
 * completed attempt records nothing.
 */
export const recordExploration = (
  f: Fenced,
  e: { filesRead: string[]; excerpts: string }
): Promise<void> =>
  inLockedTx(f.attemptId, f.toolCallId, ['exploration_completed'], async (tx, attempt) => {
    if (attempt.completed_at) return;
    requireFence(attempt, f.fence);
    await appendEvent(tx, attempt, {
      type: 'exploration_completed',
      operationId: f.toolCallId,
      toolCallId: f.toolCallId,
      fence: f.fence,
      inputMessageId: f.inputMessageId,
      runId: f.runId,
      payload: toJson({ files_read: e.filesRead, excerpts: e.excerpts, output: null }),
    });
  }).then(() => undefined);

/** Every recorded exploration, oldest first: files read (unique, in order) and excerpts. */
export const listExplorations = async (
  attemptId: string
): Promise<{ filesRead: string[]; excerpts: string[] }> => {
  const events = await getPrisma().quizAttemptEvent.findMany({
    where: { attempt_id: attemptId, type: 'exploration_completed' },
    orderBy: { seq: 'asc' },
    select: { payload: true },
  });
  const files = new Set<string>();
  const excerpts: string[] = [];
  for (const { payload } of events) {
    if (!isObject(payload)) continue;
    if (Array.isArray(payload.files_read)) {
      for (const path of payload.files_read) if (typeof path === 'string') files.add(path);
    }
    if (typeof payload.excerpts === 'string' && payload.excerpts) excerpts.push(payload.excerpts);
  }
  return { filesRead: [...files], excerpts };
};

// ─── Progress ───────────────────────────────────────────────────────────────

/** `{ questionCount, presented, finalized, score, completed, hasEvaluation, lastAction? }` from Neon. */
export const getProgress = async (attemptId: string): Promise<AttemptProgress> => {
  const attempt = await getPrisma().quizAttempt.findUnique({
    where: { id: attemptId },
    select: LOCKED_ATTEMPT_SELECT,
  });
  if (!attempt)
    throw new QuizGradingError('attempt_not_found', 'This quiz attempt does not exist.');
  return progressOf(getPrisma(), attempt);
};

/** Fresh fence value for an admitted turn. */
export const newFence = () => randomUUID();
