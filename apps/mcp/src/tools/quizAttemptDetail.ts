/**
 * get_quiz_attempt — how one student's attempt at a quiz went: its grades, the
 * result for each question and the closing evaluation, and on request its
 * transcript. What the staff review drawer shows
 * (admin.$class.quizzes_.$quizId.attempt.$attemptId).
 *
 * Tier: OWNER, TEACHER and ASSISTANT, as the web route. Where the classroom
 * shows no quizzes it is refused, as the page 404s there.
 *
 * S1: the attempt is looked up among the attempts of a quiz resolved through
 * loadQuizInClassroom, so an attempt of another quiz, or of another classroom's
 * quiz, is the same not_found as an id that names nothing.
 *
 * WHO TOOK IT, as list_quiz_attempts tells them apart: someone on the STUDENT
 * roster (`on_roster`), a current staff member (`is_staff_preview`), or
 * neither (`is_former_member`: usually a removed student). Their login is the
 * classroom's git provider's.
 *
 * Grades are emoji on the classroom's own scale (quizGradeEmoji.ts), never a
 * number: the attempt's grade and first-try grade, and each question's stored
 * emoji. No credit, percentage or evaluation score leaves. A staff adjustment
 * (quiz_attempt_adjust) is the attempt's grade (its own emoji), shown with the
 * AI's original emoji and who set it when; the comment to the student with
 * who wrote it when (its own authorship); the open regrade request on the
 * attempt with the student's comment, if any; and the classroom's scale
 * (`emoji_scale`, its emoji best first, no numbers), the emoji
 * quiz_attempt_adjust and regrade_resolve take.
 *
 * The response is built field by field: the attempt row carries the agent
 * configuration, the session token and the joined user's contact fields, none
 * of which leave. Reading another person's attempt is audited, as the page
 * audits its VIEW.
 *
 * The transcript (`include_transcript`) is the one the drawer renders. A chat
 * attempt's comes from `quizChat.loadTranscriptForViewer`, read as the drawer
 * reads it: staff reading someone else's attempt as 'staff' (each answer's
 * expected_answer kept), the caller's own preview as its owner. That
 * projection has already removed system and hidden messages, reasoning, the
 * internal tools (record_question_result, the exploration and course-material
 * calls) and the quoted code's terms; the parts left are then flattened the
 * way QuizChat renders them, and nothing else (`transcriptPart`). A legacy
 * attempt's is its user and assistant messages as the legacy chat renders
 * them: each machine block ([QUESTION_COMPLETE], [QUIZ_EVALUATION],
 * [QUESTION_CARD], [BUTTON:…]) parsed by the chat's own parsers and shown as
 * the chat shows it, never as text, and never the prompts `findWithMessages`
 * also returns.
 *
 * Not here: how the attempt ended. An attempt past its session deadline is
 * closed, with the results so far, the next time someone opens it in the app;
 * this read leaves it as it is.
 */

import { ClassmojiService } from '@classmoji/services';
import {
  attemptQuestionResults,
  checkForCompletion,
  completionMessageDisplay,
  parseMessageButtons,
  parseQuestionCard,
  parseQuestionComplete,
  quizEvaluationRecord,
  stripQuestionComplete,
} from '@classmoji/utils';
import { buttonActionFor, type QuizUIMessage } from '@classmoji/utils/quiz-agent';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { orgProvider } from '../resources/shape.ts';
import getPrisma from '@classmoji/database';
import { attemptGrade, emojiFor, loadQuizEmojiScale, type EmojiScale } from './quizGradeEmoji.ts';
import {
  loadQuizInClassroom,
  ok,
  QUIZ_STAFF,
  requireClassroomCtx,
  scopedNotFound,
  writeAudit,
} from './shared.ts';

interface GetQuizAttemptArgs {
  classroom: string;
  quiz_id: string;
  attempt_id: string;
  include_transcript?: boolean;
}

