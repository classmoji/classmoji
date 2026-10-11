/**
 * Quiz attempt reads — list_quiz_attempts / get_quiz_attempt.
 *
 * The teaching team's view of who took a quiz and how it went, mirroring the
 * web results page and its attempt drawer:
 *   - list_quiz_attempts ↔ admin.$class.quizzes_.$quizId (loader): the same
 *     reads (quizAttempt.findByQuiz, the STUDENT roster, each student's net
 *     extension hours when the quiz has a due date, the classroom's late
 *     penalty) fed to the same `buildQuizResultRows` (@classmoji/utils), so a
 *     row here is the row the page shows.
 *   - get_quiz_attempt ↔ admin.$class.quizzes_.$quizId.attempt.$attemptId: the
 *     attempt's scores and per-question results as the drawer's
 *     `attemptDrawerView` reads them (`attemptQuestionResults`,
 *     `quizEvaluationRecord`), plus what the drawer does not state: each
 *     question's first-try result (stored with it) and the hints it was
 *     graded with (the journal, `quizGrading.recordedHintsOf`). On request,
 *     its transcript as staff read it (`quizChat.loadTranscriptForViewer(id,
 *     'staff')`, which keeps each answer's `expected_answer`), each turn timed
 *     by `quizChat.messageTimesOf`, and each reply that showed a hint marked
 *     by the chat's own rule (`replyShowsHint`, `replyMovesOn`).
 *
 * ROLES: the whole teaching team (QUIZ_STAFF), the web loaders' list. Both
 * tools read per-student work, so both are audited as a VIEW, like the web
 * results page (QUIZ_DETAILS). The web drawer audits only refusals; reading
 * a transcript here is audited too (QUIZ_ATTEMPT).
 *
 * GATES, in the web loaders' order: Pro and quizzes_enabled
 * (`assertQuizSurfaceEnabled`, shared with the quiz write tools), then
 * `entitlement.quizzesVisibleOrThrow` (the web's `quizzesVisibleOrThrow`: the
 * AI agent configured, Pro, switched on).
 *
 * S1: the quiz resolves through loadQuizInClassroom; an attempt must belong
 * to that quiz. A missing attempt, another quiz's attempt and another
 * classroom's attempt all produce the identical scopedNotFound('Attempt').
 *
 * WHO TOOK IT: only an attempt by someone on the classroom's STUDENT roster
 * is a result (`on_roster`); anyone else's is never late and never a grade
 * (the results page's rule). Of those, a staff member's is a preview
 * (`is_staff_preview`); one by someone with no membership left is the work
 * of a former member, usually a removed student (attempt rows outlive the
 * membership). `list_quizzes`' attempts_count counts roster students only.
 *
 * RESPONSES ARE ALLOW-LISTED: the attempt rows arrive joined to their user
 * (and `findWithMessages` to the quiz's prompts and the classroom's
 * settings); every key below is chosen, nothing is spread from a row. A
 * student is named by id, name and the username of the classroom's git
 * provider (the roster's `login`).
 */

import { ClassmojiService } from '@classmoji/services';
import {
  attemptQuestionResults,
  buildQuizResultRows,
  quizEvaluationRecord,
  quizFocusMetrics,
  type QuizFocusMetrics,
  type QuizResultAttempt,
  type QuizResultStudent,
} from '@classmoji/utils';
import {
  buttonActionFor,
  replyMovesOn,
  replyShowsHint,
  type QuizUIMessage,
} from '@classmoji/utils/quiz-agent';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import { sanitizedSettings } from '../resources/shape.ts';
import { assertQuizSurfaceEnabled } from './quizzes.ts';
import {
  loadQuizInClassroom,
  ok,
  QUIZ_STAFF,
  requireClassroomCtx,
  scopedNotFound,
  writeAudit,
} from './shared.ts';

// ─── Shared shaping ──────────────────────────────────────────────────────────

/**
 * The quiz surface gates, then the quiz in this classroom. A classroom whose
 * quiz screens are hidden answers as list_quizzes does for a student there.
 */
