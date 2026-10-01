/**
 * Conversation storage and turn admission for quiz attempts served as chat
 * agents (`agent_runtime: 'trigger_chat'`).
 *
 * Admission is the one place a turn starts. Each admitted turn gets a fresh
 * `turn_fence` on the attempt; grading writes (quizGrading.service) carry the
 * fence they were handed and are refused once a newer turn holds the attempt.
 *
 * Messages live in `ai_conversation_messages` as UIMessage parts
 * (`format: 'ui_message_v1'`), upserted by `(conversation_id, ui_message_id)`,
 * never by a global id. Browser-supplied ids are restricted to
 * `[A-Za-z0-9_-]`; the server's own ids contain `:` so the two can never meet.
 *
 * A refused turn throws `QuizChatRefusal` with a `kind` (`temporary`: the
 * session stays open and a later turn may pass; `permanent`: the attempt can
 * take no more turns) and a `code`. Admission does not journal its own
 * refusals: the caller records them with `recordTurnRefused` and chooses the
 * copy the student sees.
 */

import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';
import {
  MAX_STUDENT_TURNS,
  buildTurnStatus,
  buttonActionFor,
  projectTranscript,
  quizStaffVisibility,
  quizVisibility,
  type AttemptProgress,
  type QuizUIMessage,
} from '@classmoji/utils/quiz-agent';
import { quizzesVisible } from './entitlement.service.ts';
import {
  LOCKED_TX_OPTIONS,
  TRIGGER_CHAT_RUNTIME,
  appendEvent,
  attemptQuestionCount,
  completeAtTurnLimit,
  findEvent,
  lockAttempt,
  newFence,
  progressOf,
  toJson,
  type LockedAttempt,
  type Tx,
} from './quizGrading.service.ts';

// ─── Refusals ───────────────────────────────────────────────────────────────

export type QuizChatRefusalCode =
  | 'attempt_not_found'
  | 'wrong_runtime'
  | 'attempt_completed'
  | 'attempt_expired'
  | 'not_a_member'
  | 'quizzes_unavailable'
  | 'invalid_message'
  | 'message_conflict'
  | 'already_started'
  | 'classroom_locked'
  | 'classroom_unpublished'
  | 'quiz_unavailable'
  | 'session_ended'
  | 'reserved_text'
  | 'turn_limit'
  | 'too_fast';

/** A refused turn. The caller picks the copy; `message` is for logs only. */
export class QuizChatRefusal extends Error {
  readonly kind: 'temporary' | 'permanent';
  readonly code: QuizChatRefusalCode;
  constructor(kind: 'temporary' | 'permanent', code: QuizChatRefusalCode) {
    super(`quiz chat turn refused: ${code}`);
    this.name = 'QuizChatRefusal';
    this.kind = kind;
    this.code = code;
  }
}

export const isQuizChatRefusal = (error: unknown): error is QuizChatRefusal =>
  error instanceof QuizChatRefusal ||
  (error instanceof Error &&
    error.name === 'QuizChatRefusal' &&
    'kind' in error &&
    'code' in error);

// ─── Constants ──────────────────────────────────────────────────────────────

/** Longest student message admitted, in characters. */
export const MAX_STUDENT_MESSAGE_CHARS = 10_000;

/**
 * The most student messages (button clicks included) one attempt admits
 * (@classmoji/utils/quiz-agent, shared with the screens that state it). The
 * next one completes the attempt from the results recorded so far, every
 * other question counted as skipped (`completeAtTurnLimit`), and is refused
 * for good (`turn_limit`).
 */
export { MAX_STUDENT_TURNS };

/**
 * The shortest time between two admitted turns of one attempt, measured from
 * the previous admission (its journal row), not from the reply to it. The chat
 * sends nothing while a reply is running and a reply takes longer than this,
 * so only a scripted sender meets it. A message sent sooner is refused for
 * now (`too_fast`); the session stays open.
 */
export const MIN_TURN_INTERVAL_MS = 3_000;