interface AttemptRow {
  id: string;
  user_id: string;
  agent_runtime?: string | null;
  agent_config?: unknown;
  started_at: Date;
  completed_at: Date | null;
  partial_credit_percentage: number | null;
  first_attempt_percentage: number | null;
  total_duration_ms: number | bigint | null;
  unfocused_duration_ms: number | bigint | null;
  question_results_json: unknown;
  evaluation_json: unknown;
  adjusted_emoji: string | null;
  instructor_comment?: string | null;
  adjusted_by_id?: string | null;
  adjusted_at?: Date | string | null;
  comment_by_id?: string | null;
  comment_at?: Date | string | null;
  user?: { id: string; login?: string | null; name?: string | null } | null;
}

interface Member {
  id: string;
  login?: string | null;
  name?: string | null;
}

const iso = (value: Date | string | null | undefined) => {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** One question's result: how it went and its emoji, never its credit. */
interface QuestionResultView {
  question_num: number;
  tries: number;
  eventually_correct: boolean;
  first_attempt_correct: boolean | null;
  emoji: string | null;
  brief_feedback: string | null;
  skipped_by_end: boolean;
}

/**
 * What each stored result says beyond the drawer's fields, latest entry per
 * question: its emoji, brief feedback, first-try result and whether the end
 * of the quiz skipped it (absent on entries stored before they were recorded).
 */
function recordedNotes(json: unknown) {
  const notes = new Map<
    number,
    {
      emoji: string | null;
      brief_feedback: string | null;
      first_attempt_correct: boolean | null;
      skipped_by_end: boolean;
    }
  >();
  for (const entry of Array.isArray(json) ? json : []) {
    const r = record(entry);
    if (!r || typeof r.question_num !== 'number') continue;
    notes.set(r.question_num, {
      emoji: text(r.emoji),
      brief_feedback: text(r.brief_feedback),
      first_attempt_correct:
        typeof r.first_attempt_correct === 'boolean' ? r.first_attempt_correct : null,
      skipped_by_end: r.skipped_by_end === true,
    });
  }
  return notes;
}

/**
 * A completed attempt's per-question results: the questions the drawer shows
 * (`attemptQuestionResults`: questions 1..N of the attempt, one each, in
 * order), each with its stored emoji, or the scale's emoji for its credit
 * where none was stored. The credit itself does not leave.
 */
function questionResults(
  attempt: AttemptRow,
  questionCount: number | null | undefined,
  scale: EmojiScale
): QuestionResultView[] {
  const notes = recordedNotes(attempt.question_results_json);
  return attemptQuestionResults(
    attempt.question_results_json,
    attempt.agent_config,
    questionCount
  ).map(r => {
    const note = notes.get(r.question_num);
    return {
      question_num: r.question_num,
      tries: r.attempts,
      eventually_correct: r.eventually_correct,
      first_attempt_correct: note?.first_attempt_correct ?? null,
      emoji: note?.emoji ?? emojiFor(r.credit_earned, scale),
      brief_feedback: note?.brief_feedback ?? null,
      skipped_by_end: note?.skipped_by_end ?? false,
    };
  });
}

/** The model's closing feedback, field by field (the record's copy also holds its band score). */
function evaluationFeedback(value: unknown) {
  const f = record(value);
  if (!f) return null;
  return {
    final_acknowledgment: text(f.final_acknowledgment),
    summary: text(f.feedback_summary),
    strengths: strings(f.feedback_strengths),
    improvements: strings(f.feedback_improvements),
    recommendation: text(f.feedback_recommendation),
    effort_note: text(f.feedback_effort_note),
  };
}

// ─── Transcript ──────────────────────────────────────────────────────────────

/** One transcript part, as QuizChat renders it. */
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
      has_sandbox: boolean;
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
  /** A legacy reply's Try again / Next buttons. */
  | { kind: 'buttons'; actions: string[] }
  /** Where the results were shown; their content is the attempt's `evaluation`. */
  | { kind: 'evaluation' }
  | {
      kind: 'code_submission';
      question_number: number | null;
      /** The files that changed, with their content, as the submission card shows them. */
      changed_files: Array<{ path: string; content: string }>;
      console: Array<{ method: string; text: string }>;
      errors: Array<{
        kind: string | null;
        title: string | null;
        message: string | null;
        path: string | null;
        line: number | null;
      }>;
      timed_out: boolean;
    };

/** A tool call that failed or was refused: never shown (QuizChat `isFailedToolPart`). */
const isFailedToolPart = (part: Record<string, unknown>) =>
  typeof part.type === 'string' &&
  (part.type.startsWith('tool-') || part.type === 'dynamic-tool') &&
  (part.state === 'output-error' || part.state === 'output-denied');

/** A question card part that QuizChat counts as a card (`cardNumber` not null). */
const isCardPart = (part: Record<string, unknown>) =>
  part.type === 'tool-present_question' && !isFailedToolPart(part);

/** A card's question number, for ordering markers (QuizChat `cardNumber`). */
const cardNumberOf = (part: Record<string, unknown>): number | null => {
  if (!isCardPart(part)) return null;
  const source = part.state === 'output-available' ? record(part.output) : record(part.input);
  const n = source?.question_number;
  return typeof n === 'number' ? n : Infinity;
};

/**
 * An assistant message's parts in the order QuizChat shows them, without the
 * text it hides. A question's marker (`data-question-result`) moves to just
 * before the earliest card for a later question (`displayOrder`); text after
 * a card is not shown (`textAfterCard`: it only restates the question).
 */
function assistantDisplayParts(parts: readonly unknown[]): Record<string, unknown>[] {
  let cardSeen = false;
  const kept: Record<string, unknown>[] = [];
  for (const raw of parts) {
    const part = record(raw);
    if (!part) continue;
    if (cardNumberOf(part) !== null) cardSeen = true;
    else if (cardSeen && part.type === 'text') continue;
    kept.push(part);
  }
  const ordered: Record<string, unknown>[] = [];
  for (const part of kept) {
    if (part.type === 'data-question-result') {
      const n = record(part.data)?.question_num;
      if (typeof n === 'number') {
        const at = ordered.findIndex(entry => (cardNumberOf(entry) ?? -Infinity) > n);
        if (at !== -1) {
          ordered.splice(at, 0, part);
          continue;
        }
      }
    }
    ordered.push(part);
  }
  return ordered;
}

/** A student's code submission as the submission card shows it: what changed and how it ran. */
function codeSubmissionPart(data: unknown): TranscriptPart | null {
  const s = record(data);
  const files = record(s?.files);
  if (!s || !files) return null;
  const paths = Array.isArray(s.changed_files)
    ? strings(s.changed_files)
    : Object.keys(files).sort();
  return {
    kind: 'code_submission',
    question_number: typeof s.question_number === 'number' ? s.question_number : null,
    changed_files: paths.flatMap(path =>
      typeof files[path] === 'string' ? [{ path, content: files[path] as string }] : []
    ),
    console: (Array.isArray(s.console) ? s.console : []).flatMap(raw => {
      const line = record(raw);
      return line && typeof line.method === 'string' && typeof line.text === 'string'
        ? [{ method: line.method, text: line.text }]
        : [];
    }),
    errors: (Array.isArray(s.errors) ? s.errors : []).flatMap(raw => {
      const e = record(raw);
      return e
        ? [
            {
              kind: text(e.kind),
              title: text(e.title),
              message: text(e.message),
              path: text(e.path),
              line: typeof e.line === 'number' ? e.line : null,
            },
          ]
        : [];
    }),
    timed_out: s.timed_out === true,
  };
}

/**
 * One assistant part, flattened the way QuizChat renders it: the files read
 * and course material looked up (listed above the bubble), the question card
 * from present_question's OUTPUT (the server-accepted card, never the call's
 * input), the feedback and the staff-only expected answer from
 * offer_next_step's input with its buttons from the output, a recorded
 * result (its emoji, never a credit), a notice, and where the evaluation was
 * shown. Anything else renders nothing and is dropped.
 */
function assistantPart(part: Record<string, unknown>): TranscriptPart | null {
  if (isFailedToolPart(part)) return null;
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
          ? { path: text(source.path), lines: text(source.lines), changed: source.changed === true }
          : null,
        has_sandbox: Boolean(record(card.sandbox)),
      };
    }
    case 'tool-offer_next_step': {
      const input = record(part.input);
      const output = part.state === 'output-available' ? record(part.output) : null;
      const actions = strings(output?.actions);
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
 * A chat attempt's transcript as turns: who spoke, the button a student
 * message used (`action`), and the parts shown. A student message is its
 * text, or its code submission; turns left with nothing are dropped.
 */
function chatTranscript(messages: readonly QuizUIMessage[]) {
  return messages.flatMap(message => {
    const raw = (Array.isArray(message.parts) ? message.parts : []) as unknown[];
    let parts: TranscriptPart[];
    let action: string | null = null;
    if (message.role === 'user') {
      const typed = raw.flatMap(p => {
        const part = record(p);
        return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
      });
      const submission = raw.map(record).find(part => part?.type === 'data-code-submission');
      if (submission) {
        const shown = codeSubmissionPart(submission.data);
        parts = shown ? [shown] : [];
      } else {
        const t = text(typed.join('\n').trim());
        parts = t ? [{ kind: 'text', text: t }] : [];
      }
      action = message.metadata?.action ?? buttonActionFor(typed.join('\n')) ?? null;
    } else if (message.role === 'assistant') {
      // One results panel per message, however many parts carry the evaluation.
      let evaluationShown = false;
      parts = assistantDisplayParts(raw).flatMap(part => {
        const shown = assistantPart(part);
        if (shown?.kind === 'evaluation') {
          if (evaluationShown) return [];
          evaluationShown = true;
        }
        return shown ? [shown] : [];
      });
    } else {
      return [];
    }
    if (parts.length === 0) return [];
    return [{ role: message.role, ...(action ? { action } : {}), parts }];
  });
}

/** The machine blocks a legacy reply may carry; none is ever shown as text. */
const LEGACY_MARKERS = ['[QUIZ_EVALUATION]', '[QUESTION_COMPLETE]', '[QUESTION_CARD]'];

/** Text with any machine block left over cut off at its marker (a block the parsers could not read). */
const withoutMarkers = (value: string): string | null => {
  let cut = value;
  for (const marker of LEGACY_MARKERS) {
    const at = cut.indexOf(marker);
    if (at !== -1) cut = cut.slice(0, at);
  }
  return text(cut.trim());
};

/** A legacy question card's fields, as QuestionCard renders them. */
function legacyQuestionPart(data: unknown): TranscriptPart | null {
  const card = record(data);
  if (!card) return null;
  return {
    kind: 'question',
    number: typeof card.question_number === 'number' ? card.question_number : null,
    total: typeof card.total_questions === 'number' ? card.total_questions : null,
    preamble: null,
    text: text(card.question_text),
    code: text(card.code_snippet),
    code_language: text(card.code_language),
    context: text(card.context),
    source: null,
    has_sandbox: false,
  };
}

/** The fixed line the legacy chat shows for a closing reply with nothing else to show. */
const LEGACY_CLOSING_LINE = 'Quiz completed! See your evaluation below.';

/**
 * What a legacy reply shows besides its markers, or null when it shows
 * nothing. With no [QUIZ_EVALUATION] block, the chat's own rule
 * (`completionMessageDisplay`, which then returns the reply unchanged). With
 * one, never anything from the marker on: the reply's text before its FIRST
 * marker of any kind (the chat's rule takes the text before the first fenced
 * block, which keeps an earlier raw block when a reply carries two), else
 * the evaluation's final_acknowledgment, else the chat's closing line on the
 * last message, else nothing.
 */
function replyBody(body: string, isLast: boolean): string | null {
  const completion = checkForCompletion(body);
  if (!completion) {
    const shown = completionMessageDisplay(body, isLast);
    return shown.shouldHide ? null : shown.content;
  }
  return (
    withoutMarkers(body) ??
    text(completion.final_acknowledgment) ??
    (isLast ? LEGACY_CLOSING_LINE : null)
  );
}

/**
 * A legacy assistant message as the legacy chat (QuizMessageList) renders it:
 * a question's marker from its [QUESTION_COMPLETE] block (its emoji and brief
 * feedback, never its credit), then the message without its machine blocks:
 * the text before a [QUIZ_EVALUATION] block or its final_acknowledgment
 * (`replyBody`), a [QUESTION_CARD] as its preamble and card
 * (nothing after it), or the text with its [BUTTON:…] markers as buttons.
 */
function legacyAssistantParts(content: string, isLast: boolean): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  let body = content;
  const complete = parseQuestionComplete(body);
  if (complete) {
    parts.push({
      kind: 'question_result',
      question_num: complete.question_num,
      emoji: text(complete.emoji),
      brief_feedback: text(complete.brief_feedback),
      revised: false,
    });
    body = stripQuestionComplete(body);
  }
  const shown = replyBody(body, isLast);
  if (shown === null) return parts;
  body = shown;

  const card = parseQuestionCard(body);
  if (card.hasQuestionCard) {
    const preamble = card.preamble ? withoutMarkers(card.preamble) : null;
    if (preamble) parts.push({ kind: 'text', text: preamble });
    const question = legacyQuestionPart(card.questionData);
    if (question) parts.push(question);
    return parts;
  }
  const { cleanContent, buttons } = parseMessageButtons(body);
  const t = withoutMarkers(cleanContent);
  if (t) parts.push({ kind: 'text', text: t });
  if (buttons.length > 0) {
    parts.push({
      kind: 'buttons',
      actions: buttons.map(b => (b === 'TRY_AGAIN' ? 'try_again' : 'next')),
    });
  }
  return parts;
}