async function loadQuizForAttemptReads(quizId: string, ctx: ToolContext) {
  await assertQuizSurfaceEnabled(ctx);
  const { classroomId } = requireClassroomCtx(ctx);
  if (!(await ClassmojiService.entitlement.quizzesVisibleOrThrow(classroomId))) {
    throw new ToolError('forbidden', 'Quizzes are not available in this classroom');
  }
  return loadQuizInClassroom(quizId, ctx);
}

/** A timestamp as ISO text, or null. */
const iso = (value: Date | string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const focusOf = (metrics: QuizFocusMetrics | null) =>
  metrics
    ? {
        total_ms: metrics.totalMs,
        focused_ms: metrics.focusedMs,
        focused_percentage: metrics.percentage,
      }
    : null;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The runtime an attempt was stamped with (the drawer's rule). */
const runtimeOf = (attempt: { agent_runtime?: string | null }) =>
  attempt.agent_runtime === 'trigger_chat' ? 'trigger_chat' : 'ai_agent';

/**
 * Per question, as recorded (latest wins): `emoji`, `brief_feedback`,
 * `skipped_by_end`, and `first_attempt_correct` (right on the first answer
 * with no hint before it; null on entries stored before it was recorded).
 */
function recordedNotes(json: unknown) {
  const notes = new Map<
    number,
    {
      emoji: string | null;
      brief_feedback: string | null;
      skipped_by_end: boolean;
      first_attempt_correct: boolean | null;
    }
  >();
  for (const entry of Array.isArray(json) ? json : []) {
    const r = record(entry);
    if (!r || typeof r.question_num !== 'number') continue;
    notes.set(r.question_num, {
      emoji: text(r.emoji),
      brief_feedback: text(r.brief_feedback),
      skipped_by_end: r.skipped_by_end === true,
      first_attempt_correct:
        typeof r.first_attempt_correct === 'boolean' ? r.first_attempt_correct : null,
    });
  }
  return notes;
}

/** Where someone stands in the classroom, from its STUDENT and staff memberships. */
const standing = (onRoster: boolean, isStaff: boolean) => ({
  on_roster: onRoster,
  is_staff_preview: isStaff && !onRoster,
});

/** The model's closing feedback in an evaluation record, field by field. */
function evaluationFeedback(value: unknown) {
  const f = record(value);
  if (!f) return null;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    final_acknowledgment: text(f.final_acknowledgment),
    summary: text(f.feedback_summary),
    strengths: list(f.feedback_strengths),
    improvements: list(f.feedback_improvements),
    recommendation: text(f.feedback_recommendation),
    effort_note: text(f.feedback_effort_note),
  };
}

// ─── list_quiz_attempts ──────────────────────────────────────────────────────

const STATUSES = ['not_started', 'in_progress', 'completed'] as const;
type AttemptStatus = (typeof STATUSES)[number];

interface ListQuizAttemptsArgs {
  classroom: string;
  quiz_id: string;
  status?: AttemptStatus;
}

/** The attempt columns the list reads beyond the ones `buildQuizResultRows` takes. */
interface AttemptRow {
  id: string;
  user_id: string;
  attempt_number?: number | null;
  agent_runtime?: string | null;
  last_activity?: Date | string | null;
  completed_at: Date | string | null;
}

/**
 * Where a row stands on the quiz: `in_progress` while any attempt is open (a
 * retake included), else `completed` with a completed attempt, else
 * `not_started` (a rostered student with no attempt). Every row is exactly
 * one, so the roster's three counts add up to it.
 */
const statusOf = (student: QuizResultStudent): AttemptStatus =>
  student.attempts.some(a => !a.completed_at)
    ? 'in_progress'
    : student.attempts.length > 0
      ? 'completed'
      : 'not_started';

export const listQuizAttemptsTool: ToolDefinition<ListQuizAttemptsArgs> = {
  name: 'list_quiz_attempts',
  title: 'List quiz attempts',
  description:
    "A quiz's results, as its web results page shows them: a row per student on the roster " +
    '(on_roster), not-started ones included, and per anyone else who took it: a staff ' +
    'member (is_staff_preview) or someone no longer in the classroom (both false, usually a ' +
    'removed student); neither is ever late or graded. A row has status (in_progress: an ' +
    'attempt is open; completed: none open, one completed; not_started: none), the counting ' +
    'score, counted_score after the late penalty, counts_as_zero (missing past the due date) ' +
    'and every attempt (id, started_at, completed_at, score, first_attempt_score, ' +
    "is_counting, late_hours, focus, ended_by 'turn_limit' when submitted at the message " +
    'limit; an open one has last_activity and messages_left, compare with `now`). status ' +
    'filters the rows; summary always counts the whole quiz. Teaching team only; requires ' +
    'Pro and quizzes enabled. Audit-logged. get_quiz_attempt reads one attempt and its ' +
    'transcript.',
  scope: 'read',
  annotations: { openWorld: false },
  roles: QUIZ_STAFF,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    quiz_id: z.string().uuid().describe('Quiz id (from list_quizzes)'),
    status: z.enum(STATUSES).optional().describe('Only rows with this status (default: all)'),
  },
  handler: async (args, ctx) => {
    const quiz = await loadQuizForAttemptReads(args.quiz_id, ctx);
    const { classroomId } = requireClassroomCtx(ctx);

    // The results page's reads (admin.$class.quizzes_.$quizId loader), and
    // the staff memberships that tell a preview from a former member's work.
    const assignment = quiz.assignment;
    const setting: unknown = sanitizedSettings(ctx).late_penalty_points_per_hour;
    const penalty = typeof setting === 'number' ? setting : 0;
    const [attempts, roster, staff, extensionHours] = await Promise.all([
      ClassmojiService.quizAttempt.findByQuiz(quiz.id),
      ClassmojiService.classroomMembership.findUsersByRole(classroomId, 'STUDENT'),
      ClassmojiService.classroomMembership.findUsersByRoles(classroomId, [...QUIZ_STAFF]),
      assignment?.student_deadline
        ? ClassmojiService.token.netQuizExtensionHoursByStudent({
            classroomId,
            assignmentId: assignment.id,
          })
        : null,
    ]);
    const rosterIds = new Set(roster.map(student => String(student.id)));
    const late =
      assignment?.student_deadline && extensionHours
        ? {
            studentDeadline: assignment.student_deadline,
            latePenaltyPerHour: penalty,
            extensionHours,
            studentIds: rosterIds,
          }
        : null;
    const now = new Date();
    const { students } = buildQuizResultRows({
      attempts,
      gradingStrategy: quiz.grading_strategy,
      viewerId: ctx.viewer.userId,
      late,
      roster: { students: roster, assignment: assignment ?? null, now },
    });
    const shown = args.status ? students.filter(s => statusOf(s) === args.status) : students;

    // How each shown chat attempt stands against its message limit, in one batch.
    const rows = new Map<string, AttemptRow>(attempts.map(a => [a.id, a as AttemptRow]));
    const chatIds = shown.flatMap(s =>
      s.attempts.flatMap(a => {
        const row = rows.get(a.id);
        return row && runtimeOf(row) === 'trigger_chat' ? [a.id] : [];
      })
    );
    const limits = await ClassmojiService.quizChat.messageLimitsOf(chatIds);

    // The memberships name a person by the classroom's git provider; the
    // attempt join by their Github username first. A membership's wins.
    const memberLogin = new Map(
      [...staff, ...roster].map(member => [String(member.id), member.login])
    );
    const staffIds = new Set(staff.map(member => String(member.id)));

    const attemptView = (attempt: QuizResultAttempt) => {
      const row = rows.get(attempt.id);
      const open = !attempt.completed_at;
      const chat = row ? runtimeOf(row) === 'trigger_chat' : false;
      const limit = limits.get(attempt.id);
      return {
        id: attempt.id,
        attempt_number: row?.attempt_number ?? null,
        started_at: iso(attempt.started_at),
        completed_at: iso(attempt.completed_at),
        ended_by: limit?.endedBy ?? null,
        score: attempt.partialCreditScore,
        first_attempt_score: attempt.firstAttemptScore,
        is_counting: attempt.isCounting,
        late_hours: attempt.lateHours,
        focus: focusOf(attempt.focusMetrics),
        // Only a chat attempt records its activity and counts its messages.
        ...(open
          ? {
              last_activity: chat ? iso(row?.last_activity) : null,
              messages_left: limit?.messagesLeft ?? null,
            }
          : {}),
      };
    };

    const studentView = (student: QuizResultStudent) => ({
      user_id: student.userId,
      login: memberLogin.get(student.userId) ?? student.user.login,
      name: student.user.name,
      ...standing(student.onRoster, staffIds.has(student.userId)),
      status: statusOf(student),
      attempt_count: student.attemptCount,
      current_score: student.currentScore,
      counted_score: student.countedScore,
      late_hours: student.lateHours,
      counts_as_zero: student.countsAsZero,
      best_score: student.bestScore,
      first_attempt_score: student.firstAttemptScore,
      counting_attempt_id: student.countingAttemptId,
      attempts: student.attempts.map(attemptView),
    });

    const onRoster = students.filter(s => s.onRoster);
    const others = students.filter(s => !s.onRoster);
    const withStatus = (status: AttemptStatus) =>
      onRoster.filter(s => statusOf(s) === status).length;
    await writeAudit(ctx, {
      resource_type: 'QUIZ_DETAILS',
      resource_id: quiz.id,
      action: 'VIEW',
      data: { tool: 'list_quiz_attempts' },
    });

    return ok({
      quiz: {
        id: quiz.id,
        name: quiz.name,
        grading_strategy: quiz.grading_strategy ?? null,
        max_attempts: quiz.max_attempts ?? null,
        question_count: quiz.question_count ?? null,
        assignment_id: assignment?.id ?? null,
        student_deadline: iso(assignment?.student_deadline),
        late_penalty_per_hour: penalty,
      },
      // The whole quiz, whatever `status` shows.
      summary: {
        roster_students: rosterIds.size,
        not_started: withStatus('not_started'),
        in_progress: withStatus('in_progress'),
        completed: withStatus('completed'),
        counts_as_zero: onRoster.filter(s => s.countsAsZero).length,
        staff_previews: others.filter(s => staffIds.has(s.userId)).length,
        former_members: others.filter(s => !staffIds.has(s.userId)).length,
      },
      now: now.toISOString(),
      students: shown.map(studentView),
    });
  },
};