/** Browser message ids. Server-made ids contain `:` and never match. */
export const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** The hidden go-ahead that opens an attempt (today's opening turn). */
export const OPENING_TEXT = 'The student is ready. Begin.';
export const OPENING_MESSAGE_ID = 'server:opening';

/** The roles that may take a quiz, weakest first. */
const ALLOWED_ROLES = ['STUDENT', 'ASSISTANT', 'TEACHER', 'OWNER'] as const;
type AllowedRole = (typeof ALLOWED_ROLES)[number];

/**
 * Whether the classroom's status lets this role take a turn: the webapp's
 * mutation gate, `canMutateClassroom` in packages/auth/src/predicates.ts,
 * restated here because @classmoji/auth depends on this package (a parity
 * test holds the two together). The owner always may; anyone else only while
 * the classroom is ACTIVE (LOCKED and UNPUBLISHED are read-only).
 */
export const classroomAllowsTurn = ({ status, role }: { status: string; role: string }) =>
  role === 'OWNER' || status === 'ACTIVE';

/**
 * The framing only the server writes into the model's context (see the quiz
 * agent's `serverNotice.ts`): a line that opens with SYSTEM NOTICE, SERVER
 * NOTICE or CURRENT STATUS (any case, words apart by spaces or tabs) and goes
 * on with ":" or "(" or nothing, and the marker's opening "[[server-notice"
 * anywhere. The words inside a sentence ("the operating system notices…",
 * `setCurrentStatus(`) are ordinary text. The per-attempt marker, not this
 * check, is what tells the model which text is the server's.
 */
const SERVER_HEADING = /^\s*(?:(?:system|server)\s+notice|current\s+status)\s*(?:[:(]|$)/i;
const SERVER_MARKER_OPENING = /\[\[\s*server[\s_-]*notice/i;

/** Line breaks a reader (or the model) may take as the start of a new line. */
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

/** Invisible characters: format characters, joiners, variation selectors and fillers. */
const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u3164\uFE00-\uFE0F\uFFA0]/gu;

const framesAsServer = (text: string): boolean =>
  SERVER_MARKER_OPENING.test(text) ||
  text.split(LINE_BREAK).some(line => SERVER_HEADING.test(line));

/**
 * Whether a student's message imitates the server's framing. The text is read
 * in NFKC form, twice: with invisible characters removed (one inside a word)
 * and with each replaced by a space (one standing in for the space between
 * the words).
 */
export const containsReservedText = (text: string): boolean => {
  const normalized = text.normalize('NFKC');
  return (
    framesAsServer(normalized.replace(INVISIBLE, '')) ||
    framesAsServer(normalized.replace(INVISIBLE, ' '))
  );
};

/** `ai_conversations.context.runtime`: the transport's cursors and opaque state. */
export type QuizChatRuntimeState = { cursors: unknown; state: unknown };

// ─── Helpers ────────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type StoredMessageRow = {
  ui_message_id: string | null;
  role: string;
  parts: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
};

const toUIMessage = (row: StoredMessageRow): QuizUIMessage =>
  ({
    id: row.ui_message_id ?? '',
    role: row.role === 'ASSISTANT' ? 'assistant' : row.role === 'SYSTEM' ? 'system' : 'user',
    parts: Array.isArray(row.parts) ? row.parts : [],
    ...(isObject(row.metadata) ? { metadata: row.metadata } : {}),
  }) as unknown as QuizUIMessage;

/**
 * A part's readable text: a text part's text, or the feedback an accepted
 * offer_next_step carries (shown as the agent's message). A refused offer's
 * feedback was never shown, so it is not taken. The offer's
 * `expected_answer` is for staff only and is never taken.
 */
const partText = (p: unknown): string | null => {
  if (!isObject(p)) return null;
  if (p.type === 'text') return typeof p.text === 'string' ? p.text : null;
  if (p.type === 'tool-offer_next_step' && p.state === 'output-available') {
    const feedback = isObject(p.input) ? p.input.feedback : undefined;
    return typeof feedback === 'string' && feedback.trim() ? feedback : null;
  }
  return null;
};

const textOf = (parts: unknown): string =>
  (Array.isArray(parts) ? parts : [])
    .map(partText)
    .filter((t): t is string => t !== null)
    .join('\n\n');

/**
 * A `created_at` strictly after the conversation's latest row, so the order
 * rows are read back in is the order they were written. Caller holds the
 * attempt lock, which serializes every writer of this conversation.
 */
const nextCreatedAt = async (tx: Tx, conversationId: string): Promise<Date> => {
  const last = await tx.aIConversationMessage.findFirst({
    where: { conversation_id: conversationId },
    orderBy: { created_at: 'desc' },
    select: { created_at: true },
  });
  return new Date(Math.max(Date.now(), (last?.created_at.getTime() ?? 0) + 1));
};

/** The attempt's conversation, created on first use. Caller holds the attempt lock. */
const ensureConversation = async (tx: Tx, attempt: LockedAttempt): Promise<string> => {
  if (attempt.conversation_id) return attempt.conversation_id;
  const conversation = await tx.aIConversation.create({
    data: { type: 'QUIZ', user_id: attempt.user_id, classroom_id: attempt.quiz.classroom_id },
    select: { id: true },
  });
  await tx.quizAttempt.update({
    where: { id: attempt.id },
    data: { conversation_id: conversation.id },
  });
  attempt.conversation_id = conversation.id;
  return conversation.id;
};

/**
 * Pin the attempt's question count into `agent_config.questionCount` the first
 * time a turn is admitted, so an edit to the quiz mid-attempt does not change
 * how many questions this attempt asks. Merges with what is there (staff
 * previews keep `instructorRepoName`).
 */
const pinnedAgentConfig = (
  attempt: LockedAttempt,
  questionCount: number
): Prisma.InputJsonValue | undefined => {
  const config = isObject(attempt.agent_config) ? attempt.agent_config : {};
  const pinned = config.questionCount;
  if (typeof pinned === 'number' && Number.isInteger(pinned) && pinned > 0) return undefined;
  return toJson({ ...config, questionCount });
};

/** Entitlement read before the row lock: it uses its own connection. */
const preflight = async (attemptId: string) => {
  const attempt = await getPrisma().quizAttempt.findUnique({
    where: { id: attemptId },
    select: { quiz: { select: { classroom_id: true } } },
  });
  if (!attempt) throw new QuizChatRefusal('permanent', 'attempt_not_found');
  let visible: boolean;
  try {
    visible = await quizzesVisible(attempt.quiz.classroom_id);
  } catch {
    // A failed lookup is not a verdict; the next turn tries again.
    throw new QuizChatRefusal('temporary', 'quizzes_unavailable');
  }
  return { visible };
};

/**
 * Whether the attempt's chat grant (written by the webapp's session route
 * before it hands out a session token) still holds: it names the attempt's
 * owner in the quiz's classroom, and an impersonation behind it has not
 * expired (a grant that names one with no expiry does not hold). The web
 * sign-in session itself is not re-checked per turn (plan Q20/Q23).
 */
const grantHolds = (attempt: LockedAttempt, now: number): boolean => {
  const grant = attempt.chat_grant;
  if (!isObject(grant)) return false;
  if (grant.effective_user_id !== attempt.user_id) return false;
  if (grant.classroom_id !== attempt.quiz.classroom_id) return false;
  const impersonation = grant.impersonation;
  if (impersonation === null || impersonation === undefined) return true;
  if (!isObject(impersonation) || typeof impersonation.expires_at !== 'string') return false;
  const expiresAt = Date.parse(impersonation.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > now;
};

/**
 * Per-turn revalidation against the current state, the checks the previous
 * runtime ran on every message:
 * - the attempt exists on this runtime, is not completed and is before its
 *   deadline (permanent);
 * - its owner is still a member of the quiz's classroom with an allowed role
 *   (permanent); with several roles, the strongest one decides below;
 * - the chat grant still holds (temporary: the session route writes a new one);
 * - the classroom's status lets that role act (temporary: LOCKED or
 *   UNPUBLISHED can be lifted);
 * - a student's quiz is not back in DRAFT (temporary). CLOSED stops new
 *   attempts only (quizAttempt.service `createNew`), so an attempt already
 *   under way goes on to its end, as it did on the previous runtime;
 * - quizzes are visible in the classroom (temporary).
 */
const revalidate = async (
  tx: Tx,
  attempt: LockedAttempt | null,
  visible: boolean
): Promise<LockedAttempt> => {
  if (!attempt) throw new QuizChatRefusal('permanent', 'attempt_not_found');
  if (attempt.agent_runtime !== TRIGGER_CHAT_RUNTIME) {
    throw new QuizChatRefusal('permanent', 'wrong_runtime');
  }
  if (attempt.completed_at) throw new QuizChatRefusal('permanent', 'attempt_completed');
  const now = Date.now();
  if (attempt.session_expires_at && attempt.session_expires_at.getTime() <= now) {
    throw new QuizChatRefusal('permanent', 'attempt_expired');
  }
  const memberships = await tx.classroomMembership.findMany({
    where: {
      classroom_id: attempt.quiz.classroom_id,
      user_id: attempt.user_id,
      role: { in: [...ALLOWED_ROLES] },
    },
    select: { role: true },
  });
  if (memberships.length === 0) throw new QuizChatRefusal('permanent', 'not_a_member');
  const role = memberships
    .map(m => m.role as AllowedRole)
    .reduce((a, b) => (ALLOWED_ROLES.indexOf(b) > ALLOWED_ROLES.indexOf(a) ? b : a));
  if (!grantHolds(attempt, now)) throw new QuizChatRefusal('temporary', 'session_ended');
  const status = attempt.quiz.classroom.status;
  if (!classroomAllowsTurn({ status, role })) {
    throw new QuizChatRefusal(
      'temporary',
      status === 'LOCKED' ? 'classroom_locked' : 'classroom_unpublished'
    );
  }
  if (role === 'STUDENT' && attempt.quiz.status === 'DRAFT') {
    throw new QuizChatRefusal('temporary', 'quiz_unavailable');
  }
  if (!visible) throw new QuizChatRefusal('temporary', 'quizzes_unavailable');
  return attempt;
};

/**
 * The student messages the attempt has admitted, read from the journal
 * (`input_admitted` rows of kind `message`; the begin action is not one, a
 * refused message never has a row). Under the attempt row lock it holds
 * across processes. The count never goes down.
 */
const admittedStudentMessages = (
  db: Pick<Tx, 'quizAttemptEvent'>,
  attemptId: string
): Promise<number> =>
  db.quizAttemptEvent.count({
    where: {
      attempt_id: attemptId,
      type: 'input_admitted',
      payload: { path: ['kind'], equals: 'message' },
    },
  });

/** The messages an attempt that has admitted `admitted` can still take, never below 0. */
const messagesLeftAfter = (admitted: number): number => Math.max(MAX_STUDENT_TURNS - admitted, 0);

/**
 * Refuse a new student message sent less than `MIN_TURN_INTERVAL_MS` after
 * the attempt's previous admission (a message or the begin action):
 * `too_fast`, temporary. A refused message is not an admission, so it does
 * not restart the wait. A re-delivered message is not checked: it is not a
 * new turn.
 */
const checkTurnPace = async (tx: Tx, attemptId: string, now: Date): Promise<void> => {
  const previous = await tx.quizAttemptEvent.findFirst({
    where: { attempt_id: attemptId, type: 'input_admitted' },
    orderBy: { seq: 'desc' },
    select: { created_at: true },
  });
  if (previous && now.getTime() - previous.created_at.getTime() < MIN_TURN_INTERVAL_MS) {
    throw new QuizChatRefusal('temporary', 'too_fast');
  }
};

/**
 * The action a new message's text names: a button's text, trimmed and in any
 * case (a typed "Next" is the Next button), whatever came before it (a click
 * after a side question is the same click). A re-delivered message keeps the
 * action journalled when it was first admitted.
 */
const actionFor = buttonActionFor;

// ─── Admission ──────────────────────────────────────────────────────────────

/**
 * An admitted (or re-delivered) student message: the turn's fence and input
 * id, and how many more messages the attempt admits after it.
 */
type AdmittedMessage = {
  status: 'admitted' | 'redelivered';
  fence: string;
  inputMessageId: string;
  action?: 'next' | 'try_again';
  messagesLeft: number;
};

/** What admission's transaction decided: a message, or the turn limit (the attempt completed). */
type AdmissionOutcome = AdmittedMessage | { status: 'turn_limit' };

/**
 * Admit one student message, in one transaction under the attempt row lock:
 * revalidation, then the message checks (well-formed id, non-empty text within
 * the length cap), then:
 *
 * - text reserved for the server (`containsReservedText`) is refused
 *   (`reserved_text`);
 * - the latest admitted id with the same text is a re-delivery: a fresh
 *   fence, no new row (`status: 'redelivered'`), unless its turn already
 *   saved a partial reply (stopped or failed), which is refused;
 * - an id already used with different text, or an older admitted id, is
 *   refused (`message_conflict`);
 * - a new message once the attempt has admitted `MAX_STUDENT_TURNS` completes
 *   the attempt (`completeAtTurnLimit`: the results recorded so far, every
 *   other question skipped) and is refused for good (`turn_limit`); the
 *   completion is committed before the refusal is thrown;
 * - a new message within `MIN_TURN_INTERVAL_MS` of the previous admission is
 *   refused for now (`too_fast`);
 * - otherwise the user row is written with parts `[student text, turn status]`
 *   (`metadata.hiddenPartIndexes: [1]`, and `action` when the text is a
 *   button's), an `input_admitted` journal row, and a fresh fence.
 *
 * Either way it returns `messagesLeft`: the messages the attempt admits after
 * this one, from the journal count (a re-delivery adds nothing to it).
 */
export const admitStudentMessage = async (i: {
  attemptId: string;
  message: { id: string; text: string };
  runId: string;
}): Promise<AdmittedMessage> => {
  const { visible } = await preflight(i.attemptId);
  const outcome = await getPrisma().$transaction(async (tx): Promise<AdmissionOutcome> => {
    const attempt = await revalidate(tx, await lockAttempt(tx, i.attemptId), visible);

    const { id, text } = i.message ?? ({} as { id?: unknown; text?: unknown });
    if (
      typeof id !== 'string' ||
      !CLIENT_MESSAGE_ID_PATTERN.test(id) ||
      typeof text !== 'string' ||
      text.trim().length === 0 ||
      text.length > MAX_STUDENT_MESSAGE_CHARS
    ) {
      throw new QuizChatRefusal('temporary', 'invalid_message');
    }
    if (containsReservedText(text)) throw new QuizChatRefusal('temporary', 'reserved_text');

    const questionCount = attemptQuestionCount(attempt);
    const fence = newFence();
    const now = new Date();
    const agentConfig = pinnedAgentConfig(attempt, questionCount);

    const existing = await findEvent(tx, attempt.id, id);
    if (existing) {
      // Only the latest admitted message can be re-delivered (its turn is the
      // one a retried run is still answering); an older one is a conflict.
      const latest = await tx.quizAttemptEvent.findFirst({
        where: { attempt_id: attempt.id, type: 'input_admitted' },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      if (
        existing.type !== 'input_admitted' ||
        latest?.seq !== existing.seq ||
        !attempt.conversation_id
      ) {
        throw new QuizChatRefusal('temporary', 'message_conflict');
      }
      const row = await tx.aIConversationMessage.findUnique({
        where: {
          conversation_id_ui_message_id: {
            conversation_id: attempt.conversation_id,
            ui_message_id: id,
          },
        },
        select: { parts: true, role: true, created_at: true },
      });
      const stored = Array.isArray(row?.parts) ? row.parts[0] : undefined;
      if (
        !row ||
        row.role !== 'USER' ||
        !isObject(stored) ||
        stored.type !== 'text' ||
        stored.text !== text
      ) {
        throw new QuizChatRefusal('temporary', 'message_conflict');
      }
      // A turn that was stopped or failed after it began its reply (a partial
      // reply is saved) is not run again for the same message: what it
      // committed stands, and the student sends a new message. A turn that
      // wrote nothing yet (a crashed or handed-over run) is run again.
      const reply = await tx.aIConversationMessage.findFirst({
        where: {
          conversation_id: attempt.conversation_id,
          role: 'ASSISTANT',
          created_at: { gt: row.created_at },
        },
        orderBy: { created_at: 'desc' },
        select: { final: true },
      });
      if (reply && !reply.final) throw new QuizChatRefusal('temporary', 'message_conflict');
      await tx.quizAttempt.update({
        where: { id: attempt.id },
        data: {
          turn_fence: fence,
          last_activity: now,
          ...(agentConfig ? { agent_config: agentConfig } : {}),
        },
      });
      const payload = isObject(existing.payload) ? existing.payload : {};
      const action =
        payload.action === 'next' || payload.action === 'try_again' ? payload.action : undefined;
      return {
        status: 'redelivered' as const,
        fence,
        inputMessageId: id,
        ...(action ? { action } : {}),
        messagesLeft: messagesLeftAfter(await admittedStudentMessages(tx, attempt.id)),
      };
    }

    const conversationId = await ensureConversation(tx, attempt);
    const clash = await tx.aIConversationMessage.findUnique({
      where: {
        conversation_id_ui_message_id: { conversation_id: conversationId, ui_message_id: id },
      },
      select: { id: true },
    });
    if (clash) throw new QuizChatRefusal('temporary', 'message_conflict');
    const admittedBefore = await admittedStudentMessages(tx, attempt.id);
    if (admittedBefore >= MAX_STUDENT_TURNS) {
      await completeAtTurnLimit(tx, attempt, i.runId);
      return { status: 'turn_limit' as const };
    }
    await checkTurnPace(tx, attempt.id, now);

    // The status the model reads with this message: progress as of now, with
    // this message's own action (not the previous turn's) as the last action.
    const action = actionFor(text);
    const { lastAction: _previous, ...current } = await progressOf(tx, attempt);
    const progress: AttemptProgress = { ...current, ...(action ? { lastAction: action } : {}) };

    await tx.aIConversationMessage.create({
      data: {
        conversation_id: conversationId,
        role: 'USER',
        content: text,
        parts: toJson([
          { type: 'text', text },
          { type: 'text', text: buildTurnStatus(progress) },
        ]),
        metadata: toJson({ hiddenPartIndexes: [1], ...(action ? { action } : {}) }),
        format: 'ui_message_v1',
        ui_message_id: id,
        final: true,
        provenance: 'student',
        contract_version: attempt.contract_version,
        created_at: await nextCreatedAt(tx, conversationId),
      },
    });
    await appendEvent(tx, attempt, {
      type: 'input_admitted',
      operationId: id,
      fence,
      inputMessageId: id,
      runId: i.runId,
      payload: toJson({ kind: 'message', ...(action ? { action } : {}) }),
    });
    await tx.quizAttempt.update({
      where: { id: attempt.id },
      data: {
        turn_fence: fence,
        last_activity: now,
        ...(agentConfig ? { agent_config: agentConfig } : {}),
      },
    });

    return {
      status: 'admitted' as const,
      fence,
      inputMessageId: id,
      ...(action ? { action } : {}),
      messagesLeft: messagesLeftAfter(admittedBefore + 1),
    };
  }, LOCKED_TX_OPTIONS);
  // Thrown only now, so the completion it follows is committed.
  if (outcome.status === 'turn_limit') throw new QuizChatRefusal('permanent', 'turn_limit');
  return outcome;
};

/**
 * Admit the `begin` action: the same revalidation, refused once a question has
 * been presented, an `input_admitted` journal row
 * (`kind: 'action'`), and a fresh fence. No message is written; the caller
 * stores the hidden opening with `storeHiddenOpening`.
 */
export const admitAction = async (i: {
  attemptId: string;
  runId: string;
}): Promise<{
  fence: string;
}> => {
  const { visible } = await preflight(i.attemptId);
  return getPrisma().$transaction(async (tx): Promise<{ fence: string }> => {
    const attempt = await revalidate(tx, await lockAttempt(tx, i.attemptId), visible);
    if ((attempt.questions_asked ?? 0) > 0) {
      throw new QuizChatRefusal('temporary', 'already_started');
    }

    const fence = newFence();
    const agentConfig = pinnedAgentConfig(attempt, attemptQuestionCount(attempt));
    await appendEvent(tx, attempt, {
      type: 'input_admitted',
      operationId: `action:begin:${fence}`,
      fence,
      inputMessageId: null,
      runId: i.runId,
      payload: toJson({ kind: 'action', action: 'begin' }),
    });
    await tx.quizAttempt.update({
      where: { id: attempt.id },
      data: {
        turn_fence: fence,
        last_activity: new Date(),
        ...(agentConfig ? { agent_config: agentConfig } : {}),
      },
    });
    return { fence };
  }, LOCKED_TX_OPTIONS);
};

/**
 * The hidden opening user message (`metadata.hidden`): the go-ahead text plus
 * the turn status as a hidden second part. Stored once; later calls return the
 * stored message.
 */
export const storeHiddenOpening = (attemptId: string): Promise<QuizUIMessage> =>
  getPrisma().$transaction(async tx => {
    const attempt = await lockAttempt(tx, attemptId);
    if (!attempt) throw new QuizChatRefusal('permanent', 'attempt_not_found');
    if (attempt.agent_runtime !== TRIGGER_CHAT_RUNTIME) {
      throw new QuizChatRefusal('permanent', 'wrong_runtime');
    }
    const conversationId = await ensureConversation(tx, attempt);
    const existing = await tx.aIConversationMessage.findUnique({
      where: {
        conversation_id_ui_message_id: {
          conversation_id: conversationId,
          ui_message_id: OPENING_MESSAGE_ID,
        },
      },
      select: { ui_message_id: true, role: true, parts: true, metadata: true },
    });
    if (existing) return toUIMessage(existing);

    const progress = await progressOf(tx, attempt);
    const parts = [
      { type: 'text', text: OPENING_TEXT },
      { type: 'text', text: buildTurnStatus(progress) },
    ];
    const metadata = { hidden: true, hiddenPartIndexes: [1] };
    await tx.aIConversationMessage.create({
      data: {
        conversation_id: conversationId,
        role: 'USER',
        content: OPENING_TEXT,
        parts: toJson(parts),
        metadata: toJson(metadata),
        format: 'ui_message_v1',
        ui_message_id: OPENING_MESSAGE_ID,
        final: true,
        provenance: 'server_opening',
        contract_version: attempt.contract_version,
        created_at: await nextCreatedAt(tx, conversationId),
      },
    });
    return toUIMessage({
      ui_message_id: OPENING_MESSAGE_ID,
      role: 'USER',
      parts: parts as Prisma.JsonValue,
      metadata: metadata as Prisma.JsonValue,
    });
  }, LOCKED_TX_OPTIONS);

// ─── Assistant messages ─────────────────────────────────────────────────────

/**
 * Upsert an assistant message by `(conversation_id, ui_message_id)`. A partial
 * save (`final: false`) never overwrites a final one, and an id that belongs
 * to a non-assistant row is refused.
 */
export const persistAssistantMessage = async (
  attemptId: string,
  m: QuizUIMessage,
  o: { final: boolean; provenance?: 'model' | 'server_completion' }
): Promise<void> => {
  if (!m || m.role !== 'assistant' || typeof m.id !== 'string' || !m.id || m.id.length > 200) {
    throw new Error('persistAssistantMessage: expected an assistant message with an id');
  }
  await getPrisma().$transaction(async tx => {
    const attempt = await lockAttempt(tx, attemptId);
    if (!attempt) throw new QuizChatRefusal('permanent', 'attempt_not_found');
    if (attempt.agent_runtime !== TRIGGER_CHAT_RUNTIME) {
      throw new QuizChatRefusal('permanent', 'wrong_runtime');
    }
    const conversationId = await ensureConversation(tx, attempt);
    const where = {
      conversation_id_ui_message_id: { conversation_id: conversationId, ui_message_id: m.id },
    };
    const existing = await tx.aIConversationMessage.findUnique({
      where,
      select: { role: true, final: true },
    });
    const parts = toJson(m.parts ?? []);
    const content = textOf(m.parts);
    const metadata = isObject(m.metadata) ? toJson(m.metadata) : undefined;

    if (existing) {
      if (existing.role !== 'ASSISTANT') {
        throw new Error('persistAssistantMessage: message id belongs to another message');
      }
      if (existing.final && !o.final) return;
      await tx.aIConversationMessage.update({
        where,
        data: { parts, content, final: o.final, ...(metadata ? { metadata } : {}) },
      });
      return;
    }
    await tx.aIConversationMessage.create({
      data: {
        conversation_id: conversationId,
        role: 'ASSISTANT',
        content,
        parts,
        ...(metadata ? { metadata } : {}),
        format: 'ui_message_v1',
        ui_message_id: m.id,
        final: o.final,
        provenance: o.provenance ?? 'model',
        contract_version: attempt.contract_version,
        created_at: await nextCreatedAt(tx, conversationId),
      },
    });
  }, LOCKED_TX_OPTIONS);
};

// ─── Reads ──────────────────────────────────────────────────────────────────

/** Tools whose successful call commits to the attempt (a card, a result, the buttons, the evaluation). */
const COMMITTED_TOOL_PARTS = new Set([
  'tool-present_question',
  'tool-record_question_result',
  'tool-offer_next_step',
  'tool-submit_quiz_evaluation',
]);

/** Data parts written from committed state (a result divider, a server evaluation). */
const COMMITTED_DATA_PARTS = new Set(['data-question-result', 'data-evaluation']);

/** A tool call the partial reply keeps: a committing tool's successful call. */
const isCommittedCall = (p: Record<string, unknown>) =>
  typeof p.type === 'string' && COMMITTED_TOOL_PARTS.has(p.type) && p.state === 'output-available';

/** Text the student was shown: a text part that is not blank. */
const isShownText = (p: Record<string, unknown>) =>
  p.type === 'text' && typeof p.text === 'string' && p.text.trim() !== '';

/**
 * Whether the student stopped a partial reply: it carries no notice and no
 * server evaluation. A turn that failed or ran out of time writes a notice
 * (`runQuizTurn` in the tasks package), and a turn the student stopped writes
 * none. The one failed turn without a notice is the server's completion after
 * a model error (a completed attempt takes no more messages), which carries
 * the evaluation it wrote instead.
 */
const stoppedByStudent = (parts: unknown) =>
  !(Array.isArray(parts) ? parts : []).some(
    p => isObject(p) && (p.type === 'data-notice' || p.type === 'data-evaluation')
  );

/**
 * What a partial reply keeps: the successful calls of the committing tools,
 * the data parts written from committed state, and, in each step (the parts
 * from one `step-start` to the next, the blocks the AI SDK turns into one
 * assistant message and its tool results) that holds a kept call, that
 * step's `step-start` and finished reasoning, so the call reaches the model
 * with the thinking that led to it. With `keepText` (a reply the student
 * stopped: `stoppedByStudent`) its text that is not blank stays too, with
 * its step's `step-start`, since that text reached the student: a hint cut
 * short stays on screen and in the model's history, and a Try again whose
 * reply had text counts as a hint (`replyShowsHint`). Without it (a failed
 * turn) the text is dropped. Other reasoning, failed or unfinished calls and
 * notices are dropped either way.
 */
const partialParts = (parts: unknown, keepText: boolean): unknown[] => {
  const steps: Record<string, unknown>[][] = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!isObject(p)) continue;
    if (p.type === 'step-start' || steps.length === 0) steps.push([]);
    steps[steps.length - 1].push(p);
  }
  return steps.flatMap(step => {
    const callKept = step.some(isCommittedCall);
    const textKept = keepText && step.some(isShownText);
    return step.filter(
      p =>
        isCommittedCall(p) ||
        (typeof p.type === 'string' && COMMITTED_DATA_PARTS.has(p.type)) ||
        (textKept && isShownText(p)) ||
        ((callKept || textKept) && p.type === 'step-start') ||
        (callKept && p.type === 'reasoning' && p.state !== 'streaming')
    );
  });
};

/**
 * The attempt's conversation as the model sees it: every UIMessage row in
 * order, with full parts (hidden ones included). A partial assistant message
 * (`final: false`, left by a turn that was stopped or failed) keeps what its
 * turn committed (`partialParts`): a card, a result, the buttons or the
 * evaluation the student was shown stay in the model's history (with the
 * reasoning of the step that made each call) and in the transcript. Its text
 * stays too when the student stopped the turn (`stoppedByStudent`), and is
 * dropped when the turn failed. A partial message left with nothing is left
 * out.
 */
export const loadCanonicalMessages = async (attemptId: string): Promise<QuizUIMessage[]> => {
  const attempt = await getPrisma().quizAttempt.findUnique({
    where: { id: attemptId },
    select: { conversation_id: true },
  });
  if (!attempt?.conversation_id) return [];
  const rows = await getPrisma().aIConversationMessage.findMany({
    where: {
      conversation_id: attempt.conversation_id,
      format: 'ui_message_v1',
      ui_message_id: { not: null },
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: { ui_message_id: true, role: true, parts: true, metadata: true, final: true },
  });
  const messages: QuizUIMessage[] = [];
  for (const row of rows) {
    if (row.role === 'ASSISTANT' && !row.final) {
      const parts = partialParts(row.parts, stoppedByStudent(row.parts));
      if (parts.length > 0)
        messages.push(toUIMessage({ ...row, parts: parts as Prisma.JsonValue }));
      continue;
    }
    messages.push(toUIMessage(row));
  }
  return messages;
};

/**
 * Who reads a transcript. `student`: the attempt's owner (staff previewing
 * included), who drives its chat and so gets what the live stream showed.
 * `staff`: staff reading someone else's attempt, who also see the answer each
 * offer_next_step call stated for staff (`expected_answer`).
 */
export type TranscriptViewer = 'student' | 'staff';

/** The transcript a viewer gets: the canonical messages, projected for them. */
export const loadTranscriptForViewer = async (
  attemptId: string,
  viewer: TranscriptViewer = 'student'
): Promise<QuizUIMessage[]> =>
  projectTranscript(
    await loadCanonicalMessages(attemptId),
    viewer === 'staff' ? quizStaffVisibility : quizVisibility
  ) as QuizUIMessage[];

/**
 * What the attempt drawer states about the message limit: the messages the
 * attempt still admits (`MAX_STUDENT_TURNS` less the admitted ones, never
 * below 0), and `endedBy: 'turn_limit'` when the server submitted the attempt
 * at the limit (its `evaluation_completed` journal row says so), else null.
 * Two reads, no lock: both only ever move one way.
 */
export const messageLimitOf = async (
  attemptId: string
): Promise<{ messagesLeft: number; endedBy: 'turn_limit' | null }> => {
  const prisma = getPrisma();
  const [admitted, endedAtLimit] = await Promise.all([
    admittedStudentMessages(prisma, attemptId),
    prisma.quizAttemptEvent.findFirst({
      where: {
        attempt_id: attemptId,
        type: 'evaluation_completed',
        payload: { path: ['ended_by'], equals: 'turn_limit' },
      },
      select: { id: true },
    }),
  ]);
  return { messagesLeft: messagesLeftAfter(admitted), endedBy: endedAtLimit ? 'turn_limit' : null };
};

/** `ai_conversations.context.runtime`, or null before the first save. */
export const readRuntimeState = async (attemptId: string): Promise<QuizChatRuntimeState | null> => {
  const attempt = await getPrisma().quizAttempt.findUnique({
    where: { id: attemptId },
    select: { conversation: { select: { context: true } } },
  });
  const context = attempt?.conversation?.context;
  const runtime = isObject(context) ? context.runtime : undefined;
  return isObject(runtime) ? (runtime as QuizChatRuntimeState) : null;
};

/** Replace `ai_conversations.context.runtime`, keeping every other context key. */
export const writeRuntimeState = async (
  attemptId: string,
  v: QuizChatRuntimeState
): Promise<void> => {
  await getPrisma().$transaction(async tx => {
    const attempt = await lockAttempt(tx, attemptId);
    if (!attempt) throw new QuizChatRefusal('permanent', 'attempt_not_found');
    const conversationId = await ensureConversation(tx, attempt);
    const value = JSON.stringify(v ?? null);
    await tx.$executeRaw`
      UPDATE ai_conversations
      SET context = jsonb_set(COALESCE(context, '{}'::jsonb), '{runtime}', ${value}::jsonb, true)
      WHERE id = ${conversationId}`;
  }, LOCKED_TX_OPTIONS);
};

// ─── Journal ────────────────────────────────────────────────────────────────

/** The shortest time between two `turn_refused` rows with the same code for one attempt. */
export const REFUSAL_JOURNAL_INTERVAL_MS = 60_000;

/**
 * Journal a refused turn (`turn_refused`, payload `{ code }` only), at most
 * once per code per attempt within `REFUSAL_JOURNAL_INTERVAL_MS`: a refusal
 * repeated sooner (messages sent in a burst) adds no row. No-op for an
 * unknown attempt.
 */
export const recordTurnRefused = async (
  attemptId: string,
  code: string,
  runId: string
): Promise<void> => {
  const stored = String(code).slice(0, 64);
  await getPrisma().$transaction(async tx => {
    const attempt = await lockAttempt(tx, attemptId);
    if (!attempt) return;
    const recent = await tx.quizAttemptEvent.findFirst({
      where: {
        attempt_id: attempt.id,
        type: 'turn_refused',
        payload: { path: ['code'], equals: stored },
        created_at: { gt: new Date(Date.now() - REFUSAL_JOURNAL_INTERVAL_MS) },
      },
      select: { id: true },
    });
    if (recent) return;
    await appendEvent(tx, attempt, {
      type: 'turn_refused',
      operationId: `refused:${newFence()}`,
      fence: attempt.turn_fence,
      runId,
      payload: toJson({ code: stored }),
    });
  }, LOCKED_TX_OPTIONS);
};