interface LegacyMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date | string | null;
}

/** A legacy attempt's displayed messages: user and assistant rows with text, in order. */
function legacyMessages(messages: readonly unknown[]): LegacyMessage[] {
  return messages.flatMap(raw => {
    const m = record(raw);
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return [];
    if (typeof m.content !== 'string') return [];
    return [
      {
        role: m.role,
        content: m.content,
        timestamp: (m.timestamp as Date | string | null) ?? null,
      },
    ];
  });
}

/** A legacy (ai_agent) attempt's transcript: who spoke, when, and what the chat showed. */
function legacyTranscript(messages: readonly LegacyMessage[]) {
  // A blank student row shows nothing, so the last message is counted without them.
  const shown = messages.filter(m => m.role === 'assistant' || text(m.content));
  return shown.flatMap((m, index) => {
    const parts: TranscriptPart[] =
      m.role === 'assistant'
        ? legacyAssistantParts(m.content, index === shown.length - 1)
        : [{ kind: 'text', text: m.content.trim() }];
    if (parts.length === 0) return [];
    return [{ role: m.role, sent_at: iso(m.timestamp), parts }];
  });
}

/**
 * A legacy attempt's evaluation, from its last [QUIZ_EVALUATION] block, as the
 * drawer's `lastEvaluationIn` finds it on load (its skip set, the evaluations
 * a live session saw refused, is empty when a saved attempt is opened), read
 * as the drawer's evaluation card reads it: the band and the feedback, no
 * number.
 */