// ─── get_quiz_attempt ────────────────────────────────────────────────────────

interface GetQuizAttemptArgs {
  classroom: string;
  quiz_id: string;
  attempt_id: string;
  include_transcript?: boolean;
}

/** One transcript part as staff read it; UI-only parts are left out. */
type TranscriptPart =
  | { kind: 'text'; text: string }
  /** The work listed above a reply: a file the quiz read, or course material it looked up. */
  | { kind: 'read_file'; path: string; failed: boolean }
  /** `title` is the document read; null for a search (its query is never shown). */
  | { kind: 'course_material'; title: string | null }
  | {
      kind: 'question';
      number: number | null;
      total: number | null;
      preamble: string | null;
      text: string | null;
      code: string | null;
      code_language: string | null;
      context: string | null;
      source: { path: string | null; lines: string | null; changed: boolean } | null;
    }
  | {
      kind: 'feedback';
      feedback: string | null;
      expected_answer: string | null;
      actions: string[];
    }
  | {
      kind: 'question_result';
      question_num: number | null;
      emoji: string | null;
      brief_feedback: string | null;
      revised: boolean;
    }
  | { kind: 'notice'; code: string | null }
  | { kind: 'evaluation' };

/** A tool call that failed or was refused: never shown (QuizChat `isFailedToolPart`). */
const isFailedToolPart = (part: Record<string, unknown>) =>
  typeof part.type === 'string' &&
  (part.type.startsWith('tool-') || part.type === 'dynamic-tool') &&
  (part.state === 'output-error' || part.state === 'output-denied');

/**
 * A projected transcript part, flattened the way QuizChat renders it: the
 * files read and course material looked up (listed above the bubble, as
 * StepList does), the question card from present_question's OUTPUT (the
 * server-accepted card, never the call's input), the feedback and the
 * staff-only expected answer from offer_next_step's input with its buttons
 * from the output, a recorded result, a notice, and where the evaluation was
 * shown (its content is the attempt's `evaluation`). Step markers and failed
 * calls are dropped.
 */
function transcriptPart(raw: unknown): TranscriptPart | null {
  const part = record(raw);
  if (!part || isFailedToolPart(part)) return null;
  switch (part.type) {
    case 'text': {
      const t = text(part.text);
      return t ? { kind: 'text', text: t } : null;
    }
    case 'data-step': {
      const step = record(part.data);
      if (step?.kind === 'read_file') {
        const path = text(step.path);
        return path ? { kind: 'read_file', path, failed: step.error === true } : null;
      }
      return step?.kind === 'course_material'
        ? { kind: 'course_material', title: text(step.title) }
        : null;
    }
    case 'tool-present_question': {
      if (part.state !== 'output-available') return null;
      const output = record(part.output);
      const card = record(output?.card);
      if (!card) return null;
      const source = record(card.source);
      return {
        kind: 'question',
        number: typeof output?.question_number === 'number' ? output.question_number : null,
        total: typeof output?.total_questions === 'number' ? output.total_questions : null,
        preamble: text(card.preamble),
        text: text(card.question_text),
        code: text(card.code_snippet),
        code_language: text(card.code_language),
        context: text(card.context),
        source: source
          ? {
              path: text(source.path),
              lines: text(source.lines),
              changed: source.changed === true,
            }
          : null,
      };
    }
    case 'tool-offer_next_step': {
      const input = record(part.input);
      const output = part.state === 'output-available' ? record(part.output) : null;
      const actions = Array.isArray(output?.actions)
        ? output.actions.filter((a): a is string => typeof a === 'string')
        : [];
      const feedback = text(input?.feedback);
      const expected = text(input?.expected_answer);
      if (!feedback && !expected && actions.length === 0) return null;
      return {
        kind: 'feedback',
        feedback,
        expected_answer: expected ? expected.trim() : null,
        actions,
      };
    }
    case 'data-question-result': {
      const data = record(part.data);
      if (!data) return null;
      return {
        kind: 'question_result',
        question_num: typeof data.question_num === 'number' ? data.question_num : null,
        emoji: text(data.emoji),
        brief_feedback: text(data.brief_feedback),
        revised: data.revised === true,
      };
    }
    case 'data-notice':
      return { kind: 'notice', code: text(record(part.data)?.code) };
    case 'tool-submit_quiz_evaluation':
      return part.state === 'output-available' ? { kind: 'evaluation' } : null;
    case 'data-evaluation':
      return { kind: 'evaluation' };
    default:
      return null;
  }
}