function legacyEvaluation(messages: readonly LegacyMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue;
    const completion = checkForCompletion(messages[i].content);
    if (completion) {
      return {
        source: null,
        band: text(completion.evaluation),
        feedback: evaluationFeedback(completion),
      };
    }
  }
  return null;
}

export const getQuizAttemptTool: ToolDefinition<GetQuizAttemptArgs> = {
  name: 'get_quiz_attempt',
  annotations: { destructive: false, idempotent: true, openWorld: false },
  title: 'Get a quiz attempt',
  description:
    'One quiz attempt: the student, when it started and completed, grade_emoji and ' +
    "first_attempt_emoji (emoji on the classroom's own scale, score-N badges on the numeric " +
    'scale; never numbers), band, the staff adjustment (adjusted, original_emoji, ' +
    'adjusted_at, adjusted_by) and the comment to the student (instructor_comment, ' +
    'comment_at, comment_by); change either with quiz_attempt_adjust, picking from ' +
    'emoji_scale (the classroom scale, best first). open_regrade_request (id, ' +
    'student_comment, created_at), focus_percentage, the result of each question (tries, ' +
    'eventually_correct, first_attempt_correct, emoji, brief_feedback), and the evaluation ' +
    '(band, closing feedback). include_transcript: true adds the conversation as the staff ' +
    'review drawer shows it: questions, answers, feedback with each expected_answer (not on ' +
    "the caller's own preview), files read, code submissions, and the button a student used " +
    '(action). Get attempt ids from list_quiz_attempts. Staff previews are flagged ' +
    'is_staff_preview. The teaching team only; the read is audited.',
  scope: 'read',
  roles: QUIZ_STAFF,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    quiz_id: z.string().uuid().describe('Quiz id (see list_quizzes)'),
    attempt_id: z.string().uuid().describe('Attempt id (see list_quiz_attempts)'),
    include_transcript: z
      .boolean()
      .optional()
      .describe('Add the conversation, as the staff review drawer shows it (default false)'),
  },
  handler: async (args, ctx) => {
    const { classroomId } = requireClassroomCtx(ctx);
    if (!(await ClassmojiService.entitlement.quizzesVisibleOrThrow(classroomId))) {
      throw new ToolError('forbidden', 'Quizzes are not available in this classroom');
    }

    const quiz = await loadQuizInClassroom(args.quiz_id, ctx);
    // The attempt only if it is this quiz's, its login the classroom's git
    // provider's: another quiz's attempt is the same not_found as none.
    const attempt = (await ClassmojiService.quizAttempt.findInQuiz(
      quiz.id,
      args.attempt_id,
      orgProvider(ctx)
    )) as AttemptRow | null;
    if (!attempt) throw scopedNotFound('Attempt');
    const ownsAttempt = String(attempt.user_id) === String(ctx.viewer.userId);
    const userId = String(attempt.user_id);
    const includeTranscript = args.include_transcript === true;

    // Whether its user is on the STUDENT roster or on staff now.
    const adjusterId =
      attempt.adjusted_emoji && attempt.adjusted_by_id ? String(attempt.adjusted_by_id) : null;
    const commenterId =
      attempt.instructor_comment && attempt.comment_by_id ? String(attempt.comment_by_id) : null;
    const staffNames = [adjusterId, commenterId].filter((id): id is string => id !== null);
    const [[student], [staff], scale, people, openRequest] = await Promise.all([
      ClassmojiService.classroomMembership.findUsersByRole(classroomId, 'STUDENT', {
        user_id: userId,
      }) as Promise<Member[]>,
      ClassmojiService.classroomMembership.findUsersByRoles(classroomId, [...QUIZ_STAFF], {
        user_id: userId,
      }) as Promise<Member[]>,
      loadQuizEmojiScale(classroomId),
      // Who set the adjustment and who wrote the comment: id and name only.
      staffNames.length > 0
        ? getPrisma().user.findMany({
            where: { id: { in: staffNames } },
            select: { id: true, name: true },
          })
        : [],
      ClassmojiService.regradeRequest.findOpenByQuizAttemptId(attempt.id),
    ]);
    const nameOf = (id: string) => people.find(p => p.id === id)?.name ?? null;
    const grade = attemptGrade(attempt, scale);

    const total = Number(attempt.total_duration_ms ?? 0);
    const unfocused = Math.max(0, Number(attempt.unfocused_duration_ms ?? 0));
    const completed = Boolean(attempt.completed_at);
    // The drawer's rule: a `v: 2` record with its results, read field by field below.
    const record2 = completed ? quizEvaluationRecord(attempt.evaluation_json) : null;
    const isChat = attempt.agent_runtime === 'trigger_chat';

    // A legacy attempt's messages: its transcript, and for a completed one
    // with no stored record, its evaluation (the drawer reads it from the
    // closing message). An attempt deleted since the lookup is not found.
    const legacy =
      !isChat && (includeTranscript || (completed && !record2))
        ? legacyMessages(
            (
              await ClassmojiService.quizAttempt
                .findWithMessages(attempt.id)
                .catch((error: unknown) => {
                  // Only the service's not-found error, matched by name; anything else surfaces.
                  if ((error as { name?: unknown } | null)?.name === 'QuizAttemptNotFoundError') {
                    throw scopedNotFound('Attempt');
                  }
                  throw error;
                })
            ).messages ?? []
          )
        : null;

    // The transcript as the drawer reads it: staff reading someone else's
    // attempt get each answer's expected_answer; the caller's own attempt (a
    // preview) is read as its owner reads it.
    let transcript: unknown[] | undefined;
    if (includeTranscript) {
      transcript = isChat
        ? chatTranscript(
            await ClassmojiService.quizChat.loadTranscriptForViewer(
              attempt.id,
              ownsAttempt ? 'student' : 'staff'
            )
          )
        : legacyTranscript(legacy ?? []);
    }

    const evaluation = record2
      ? {
          // The record is JSON checked only for `v: 2`: read field by field.
          source: text(record2.source),
          band: text(record2.evaluation),
          feedback: evaluationFeedback(record2.feedback),
        }
      : completed && legacy
        ? legacyEvaluation(legacy)
        : null;

    // Reading one's own attempt (a preview) is not logged, as on the web.
    if (!ownsAttempt)
      await writeAudit(ctx, {
        resource_type: 'QUIZ_ATTEMPT',
        resource_id: attempt.id,
        action: 'VIEW',
        data: {
          tool: 'get_quiz_attempt',
          quiz_id: quiz.id,
          student_id: userId,
          include_transcript: includeTranscript,
        },
      });

    return ok({
      quiz: { id: quiz.id, name: quiz.name },
      attempt: {
        id: attempt.id,
        student: {
          id: userId,
          login: student?.login ?? staff?.login ?? attempt.user?.login ?? null,
          name: student?.name ?? staff?.name ?? attempt.user?.name ?? null,
        },
        on_roster: Boolean(student),
        is_staff_preview: Boolean(staff) && !student,
        is_former_member: !student && !staff,
        status: completed ? 'COMPLETED' : 'IN_PROGRESS',
        started_at: iso(attempt.started_at),
        completed_at: iso(attempt.completed_at),
        // Grades are a completed attempt's only, as on the review page. The
        // grade is the effective one: an adjustment's own emoji, else the AI's.
        grade_emoji: completed ? grade.effective.emoji : null,
        first_attempt_emoji: completed ? emojiFor(attempt.first_attempt_percentage, scale) : null,
        // The band follows the effective grade (D9).
        band: completed ? (grade.effective.band?.evaluation ?? null) : null,
        adjusted: grade.adjusted,
        original_emoji: completed ? grade.original.emoji : null,
        adjusted_at: adjusterId ? iso(attempt.adjusted_at) : null,
        adjusted_by: adjusterId ? { id: adjusterId, name: nameOf(adjusterId) } : null,
        // The comment's own author and time, apart from the adjustment's.
        instructor_comment: attempt.instructor_comment ?? null,
        comment_at: commenterId ? iso(attempt.comment_at) : null,
        comment_by: commenterId ? { id: commenterId, name: nameOf(commenterId) } : null,
        open_regrade_request_id: openRequest?.id ?? null,
        open_regrade_request: openRequest
          ? {
              id: openRequest.id,
              student_comment: openRequest.student_comment ?? null,
              created_at: iso(openRequest.created_at),
            }
          : null,
        focus_percentage:
          Number.isFinite(total) && total > 0
            ? Math.round((Math.max(total - unfocused, 0) / total) * 100)
            : null,
      },
      // The classroom's scale to pick from, best first (the scale is read in
      // grade order), as the drawer's picker offers it: emoji only (E6).
      emoji_scale: Object.keys(scale),
      // Results are shown for a completed attempt only, as on the review page.
      question_results: completed ? questionResults(attempt, quiz.question_count, scale) : [],
      evaluation,
      ...(transcript ? { transcript } : {}),
    });
  },
};