/**
 * A chat attempt's transcript as compact turns: who spoke, when the message
 * was saved (`times`, by message id), the button a student message used, and
 * the parts shown. Turns left with nothing are dropped.
 *
 * `hint: true` marks an assistant reply that showed a hint, by the chat's own
 * rule (`buttonSetsOf` in QuizChat): the first reply after a Try again click
 * (the stored action, or text naming the button), when it shows text and no
 * notice (`replyShowsHint`) and does not move the quiz on (`replyMovesOn`,
 * against the highest card shown before it). A click whose reply failed or
 * moved on showed none. The click state is read over every message, those
 * with nothing to show included, as the chat reads it.
 */
function chatTranscript(messages: readonly QuizUIMessage[], times: ReadonlyMap<string, Date>) {
  let lastCard = 0;
  let clicked: string | undefined;
  return messages.flatMap(message => {
    const raw = message.parts as unknown[];
    let action: string | null = null;
    let hint = false;
    if (message.role === 'user') {
      const typed = raw.flatMap(p => {
        const part = record(p);
        return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
      });
      action = message.metadata?.action ?? buttonActionFor(typed.join('\n')) ?? null;
      clicked = action ?? undefined;
    } else if (message.role === 'assistant') {
      const answers = clicked;
      clicked = undefined;
      const currentQuestion = lastCard;
      for (const p of raw) {
        const part = record(p);
        if (!part || isFailedToolPart(part)) continue;
        const shown = record(part.output)?.question_number;
        if (
          part.type === 'tool-present_question' &&
          part.state === 'output-available' &&
          typeof shown === 'number'
        ) {
          lastCard = Math.max(lastCard, shown);
        }
      }
      hint = answers === 'try_again' && !replyMovesOn(raw, currentQuestion) && replyShowsHint(raw);
    }
    const parts = raw.flatMap(p => {
      const flat = transcriptPart(p);
      return flat ? [flat] : [];
    });
    if (parts.length === 0) return [];
    return [
      {
        role: message.role,
        at: iso(times.get(message.id)),
        ...(action ? { action } : {}),
        ...(hint ? { hint: true } : {}),
        parts,
      },
    ];
  });
}

/** A legacy (ai_agent) attempt's messages: role, text and time only, never metadata. */
function legacyTranscript(messages: readonly unknown[]) {
  return messages.flatMap(raw => {
    const m = record(raw);
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return [];
    const t = text(m.content);
    if (!t) return [];
    return [{ role: m.role, at: iso(m.timestamp as Date | string | null), text: t }];
  });
}

export const getQuizAttemptTool: ToolDefinition<GetQuizAttemptArgs> = {
  name: 'get_quiz_attempt',
  title: 'Get a quiz attempt',
  description:
    'One attempt at a quiz (ids from list_quiz_attempts): the student, on_roster, ' +
    'is_staff_preview, timing and focus, ended_by, and for a completed attempt its score, ' +
    'first_attempt_score, per-question results (credit_earned, tries, first_attempt_correct, ' +
    'hints_used: hints shown before the last answer, as graded; null where not recorded, ' +
    'emoji, brief_feedback) and the evaluation (band, summary, strengths, improvements). An ' +
    'open attempt carries last_activity and messages_left. include_transcript:true adds the ' +
    'whole conversation, each turn with its time (at): questions, answers, feedback, files ' +
    'read and course material looked up, the button a student used (action), hint:true on ' +
    "a reply that showed a hint, and each expected_answer (not on the caller's own " +
    'preview). Teaching team only; requires Pro and quizzes enabled. Audit-logged.',
  scope: 'read',
  annotations: { openWorld: false },
  roles: QUIZ_STAFF,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    quiz_id: z.string().uuid().describe('Quiz id'),
    attempt_id: z.string().uuid().describe('Attempt id (from list_quiz_attempts)'),
    include_transcript: z.boolean().optional().describe('Add the whole transcript (default false)'),
  },
  handler: async (args, ctx) => {
    const quiz = await loadQuizForAttemptReads(args.quiz_id, ctx);
    const { classroomId } = requireClassroomCtx(ctx);

    // The attempt's own columns first, no messages: an attempt naming nothing
    // and one of another quiz (in this classroom or any other) are the same
    // not_found, and nothing more is read for either.
    const attempt = await ClassmojiService.quizAttempt.findForReview(args.attempt_id);
    if (!attempt || String(attempt.quiz_id) !== String(quiz.id)) {
      throw scopedNotFound('Attempt');
    }
    const userId = String(attempt.user_id);
    const isChat = runtimeOf(attempt) === 'trigger_chat';
    const completed = Boolean(attempt.completed_at);

    // Whether its user is on the STUDENT roster or on staff, with their
    // username on the classroom's git provider; how a chat attempt stands
    // against its message limit; and the hints its questions were graded with.
    const [[student], [staff], limit, hints] = await Promise.all([
      ClassmojiService.classroomMembership.findUsersByRole(classroomId, 'STUDENT', {
        user_id: userId,
      }),
      ClassmojiService.classroomMembership.findUsersByRoles(classroomId, [...QUIZ_STAFF], {
        user_id: userId,
      }),
      isChat ? ClassmojiService.quizChat.messageLimitOf(attempt.id) : null,
      isChat && completed ? ClassmojiService.quizGrading.recordedHintsOf(attempt.id) : null,
    ]);

    // Scores and results are a completed attempt's only (attemptDrawerView).
    const evaluation = completed ? quizEvaluationRecord(attempt.evaluation_json) : null;
    const notes = recordedNotes(attempt.question_results_json);
    const questionResults = completed
      ? attemptQuestionResults(
          attempt.question_results_json,
          attempt.agent_config,
          attempt.quiz?.question_count
        ).map(r => {
          const note = notes.get(r.question_num);
          return {
            question_num: r.question_num,
            credit_earned: r.credit_earned,
            tries: r.attempts,
            eventually_correct: r.eventually_correct,
            first_attempt_correct: note?.first_attempt_correct ?? null,
            hints_used: hints?.get(r.question_num) ?? null,
            emoji: note?.emoji ?? null,
            brief_feedback: note?.brief_feedback ?? null,
            skipped_by_end: note?.skipped_by_end ?? false,
          };
        })
      : [];

    // The transcript as the web drawer reads it: staff reading someone else's
    // attempt get each answer's expected_answer; the caller's own attempt (a
    // preview) is read as its owner reads it. A legacy attempt's messages are
    // read only here, and an attempt deleted since the lookup is not found.
    let transcript: unknown[] | undefined;
    if (args.include_transcript === true) {
      if (isChat) {
        const ownsAttempt = userId === String(ctx.viewer.userId);
        const [messages, times] = await Promise.all([
          ClassmojiService.quizChat.loadTranscriptForViewer(
            attempt.id,
            ownsAttempt ? 'student' : 'staff'
          ),
          ClassmojiService.quizChat.messageTimesOf(attempt.id),
        ]);
        transcript = chatTranscript(messages, times);
      } else {
        const data = await ClassmojiService.quizAttempt
          .findWithMessages(attempt.id)
          .catch((error: unknown) => {
            // Only the service's not-found error, matched by name; anything else surfaces.
            if ((error as { name?: unknown } | null)?.name === 'QuizAttemptNotFoundError') {
              throw scopedNotFound('Attempt');
            }
            throw error;
          });
        transcript = legacyTranscript(data.messages ?? []);
      }
    }

    await writeAudit(ctx, {
      resource_type: 'QUIZ_ATTEMPT',
      resource_id: attempt.id,
      action: 'VIEW',
      data: {
        tool: 'get_quiz_attempt',
        quiz_id: quiz.id,
        include_transcript: args.include_transcript === true,
      },
    });

    const now = new Date();
    return ok({
      quiz: { id: quiz.id, name: quiz.name, question_count: quiz.question_count ?? null },
      attempt: {
        id: attempt.id,
        attempt_number: attempt.attempt_number ?? null,
        user_id: userId,
        login: student?.login ?? staff?.login ?? attempt.user?.login ?? null,
        name: attempt.user?.name ?? null,
        ...standing(Boolean(student), Boolean(staff)),
        runtime: runtimeOf(attempt),
        started_at: iso(attempt.started_at),
        completed_at: iso(attempt.completed_at),
        ended_by: completed ? (limit?.endedBy ?? null) : null,
        focus: focusOf(quizFocusMetrics(attempt)),
        // Only a chat attempt records its activity and counts its messages.
        ...(completed
          ? {}
          : {
              last_activity: isChat ? iso(attempt.last_activity) : null,
              messages_left: limit?.messagesLeft ?? null,
            }),
        score: completed ? (attempt.partial_credit_percentage ?? null) : null,
        first_attempt_score: completed ? (attempt.first_attempt_percentage ?? null) : null,
        question_results: questionResults,
        evaluation: evaluation
          ? {
              // The record is JSON, checked only for `v: 2`: read field by field.
              source: text(evaluation.source),
              band: text(evaluation.evaluation),
              numeric_score:
                typeof evaluation.numeric_score === 'number' ? evaluation.numeric_score : null,
              feedback: evaluationFeedback(evaluation.feedback),
            }
          : null,
      },
      ...(completed ? {} : { now: now.toISOString() }),
      ...(transcript ? { transcript } : {}),
    });
  },
};
