import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRevalidator } from 'react-router';
import { Avatar, Button, Skeleton, Space, Typography } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { useChat } from '@ai-sdk/react';
import type { ChatTransport, UIMessageChunk } from 'ai';
import { useChatActions, useTriggerChatTransport } from '@trigger.dev/sdk/chat/react';
import type { ChatSessionPersistedState } from '@trigger.dev/sdk/chat';
import {
  MESSAGES_LEFT_NOTICE_AT,
  QUIZ_AGENT_ERROR_COPY,
  QUIZ_FAILURE_COPY,
  QUIZ_MESSAGE_LIMIT_COPY,
  QUIZ_REFUSAL_COPY,
  QUIZ_REFUSAL_COPY_BY_KIND,
  buttonActionFor,
  replyShowsHint,
  type NextStepAction,
  type QuizEvaluationRecordV2,
  type QuizUIMessage,
} from '@classmoji/utils/quiz-agent';
import { useDarkMode } from '~/hooks';
import Emoji from '~/components/ui/display/Emoji';
import TypingIndicator from '~/components/ui/feedback/TypingIndicator';
import ChatEditor from '../../../routes/student.$class.quizzes/ChatEditor';
import QuestionCard from './QuestionCard';
import ProgressDivider from './ProgressDivider';
import NextStepButtons from './NextStepButtons';
import QuizResults, { type ResultsFocusMetrics } from './QuizResults';
import StepList, { onlyCourseSteps, type QuizStep } from './StepList';
import { useQuizFocusMetrics } from './useQuizFocusMetrics';

const { Text } = Typography;

/**
 * QuizChat — the attempt drawer's body for an attempt on the chat runtime
 * (`agent_runtime: 'trigger_chat'`).
 *
 * The attempt's owner, on an attempt that is not complete, gets the live chat:
 * `useChat` over the Trigger chat transport, whose session token comes from
 * /api/quiz-chat/session. Everyone else (staff reading a student's attempt, a
 * completed attempt) gets the saved transcript the loader projected, with no
 * transport, so no session is ever asked for on someone else's attempt. Which
 * of the two is decided once, when the drawer mounts, so the view does not
 * swap under a reply that is still streaming when the loader refreshes.
 *
 * Parts render by type (the design's §2.4): text as markdown, the question
 * card from the server-accepted `present_question` output, the per-question
 * marker from `data-question-result`, `offer_next_step` as the feedback on an
 * answer (its input, shown as the agent's message once it is in; for staff
 * reading someone else's attempt, the expected answer under it) then the
 * lead-in line and the Try again / Next buttons (its output), the results
 * panel from the stored evaluation record. A hint (the reply to a Try again
 * click) ends with the Next button alone, with no lead-in, unlike the legacy
 * chat, which showed Try again and Next after every such reply (Tim's
 * decision; `buttonSetsOf`). Any other part (reasoning, internal
 * tools, unknown data) renders nothing. Parts render in arrival order, except
 * that a question's marker renders above a later question's card in the same
 * message (`displayOrder`). As in the legacy chat, a marker is not inside a
 * bubble: it gets its own row with its own
 * avatar, and what follows it (the files read, the next card) starts a new
 * bubble (`messageBlocks`). The rest follows the legacy chat's flow too: the
 * opening reply's welcome is a bubble of its own, above the files read and
 * question 1; text after a question card is not shown; a card waits for the
 * marker of the question before it; the activity line ("Thinking...",
 * "Exploring code...", "Looking things up…") stays up until a card, the
 * buttons or a notice arrive;
 * the evaluation's closing line sits above the results panel.
 *
 * The message limit: once `MESSAGES_LEFT_NOTICE_AT` or fewer messages are
 * left, a muted line under the latest reply counts them down, from the
 * server's count (the loader's, then each reply's `data-messages-left`); an
 * attempt the server submitted at the limit says so above its results.
 */

export type QuizChatStatus = 'streaming' | 'ready' | 'complete';

type QuizPart = QuizUIMessage['parts'][number];

/** The attempt fields QuizChat reads (see ~/utils/quizPayloads, attemptDrawerView). */
export interface QuizChatAttempt {
  id: string;
  completed_at?: Date | string | null;
  total_duration_ms?: number | null;
  unfocused_duration_ms?: number | null;
  evaluation_json?: QuizEvaluationRecordV2 | null;
  /** `turn_limit`: the server submitted the attempt at its message limit. */
  ended_by?: 'turn_limit' | null;
}

export interface QuizChatProps {
  quiz: { id: string; question_count?: number | null };
  attempt: QuizChatAttempt;
  /** The projected transcript from the loader. */
  transcript?: QuizUIMessage[] | null;
  /** The viewer is the attempt's owner (decided by the loader). */
  viewerOwnsAttempt?: boolean;
  /**
   * The attempt's chat has begun: its opening was admitted, whether or not
   * its reply is saved yet (the loader found stored rows).
   */
  chatStarted?: boolean;
  /** When the attempt last admitted a turn (see `ChatActivity`). */
  chatActivity?: ChatActivity | null;
  /**
   * How many more student messages the attempt admits, counted by the server
   * when the loader read it; null when unknown or the attempt is complete.
   */
  messagesLeft?: number | null;
  readOnly?: boolean;
  userLogin?: string | null;
  userImage?: string | null;
  focusMetrics?: ResultsFocusMetrics | null;
  isVisible?: boolean;
}

/**
 * When the attempt last admitted a turn or recorded progress
 * (`attempt.last_activity`), and when the loader read it, both by the
 * server's clock: timestamps only.
 */
export interface ChatActivity {
  lastAt: string | null;
  readAt: string;
}

/**
 * How long after it was admitted an opening can still be running: the task's
 * turn deadline (four minutes), with a margin. By then it has saved its reply
 * or a notice.
 */
export const OPENING_TURN_MS = 240_000 + 30_000;

/**
 * Whether an opening admitted by the time the loader read the attempt has
 * had longer than a turn can run. Measured on the server's clock alone, so a
 * browser whose clock is off cannot take a running opening for a lost one.
 */
export const openingOverdue = (activity: ChatActivity | null | undefined): boolean => {
  if (!activity?.lastAt) return false;
  const age = Date.parse(activity.readAt) - Date.parse(activity.lastAt);
  return Number.isFinite(age) && age > OPENING_TURN_MS;
};

// ---------------------------------------------------------------------------
// Fixed copy
// ---------------------------------------------------------------------------

export const REPLY_FAILED_LINE: string = QUIZ_FAILURE_COPY.reply_failed;
const START_FAILED_LINE = "The quiz couldn't start. Please try again.";

/** What a `data-notice` part says, by its code. */
export const NOTICE_COPY: Record<string, string> = {
  turn_stopped: QUIZ_FAILURE_COPY.turn_stopped,
  reply_failed: REPLY_FAILED_LINE,
  source_material_unavailable:
    "This quiz's source material isn't available yet. Ask your instructor.",
  refused: QUIZ_FAILURE_COPY.refused,
};

/**
 * The platform's refusals for a class its owner has locked or unpublished, by
 * the code they carry (`error`). The session route answers with them as
 * thrown by the classroom-status gate (@classmoji/auth,
 * assertClassroomMutationAllowed), whose copy these repeat: that module is
 * server-only.
 */
export const CLASSROOM_STATUS_COPY: Readonly<Record<string, string>> = {
  CLASSROOM_LOCKED: 'This class is in read-only mode. The owner has locked it.',
  CLASSROOM_UNPUBLISHED: 'This class has been unpublished by the owner.',
};

/**
 * Lines the server writes as fixed copy for students (api.quiz, the session
 * route, the task's sanitized errors). An error whose text is one of these is
 * shown as is; any other error text (a network failure, a library message, the
 * AI SDK's own "An error occurred.") is replaced by REPLY_FAILED_LINE. The
 * task's lines come from the module its sanitizer writes them from, so every
 * refusal code there (a new one included) is shown with its own line.
 */
export const FIXED_ERROR_COPY: ReadonlySet<string> = new Set<string>([
  REPLY_FAILED_LINE,
  START_FAILED_LINE,
  'Something went wrong. Please try again.',
  "Your first question couldn't be prepared. Send any message to try again.",
  "Quizzes aren't available in this class.",
  "This quiz isn't finished yet. Send a message to continue.",
  'This quiz is already complete.',
  "This quiz's source material isn't available yet. Ask your instructor.",
  'Reload the page to continue this quiz.',
  'This attempt can no longer be continued.',
  "This quiz attempt isn't yours.",
  'Quiz attempt not found.',
  "This quiz can't continue right now.",
  ...Object.values(CLASSROOM_STATUS_COPY),
  // The Trigger task's own refusals and failures (packages/tasks, sanitize.ts).
  ...QUIZ_AGENT_ERROR_COPY,
  ...Object.values(NOTICE_COPY),
]);

export const errorLineFor = (error: unknown): string => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return FIXED_ERROR_COPY.has(message) ? message : REPLY_FAILED_LINE;
};

// ---------------------------------------------------------------------------
// Session route and per-tab session state
// ---------------------------------------------------------------------------

/** A refusal from /api/quiz-chat/session, carrying the route's fixed copy. */
export class QuizChatSessionError extends Error {
  code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'QuizChatSessionError';
    this.code = code;
  }
}

/**
 * The session route's refusals that hold for good: the attempt is complete,
 * past its deadline, or on another runtime.
 */
const PERMANENT_SESSION_CODES: ReadonlySet<string> = new Set([
  'QUIZ_COMPLETE',
  'QUIZ_ATTEMPT_EXPIRED',
  'QUIZ_RUNTIME_MISMATCH',
]);

/** The error is the session route refusing the attempt for good. */
export const isPermanentSessionRefusal = (error: unknown) =>
  error instanceof QuizChatSessionError &&
  error.code !== null &&
  PERMANENT_SESSION_CODES.has(error.code);

/**
 * The task's lines for a message refused for good: the attempt is complete
 * (at its message limit, the refusal completed it), past its deadline, gone,
 * or no longer the student's. The task closes the session with each of them,
 * but the close rides on the record after the error, which this tab may never
 * read, so the line itself says so.
 */
const ENDED_LINES: ReadonlySet<string> = new Set([
  QUIZ_REFUSAL_COPY.turn_limit,
  QUIZ_REFUSAL_COPY.attempt_completed,
  QUIZ_REFUSAL_COPY_BY_KIND.permanent,
]);

/** The error says the attempt can take no more messages. */
export const isRefusalForGood = (error: unknown) =>
  isPermanentSessionRefusal(error) || ENDED_LINES.has(errorLineFor(error));

/**
 * The task's lines for a message it refused before admitting it, for now:
 * nothing of it was saved, and the student can send it again later. The
 * session route's refusals are left out: one can answer a token refresh after
 * the message went in.
 */
const NOT_ADMITTED_LINES: ReadonlySet<string> = new Set([
  QUIZ_REFUSAL_COPY.too_fast,
  QUIZ_REFUSAL_COPY.session_ended,
  QUIZ_REFUSAL_COPY.classroom_locked,
  QUIZ_REFUSAL_COPY.classroom_unpublished,
  QUIZ_REFUSAL_COPY.quiz_unavailable,
  QUIZ_REFUSAL_COPY.quizzes_unavailable,
  QUIZ_REFUSAL_COPY_BY_KIND.temporary,
]);

/** The error is the task refusing a message before admitting it. */
export const isRefusedBeforeAdmission = (error: unknown) =>
  !(error instanceof QuizChatSessionError) && NOT_ADMITTED_LINES.has(errorLineFor(error));

/**
 * The session route's answer for the attempt (start and refresh alike): a
 * token, and the reply stream's resume cursor when the session has one (the
 * position just past the last finished reply).
 */
export const requestSession = async (
  attemptId: string
): Promise<{ publicAccessToken: string; resumeCursor: string | null }> => {
  const response = await fetch('/api/quiz-chat/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ attemptId }),
  });
  const body = (await response.json().catch(() => null)) as {
    publicAccessToken?: unknown;
    resumeCursor?: unknown;
    message?: unknown;
    code?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || typeof body?.publicAccessToken !== 'string') {
    // The route's own refusals carry `code`; the platform's classroom-status
    // refusals carry theirs as `error`.
    const code =
      typeof body?.code === 'string'
        ? body.code
        : typeof body?.error === 'string'
          ? body.error
          : null;
    const message =
      typeof body?.message === 'string' && FIXED_ERROR_COPY.has(body.message)
        ? body.message
        : ((code && CLASSROOM_STATUS_COPY[code]) ?? START_FAILED_LINE);
    throw new QuizChatSessionError(message, code);
  }
  const cursor = body.resumeCursor;
  return {
    publicAccessToken: body.publicAccessToken,
    resumeCursor: typeof cursor === 'string' && /^\d+$/.test(cursor) ? cursor : null,
  };
};

/** A session token for the attempt, from the session route. */
export const requestSessionToken = async (attemptId: string): Promise<string> =>
  (await requestSession(attemptId)).publicAccessToken;

/**
 * Readies the transport to read an opening reply another tab or window
 * started: a token from the session route, and the attempt's session state
 * marked as mid-reply with no cursor, so the reply stream is read from its
 * start. False, with nothing changed, when the route says a reply has already
 * finished: the opening is saved, and the transcript is the place to read it.
 */
export const readyToJoinOpening = async (
  transport: { setSession: (chatId: string, session: ChatSessionPersistedState) => void },
  chatId: string
): Promise<boolean> => {
  const { publicAccessToken, resumeCursor } = await requestSession(chatId);
  if (resumeCursor) return false;
  transport.setSession(chatId, { publicAccessToken, isStreaming: true });
  return true;
};

/** Session state is kept per tab (sessionStorage), keyed by attempt. */
const sessionKey = (attemptId: string) => `classmoji:quiz-chat-session:${attemptId}`;

export const readPersistedSession = (attemptId: string): ChatSessionPersistedState | undefined => {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.sessionStorage.getItem(sessionKey(attemptId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as ChatSessionPersistedState | null;
    return parsed && typeof parsed.publicAccessToken === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const persistSession = (attemptId: string, state: ChatSessionPersistedState | null) => {
  if (typeof window === 'undefined') return;
  try {
    if (state) window.sessionStorage.setItem(sessionKey(attemptId), JSON.stringify(state));
    else window.sessionStorage.removeItem(sessionKey(attemptId));
  } catch {
    // Storage can be unavailable (private mode, quota); the chat works without it.
  }
};

// ---------------------------------------------------------------------------
// Replies the transcript already shows
// ---------------------------------------------------------------------------

/**
 * The reply stream without the replies the chat already holds. The session's
 * reply stream keeps about the last reply, and the transport reads it from a
 * resume cursor; a tab without a good cursor (no session state stored in this
 * tab, a stale copy of it, a session the transport had to create again, or a
 * reload before the stored cursor was written) reads that last reply again
 * ahead of the new one. useChat would add it as another message with the same
 * id, then fold its parts into the new reply, so the previous turn showed up
 * twice or three times, and new text after its card was hidden. Every reply
 * opens with a `start` chunk naming its message id and closes with `finish`:
 * from a `start` whose id is already in the chat through its `finish` (or up
 * to the next `start`, for a reply cut short), the chunks are dropped.
 * Anything else passes as it is, a new turn's error before its own `start`
 * included.
 */
export const dropReplayedMessages = (
  stream: ReadableStream<UIMessageChunk>,
  knownIds: ReadonlySet<string>
): ReadableStream<UIMessageChunk> => {
  if (knownIds.size === 0) return stream;
  let replaying = false;
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'start') {
          replaying = typeof chunk.messageId === 'string' && knownIds.has(chunk.messageId);
        }
        if (!replaying) controller.enqueue(chunk);
        else if (chunk.type === 'finish') replaying = false;
      },
    })
  );
};

/**
 * The transport as useChat sees it: every reply stream passes through
 * `dropReplayedMessages`, against the messages sent with the request (a new
 * message) or the chat's messages as they are now (a resumed reply).
 */
export const withoutReplayedMessages = (
  transport: ChatTransport<QuizUIMessage>,
  currentMessages: () => readonly QuizUIMessage[]
): ChatTransport<QuizUIMessage> => {
  const idsOf = (messages: readonly QuizUIMessage[]) => new Set(messages.map(m => m.id));
  return {
    sendMessages: async options =>
      dropReplayedMessages(await transport.sendMessages(options), idsOf(options.messages)),
    reconnectToStream: async options => {
      const stream = await transport.reconnectToStream(options);
      return stream ? dropReplayedMessages(stream, idsOf(currentMessages())) : stream;
    },
  };
};

// ---------------------------------------------------------------------------
// Transcript helpers
// ---------------------------------------------------------------------------

const hiddenIndexes = (message: QuizUIMessage) =>
  new Set(message.metadata?.hiddenPartIndexes ?? []);

/** The parts of a message a viewer may see (the projection already removed the rest). */
const visibleParts = (message: QuizUIMessage): QuizPart[] => {
  if (message.metadata?.hidden) return [];
  const hidden = hiddenIndexes(message);
  return message.parts.filter((_, i) => !hidden.has(i));
};

const isEvaluationPart = (part: QuizPart) =>
  (part.type === 'tool-submit_quiz_evaluation' && part.state === 'output-available') ||
  part.type === 'data-evaluation';

/** Whether any message carries the attempt's evaluation. */
export const hasEvaluation = (messages: readonly QuizUIMessage[]) =>
  messages.some(m => visibleParts(m).some(isEvaluationPart));

const stepsOf = (parts: QuizPart[]): QuizStep[] =>
  parts.flatMap(part => (part.type === 'data-step' ? [part.data] : []));

/**
 * A tool call that failed or was refused, of any tool. Never shown, live or
 * saved: the model retries within its turn, and the error text the stream and
 * the saved message carry is the AI SDK's generic mask ("An error occurred."),
 * which says nothing to a student.
 */
export const isFailedToolPart = (part: QuizPart) => {
  const { type, state } = part as { type: string; state?: unknown };
  return (
    (type.startsWith('tool-') || type === 'dynamic-tool') &&
    (state === 'output-error' || state === 'output-denied')
  );
};

/**
 * The feedback on the answer an offer_next_step call carries in its input,
 * when it has some. A student's copy has no input until the call is complete
 * (its `expected_answer` is cut, and with it the streamed input), and a part
 * saved before the feedback moved into the call (844f84bb) has none.
 *
 * Keep the handling of that older part. Staging and production both ran the
 * chat quiz around 844f84bb with real previews, so stored attempts can hold
 * offer parts without feedback, and their transcripts must still render: the
 * text before the part is the feedback, and the part brings only its buttons.
 */
const feedbackOf = (input: unknown): string | null => {
  const feedback = (input as { feedback?: unknown } | undefined)?.feedback;
  return typeof feedback === 'string' && feedback.trim() ? feedback : null;
};

/**
 * The correct answer an offer_next_step call stated for staff, when the
 * transcript has it: only staff reading someone else's attempt get it (the
 * projection cuts it for everyone else, live and saved).
 */
const expectedAnswerOf = (input: unknown): string | null => {
  const answer = (input as { expected_answer?: unknown } | undefined)?.expected_answer;
  return typeof answer === 'string' && answer.trim() ? answer.trim() : null;
};

/** The button a student message used: stored with it by admission, or named by its text. */
const buttonActionOf = (message: QuizUIMessage) =>
  message.metadata?.action ??
  buttonActionFor(
    visibleParts(message)
      .flatMap(part => (part.type === 'text' ? [part.text] : []))
      .join('\n')
  );

/** The buttons a hint ends with: Next alone, so the student answers or moves on. */
export const HINT_ACTIONS: readonly NextStepAction[] = ['next'];

/**
 * Whether a reply moves the quiz on: it brings buttons of its own (an
 * accepted offer), the card of a later question, a question result or the
 * evaluation. The current question's card shown again (`currentQuestion` is
 * the highest card number before this reply) does not count: it brings no
 * buttons, so the clicked set is decided as for any other reply (the server
 * refuses the card again in a Try again turn; a saved Try again reply that is
 * only that card shows no hint, and gives the set back). A refused call
 * counts for nothing: the server refuses offer_next_step in a Try again turn,
 * so a hint often carries a refused offer ahead of its text.
 */
const movesOn = (message: QuizUIMessage, currentQuestion: number) =>
  visibleParts(message).some(
    part =>
      !isFailedToolPart(part) &&
      ((part.type === 'tool-offer_next_step' && part.state === 'output-available') ||
        (part.type === 'tool-present_question' &&
          part.state === 'output-available' &&
          part.output.question_number > currentQuestion) ||
        part.type === 'data-question-result' ||
        isEvaluationPart(part))
  );

/**
 * Whether the reply to a Next click did not get through: it carries a notice
 * (it couldn't be finished, and asks for the message again), or it shows
 * nothing in a bubble (only the files read, only refused calls, or nothing
 * yet while it streams). The reply to a Try again click is judged by
 * `replyShowsHint` instead (`buttonSetsOf`).
 */
const fellThrough = (message: QuizUIMessage) => {
  const parts = visibleParts(message);
  return (
    parts.some(part => part.type === 'data-notice') ||
    !parts.some(part => part.type !== 'data-step' && rendersInBubble(part, false))
  );
};

/**
 * A set of buttons that can still be clicked: an offer's Try again / Next,
 * as its message's position in `messages` and its index in that message's
 * visible parts, or the Next alone at the end of a hint (`hint`).
 */
export type LiveButtons = { message: number; part: number } | { message: number; hint: true };

/**
 * The button sets of a transcript, from the messages alone, so a reload shows
 * what the live chat showed: `hintReplies`, the positions of the replies that
 * end with the Next button alone, and `live`, the one set that can still be
 * clicked, or null when none can.
 *
 * An offer (offer_next_step) brings its own set. So does a hint: the first
 * assistant reply after a Try again click (the stored action, or text the
 * server takes as the click: `buttonActionFor`), when it shows a hint and
 * does not move the quiz on (`replyShowsHint`, `movesOn`), ends with Next
 * alone.
 * The student answers the hint, which brings feedback and a new offer, or
 * moves on; a hint never ends with Try again, so hints never chain from the
 * buttons (Tim's decision).
 *
 * The latest set stays live until something supersedes it: one of its
 * buttons is clicked (or its text typed), a newer set arrives, the card of a
 * later question or a question's result arrives, or the evaluation does.
 * Anything else leaves it live: a side question or an argument the student
 * types (the reply to it brings no buttons, so these stay the way on), the
 * current question's card shown again on request, or an earlier question's
 * revised result. A click whose reply did not get through gives its set back,
 * so the click can be made again, as the reply's notice asks: a Next click's
 * reply that `fellThrough`, and a Try again click's reply that shows no hint.
 *
 * Which Try again replies show a hint is `replyShowsHint`: text that is not
 * blank and no notice, finished or stopped part way. The server counts a
 * Try again click toward the answer's hints by the same predicate
 * (`floorHintsAtTryAgain` in quizGrading.service), so a click that is counted
 * never gives Try again back, and one that is not always does (unless its
 * reply moved the quiz on, which decides the buttons itself).
 */
export const buttonSetsOf = (
  messages: readonly QuizUIMessage[]
): { live: LiveButtons | null; hintReplies: ReadonlySet<number> } => {
  let live: LiveButtons | null = null;
  let lastCard = 0;
  // The button the latest student message used, and the set it used up,
  // until the next assistant message answers it.
  let clicked: NextStepAction | undefined;
  let usedUp: LiveButtons | null = null;
  const hintReplies = new Set<number>();
  messages.forEach((message, position) => {
    if (message.metadata?.hidden) return;
    if (message.role === 'user') {
      clicked = buttonActionOf(message);
      usedUp = clicked ? live : null;
      if (clicked) live = null;
      return;
    }
    if (message.role !== 'assistant') return;
    const answers = clicked;
    const given = usedUp;
    clicked = undefined;
    usedUp = null;
    // The question open when this reply began: its own cards come after.
    const currentQuestion = lastCard;
    visibleParts(message).forEach((part, index) => {
      if (isFailedToolPart(part)) return;
      if (part.type === 'tool-offer_next_step' && part.state === 'output-available') {
        live = { message: position, part: index };
      } else if (part.type === 'tool-present_question' && part.state === 'output-available') {
        if (part.output.question_number > lastCard) live = null;
        lastCard = Math.max(lastCard, part.output.question_number);
      } else if (
        (part.type === 'data-question-result' && !part.data.revised) ||
        isEvaluationPart(part)
      ) {
        live = null;
      }
    });
    if (!answers || movesOn(message, currentQuestion)) return;
    if (answers === 'try_again') {
      // The server's rule for counting the click as a hint, applied to what
      // this viewer sees (an assistant reply has no hidden parts).
      if (replyShowsHint(visibleParts(message))) {
        hintReplies.add(position);
        live = { message: position, hint: true };
      } else {
        live = given;
      }
    } else if (fellThrough(message)) {
      live = given;
    }
  });
  return { live, hintReplies };
};

/** The one set of buttons that can still be clicked (`buttonSetsOf`), or null. */
export const liveButtonsOf = (messages: readonly QuizUIMessage[]): LiveButtons | null =>
  buttonSetsOf(messages).live;

/**
 * The chat without a button click the task refused before admitting it
 * (`isRefusedBeforeAdmission`): the last student message, when it names a
 * button, and the empty reply the stream may have opened for it. The server
 * saved neither, so without them the chat shows what a reload would, and the
 * click's buttons are live again. Null when the chat does not end that way (a
 * typed message stays: its text is the student's).
 */
export const withoutRefusedClick = (messages: readonly QuizUIMessage[]): QuizUIMessage[] | null => {
  let end = messages.length;
  while (
    end > 0 &&
    messages[end - 1].role === 'assistant' &&
    messages[end - 1].parts.length === 0
  ) {
    end--;
  }
  const last = messages[end - 1];
  if (!last || last.role !== 'user' || !buttonActionOf(last)) return null;
  return messages.slice(0, end - 1);
};

/**
 * A part of the assistant's reply that renders: inside a bubble, or (a
 * question's marker) in its own row. A question card still arriving shows its
 * placeholder only while its message is streaming, so a turn that ended before
 * the card leaves no empty card behind, and only in a bubble that already
 * shows something (`messageBlocks`). With `streaming` false this is the set of
 * settled parts. An offer's feedback renders as soon as its input has some
 * (a student's copy has none until the call is complete: see `feedbackOf`);
 * its buttons only once the call is done (`AssistantPart`).
 */
const rendersInBubble = (part: QuizPart, streaming: boolean) => {
  if (isFailedToolPart(part)) return false;
  switch (part.type) {
    case 'text':
      return part.text.trim().length > 0;
    case 'data-question-result':
    case 'data-notice':
      return true;
    case 'tool-present_question':
      return part.state === 'output-available' || streaming;
    case 'tool-offer_next_step':
      return part.state === 'output-available' || feedbackOf(part.input) !== null;
    default:
      return false;
  }
};

/**
 * The question number of a card part, for ordering: the accepted output's
 * number, or the call input's while the card is still arriving. A card
 * arriving without a number yet counts as later than any question: a present
 * is refused unless it is the next number after a recorded result, so an
 * unnumbered card in the same message as divider n is question n + 1 (or is
 * refused and never shown). Anything else, a refused card included, is null.
 */
const cardNumber = (part: QuizPart): number | null => {
  if (part.type !== 'tool-present_question' || isFailedToolPart(part)) return null;
  if (part.state === 'output-available') return part.output.question_number;
  const n = (part.input as { question_number?: unknown } | undefined)?.question_number;
  return typeof n === 'number' ? n : Infinity;
};

/**
 * The order one assistant message's parts render in. A divider
 * (`data-question-result`) is written when its record call runs, so when the
 * model records question n and presents question n + 1 in the same step, the
 * divider arrives after the new card. Each divider for question n therefore
 * moves to just before the earliest card in the message for a later question;
 * nothing else moves. Text keeps its place: text before that card stays above
 * the divider, text after the card stays below it. Dividers moved before the
 * same card keep their arrival order. Live and saved messages carry the same
 * cards and dividers in the same order, so every viewer sees the same.
 * Each part keeps its index in `parts`, the React key of its element.
 */
export const displayOrder = (parts: readonly QuizPart[]): { part: QuizPart; index: number }[] => {
  const ordered: { part: QuizPart; index: number }[] = [];
  parts.forEach((part, index) => {
    if (part.type === 'data-question-result') {
      const n = part.data.question_num;
      const at = ordered.findIndex(entry => (cardNumber(entry.part) ?? -Infinity) > n);
      if (at !== -1) {
        ordered.splice(at, 0, { part, index });
        return;
      }
    }
    ordered.push({ part, index });
  });
  return ordered;
};

/**
 * A record call still running. Tools run one at a time and the record call
 * writes its marker before it returns, so once it has an output (or failed)
 * its marker has arrived or never will.
 */
const isPendingRecord = (part: QuizPart) =>
  part.type === 'tool-record_question_result' &&
  (part.state === 'input-streaming' || part.state === 'input-available');

/**
 * The lowest question a record call in the message is still recording
 * (-Infinity when a pending call has no number yet, Infinity when none is
 * pending). A card for a later question waits for that marker: in the legacy
 * chat the marker came first and the card after, never the other way round.
 */
const pendingRecordFrom = (parts: readonly QuizPart[]): number => {
  let from = Infinity;
  for (const part of parts) {
    if (!isPendingRecord(part)) continue;
    const n = (part.input as { question_num?: unknown } | undefined)?.question_num;
    from = Math.min(from, typeof n === 'number' ? n : -Infinity);
  }
  return from;
};

/**
 * The indexes of the text parts that come after a question card in the same
 * message. As in the legacy chat, nothing the model writes after a card is
 * shown: it only restates the question.
 */
const textAfterCard = (parts: readonly QuizPart[]): Set<number> => {
  const after = new Set<number>();
  let cardSeen = false;
  parts.forEach((part, index) => {
    if (cardNumber(part) !== null) cardSeen = true;
    else if (cardSeen && part.type === 'text') after.add(index);
  });
  return after;
};

/**
 * A part that ends the wait for the reply: a card, the buttons, or a notice.
 * An offer ends it once its buttons are in, not when its feedback shows.
 */
const endsTheWait = (part: QuizPart) =>
  part.type === 'tool-present_question' ||
  (part.type === 'tool-offer_next_step' && part.state === 'output-available') ||
  part.type === 'data-notice';

type MessageBlock = {
  kind: 'result' | 'content';
  /** The React key: `kind` and the first part's index in `parts`. */
  key: string;
  entries: { part: QuizPart; index: number }[];
  /** Nothing more joins this block (the opening welcome's own bubble). */
  closed?: boolean;
};

/**
 * One assistant message's rendered parts, in display order, cut into blocks:
 * each run of question markers is a `result` row (its own avatar, outside any
 * bubble), and everything between them is a `content` block (the files read,
 * then a bubble). A message without a marker is one content block. The files
 * read after the last bubble part before a marker were read for what follows
 * it, so they move below the marker, with the next card. Parts that render
 * nothing are left out first, so a live message (which still carries the
 * record call) and its saved copy cut the same way. A block is keyed by its
 * first part's index, so it keeps its elements while the reply streams, even
 * when a marker lands above a card already showing.
 *
 * Text after a card, and a card still waiting for the marker of the question
 * before it, render nothing and are left out the same way. So does a card
 * still arriving in a block with nothing else to show in its bubble: alone
 * its placeholder would be an empty bubble, which can land ahead of the
 * marker its question waits for (the record call never reaches the browser),
 * so the activity line covers the wait until the card itself arrives. In the
 * opening message (`opening`), a first part that is text is the welcome the
 * server writes before any tool call: it is a block of its own, so the files
 * read and question 1 follow it in a new bubble, as in the legacy chat.
 */
export const messageBlocks = (
  parts: readonly QuizPart[],
  streaming: boolean,
  { opening = false }: { opening?: boolean } = {}
): MessageBlock[] => {
  const blocks: MessageBlock[] = [];
  const recordFrom = pendingRecordFrom(parts);
  const hiddenText = textAfterCard(parts);
  for (const entry of displayOrder(parts)) {
    if (entry.part.type !== 'data-step' && !rendersInBubble(entry.part, streaming)) continue;
    if (hiddenText.has(entry.index)) continue;
    if ((cardNumber(entry.part) ?? -Infinity) > recordFrom) continue;
    const last = blocks[blocks.length - 1];
    if (entry.part.type !== 'data-question-result') {
      if (last?.kind === 'content' && !last.closed) last.entries.push(entry);
      else blocks.push({ kind: 'content', key: `content-${entry.index}`, entries: [entry] });
      if (opening && blocks.length === 1 && blocks[0].entries.length === 1) {
        blocks[0].closed = entry.part.type === 'text';
      }
      continue;
    }
    let moved: MessageBlock['entries'] = [];
    if (last?.kind === 'content') {
      let cut = last.entries.length;
      while (cut > 0 && last.entries[cut - 1].part.type === 'data-step') cut--;
      moved = last.entries.splice(cut);
      if (last.entries.length === 0) blocks.pop();
    }
    const row = blocks[blocks.length - 1];
    if (row?.kind === 'result') row.entries.push(entry);
    else blocks.push({ kind: 'result', key: `result-${entry.index}`, entries: [entry] });
    if (moved.length > 0) {
      blocks.push({ kind: 'content', key: `content-${moved[0].index}`, entries: moved });
    }
  }
  // No bubble until it has a part that shows something (a settled part): a
  // card still arriving joins a bubble, it never opens one.
  for (const block of blocks) {
    if (block.kind !== 'content') continue;
    const shows = block.entries.some(
      ({ part }) => part.type !== 'data-step' && rendersInBubble(part, false)
    );
    if (!shows) block.entries = block.entries.filter(({ part }) => part.type === 'data-step');
  }
  return blocks.filter(block => block.entries.length > 0);
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const markdownComponents = (isAssistant: boolean) => ({
  pre: ({ children }: { children?: ReactNode }) => (
    <pre className="my-2 overflow-auto rounded-md bg-[#f6f8fa] p-3 font-mono text-sm dark:bg-[#0d1117] dark:text-gray-200">
      {children}
    </pre>
  ),
  code: ({ className, children }: { className?: string; children?: ReactNode }) => {
    const isBlock = /language-(\w+)/.test(className || '') || String(children).includes('\n');
    if (isBlock) return <code className={className}>{children}</code>;
    return (
      <code
        className={
          isAssistant
            ? 'rounded bg-[#f1f1ef] px-1.5 py-0.5 text-[0.9em] text-[#eb5757] dark:bg-gray-700 dark:text-red-400'
            : 'rounded bg-gray-200 px-1.5 py-0.5 text-[0.9em] text-[#eb5757] dark:bg-gray-900 dark:text-red-400'
        }
      >
        {children}
      </code>
    );
  },
  p: ({ children }: { children?: ReactNode }) => <p className="my-2 leading-relaxed">{children}</p>,
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="my-2 list-disc pl-5">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="my-2 list-decimal pl-5">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => <li className="my-1">{children}</li>,
  // Tailwind's reset strips these; the legacy chat's sizes and weights.
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }: { children?: ReactNode }) => <em className="italic">{children}</em>,
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 className="mt-3 mb-2 text-[1.5em] font-semibold">{children}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="mt-2.5 mb-1.5 text-[1.3em] font-semibold">{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="mt-2 mb-1 text-[1.1em] font-semibold">{children}</h3>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="my-2 border-l-[3px] border-[#d9d9d9] pl-3 text-[#666] dark:border-[#4b5563] dark:text-[#9ca3af]">
      {children}
    </blockquote>
  ),
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-emerald-600 no-underline dark:text-emerald-400"
    >
      {children}
    </a>
  ),
});

const Markdown = ({ text, isAssistant }: { text: string; isAssistant: boolean }) => (
  <ReactMarkdown
    rehypePlugins={[rehypeHighlight]}
    components={markdownComponents(isAssistant)}
    {...(isAssistant ? {} : { disallowedElements: ['a'], unwrapDisallowed: true })}
  >
    {text}
  </ReactMarkdown>
);

const AssistantAvatar = () => (
  <Avatar style={{ backgroundColor: '#fffdf5', fontSize: '20px', border: '1px solid #ffd66b' }}>
    📝
  </Avatar>
);

const Bubble = ({
  variant,
  testId,
  children,
}: {
  variant: 'assistant' | 'user';
  testId?: string;
  children: ReactNode;
}) => (
  <div
    className={
      variant === 'assistant'
        ? 'min-w-fit max-w-[70%] break-words rounded-lg border border-[#d9d9d9] bg-white px-4 py-3 text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100'
        : 'min-w-fit max-w-[70%] break-words rounded-lg bg-[#f0f2f5] px-4 py-3 text-gray-900 dark:bg-gray-700 dark:text-gray-100'
    }
    data-testid={testId}
  >
    {children}
  </div>
);

const QuestionCardSkeleton = () => (
  <div className="mb-2 min-w-[280px] rounded-lg border border-[#91caff] bg-[#e6f4ff] p-3 dark:border-[#2d4a6f] dark:bg-[#1e3a5f]">
    <Skeleton active title={false} paragraph={{ rows: 2 }} />
  </div>
);

const RevisedResult = ({
  questionNum,
  emoji,
  briefFeedback,
}: {
  questionNum: number;
  emoji: string;
  briefFeedback?: string;
}) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-gray-700 dark:text-gray-300">
      question {questionNum} revised: <Emoji emoji={emoji} fontSize={16} />
    </span>
    {briefFeedback && <span className="text-gray-500 dark:text-gray-400">{briefFeedback}</span>}
  </div>
);

/** The line offer_next_step puts between its feedback and its buttons, when it has one. */
const leadInOf = (output: unknown): string | null => {
  const leadIn = (output as { lead_in?: unknown } | null)?.lead_in;
  return typeof leadIn === 'string' && leadIn.trim() ? leadIn : null;
};

/** The evaluation's closing line, above the results panel (as the legacy chat showed it). */
const ClosingAcknowledgment = ({ text, spaced }: { text: string; spaced: boolean }) => (
  <div className={`flex justify-start${spaced ? ' mt-4' : ''}`}>
    <Space align="start">
      <AssistantAvatar />
      <Bubble variant="assistant" testId="quiz-closing-acknowledgment">
        <Markdown text={text} isAssistant />
      </Bubble>
    </Space>
  </div>
);

interface PartContext {
  isDarkMode: boolean;
  /** This part's message is the reply streaming now. */
  streaming: boolean;
  /** No button can be used: a turn is running, the attempt is complete, or read-only. */
  buttonsDisabled: boolean;
  /** The index of this message's live offer (`buttonSetsOf`), if it has it. */
  liveOffer: number | null;
  onButton: ((text: string, action: NextStepAction) => void) | null;
}

/** One part inside the assistant's bubble, by type (`index`: its place in the visible parts). */
export function AssistantPart({
  part,
  index,
  ctx,
}: {
  part: QuizPart;
  index: number;
  ctx: PartContext;
}) {
  if (isFailedToolPart(part)) return null;
  switch (part.type) {
    case 'text':
      return part.text.trim() ? <Markdown text={part.text} isAssistant /> : null;
    case 'data-question-result': {
      const { question_num, emoji, brief_feedback, revised } = part.data;
      return (
        <div className="my-1" data-testid="quiz-question-result">
          {revised ? (
            <RevisedResult
              questionNum={question_num}
              emoji={emoji}
              briefFeedback={brief_feedback}
            />
          ) : (
            <ProgressDivider
              emoji={emoji}
              briefFeedback={brief_feedback}
              questionNum={question_num}
              isDarkMode={ctx.isDarkMode}
            />
          )}
        </div>
      );
    }
    case 'data-notice':
      return (
        <p className="my-1 text-gray-600 dark:text-gray-400" data-testid="quiz-notice">
          {NOTICE_COPY[part.data.code] ?? REPLY_FAILED_LINE}
        </p>
      );
    case 'tool-present_question': {
      // The server-accepted card (the tool's output), never this call's input:
      // after a re-run the input can carry new wording while the stored
      // question is the original.
      if (part.state === 'output-available') {
        const { card, question_number, total_questions } = part.output;
        return (
          <div data-testid="quiz-question-card">
            {card.preamble?.trim() ? <Markdown text={card.preamble} isAssistant /> : null}
            <QuestionCard
              questionData={{ ...card, question_number, total_questions }}
              isDarkMode={ctx.isDarkMode}
            />
          </div>
        );
      }
      if (ctx.streaming && (part.state === 'input-streaming' || part.state === 'input-available')) {
        return <QuestionCardSkeleton />;
      }
      return null;
    }
    case 'tool-offer_next_step': {
      // The feedback (the call's input) is the agent's message, shown once
      // the input is in; the lead-in and buttons (its output) follow once the
      // call is done. A part saved before the feedback moved into the call has
      // none, and still renders its buttons (see `feedbackOf` for why that
      // stays). Under it, for staff only, the answer the model stated (the
      // student's copy never has it). Only the live set can be clicked
      // (`buttonSetsOf`).
      const feedback = feedbackOf(part.input);
      const expected = expectedAnswerOf(part.input);
      return (
        <>
          {feedback ? <Markdown text={feedback} isAssistant /> : null}
          {expected ? (
            <p
              className="mt-1 mb-2 text-xs text-gray-500 dark:text-gray-400"
              data-testid="quiz-expected-answer"
            >
              <span className="font-medium">Expected:</span> {expected}
            </p>
          ) : null}
          {part.state === 'output-available' ? (
            <NextStepButtons
              actions={part.output.actions}
              leadIn={leadInOf(part.output)}
              disabled={ctx.buttonsDisabled || ctx.liveOffer !== index}
              onAction={ctx.onButton}
            />
          ) : null}
        </>
      );
    }
    default:
      // reasoning, step-start, data-step (listed above the bubble), internal
      // or unknown parts: nothing.
      return null;
  }
}

/** The blocks after a message's last marker row: the part of the reply still coming. */
const tailOf = (blocks: readonly MessageBlock[]): QuizPart[] => {
  let start = 0;
  blocks.forEach((block, i) => {
    if (block.kind === 'result') start = i + 1;
  });
  return blocks.slice(start).flatMap(block => block.entries.map(entry => entry.part));
};

export const THINKING_LINE = 'Thinking...';
export const EXPLORING_LINE = 'Exploring code...';
/** The legacy chat's line while only course material is being looked up. */
export const LOOKING_UP_LINE = 'Looking things up…';

/**
 * What the activity line says while a turn runs, or null when it is hidden.
 * As in the legacy chat it stays up until the reply has arrived: here, until
 * a card, the buttons, a notice or the evaluation follow the message's last
 * marker. Once work has started on what comes next (the first steps after the
 * welcome, the ones after each marker) it says "Looking things up…" when
 * every step so far looked up course material and "Exploring code..." when
 * any read a file, as in the legacy chat; "Thinking..." otherwise.
 */
export const activityLine = (
  message: QuizUIMessage | undefined,
  { opening = false }: { opening?: boolean } = {}
): string | null => {
  if (message?.role !== 'assistant') return THINKING_LINE;
  const parts = visibleParts(message);
  if (parts.some(isEvaluationPart)) return null;
  const tail = tailOf(messageBlocks(parts, true, { opening }));
  if (tail.some(endsTheWait)) return null;
  const steps = stepsOf(tail);
  if (steps.length === 0) return THINKING_LINE;
  return onlyCourseSteps(steps) ? LOOKING_UP_LINE : EXPLORING_LINE;
};

interface TranscriptProps {
  messages: QuizUIMessage[];
  status: QuizChatStatus;
  /** A turn is running (or starting). */
  busy: boolean;
  isDarkMode: boolean;
  userLogin?: string | null;
  userImage?: string | null;
  /** The stored evaluation record (loader); preferred over a part's copy. */
  evaluationRecord?: QuizEvaluationRecordV2 | null;
  focusMetrics?: ResultsFocusMetrics | null;
  /** Absent in read-only views. */
  onButton?: ((text: string, action: NextStepAction) => void) | null;
  errorLine?: string | null;
  /** Shown with a failed start: re-sends the start. */
  onRetryStart?: (() => void) | null;
  scrollToResults?: boolean;
  /** The server submitted the attempt at its message limit: the results say so. */
  endedAtLimit?: boolean;
  /**
   * How many more messages the attempt admits, shown under the latest reply
   * once it is `MESSAGES_LEFT_NOTICE_AT` or fewer; null for none.
   */
  messagesLeft?: number | null;
}

/** The transcript: messages, the typing indicator, the results panel. */
export function QuizTranscript({
  messages,
  status,
  busy,
  isDarkMode,
  userLogin = null,
  userImage = null,
  evaluationRecord = null,
  focusMetrics = null,
  onButton = null,
  errorLine = null,
  onRetryStart = null,
  scrollToResults = false,
  endedAtLimit = false,
  messagesLeft = null,
}: TranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const shown = messages.filter(m => !m.metadata?.hidden);
  const lastMessage = shown[shown.length - 1];
  // The opening reply: its welcome is a bubble of its own.
  const openingId = shown.find(m => m.role === 'assistant')?.id;
  // The one set of buttons that can still be clicked, if any, and the
  // replies that end with the Next button alone (the hints).
  const { live, hintReplies } = buttonSetsOf(shown);

  // The results panel renders once: at the first evaluation part, from the
  // stored record when the loader has it. Above it, the evaluation's closing
  // line, unless the reply already closed in its own words after its last
  // marker (the legacy chat showed the model's text first, the line only
  // when there was none).
  let resultsRendered = false;
  const renderResults = (
    fallback: QuizEvaluationRecordV2 | null | undefined,
    { ownClosingText = false, spaced = false }: { ownClosingText?: boolean; spaced?: boolean } = {}
  ) => {
    const record = evaluationRecord ?? fallback ?? null;
    if (resultsRendered || !record) return null;
    resultsRendered = true;
    const closing = ownClosingText ? '' : (record.feedback?.final_acknowledgment?.trim() ?? '');
    return (
      <>
        {closing && <ClosingAcknowledgment text={closing} spaced={spaced} />}
        <div ref={resultsRef}>
          <QuizResults
            evaluation={record}
            focusMetrics={focusMetrics}
            submittedAtLimit={endedAtLimit}
          />
        </div>
      </>
    );
  };

  useEffect(() => {
    if (status !== 'complete') endRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages, busy, status]);

  useEffect(() => {
    if (!scrollToResults) return;
    const timer = setTimeout(() => {
      resultsRef.current?.scrollIntoView?.({ behavior: 'auto', block: 'start' });
    }, 100);
    return () => clearTimeout(timer);
  }, [scrollToResults]);

  const activity = busy
    ? activityLine(lastMessage, {
        opening: lastMessage !== undefined && lastMessage.id === openingId,
      })
    : null;
  // Under the latest reply once it is in, while few messages are left.
  const messagesLeftLine =
    !busy && messagesLeft !== null && messagesLeft <= MESSAGES_LEFT_NOTICE_AT
      ? QUIZ_MESSAGE_LIMIT_COPY.messagesLeft(messagesLeft)
      : null;

  return (
    <div
      tabIndex={0} // eslint-disable-line -- keyboard scrolling of the conversation
      role="log"
      aria-live="polite"
      aria-label="Quiz conversation"
      className="flex-1 overflow-y-auto px-4 pb-4 outline-none"
    >
      {shown.map((message, index) => {
        const parts = visibleParts(message);
        if (message.role === 'user') {
          const text = parts
            .flatMap(p => (p.type === 'text' ? [p.text] : []))
            .join('\n')
            .trim();
          if (!text) return null;
          return (
            <div key={message.id} className="mb-4 flex flex-col items-end" data-message-role="user">
              <Space align="start">
                <Bubble variant="user">
                  <Markdown text={text} isAssistant={false} />
                </Bubble>
                {userLogin ? (
                  <Avatar src={userImage ?? undefined} style={{ backgroundColor: '#52c41a' }}>
                    {userLogin[0]?.toUpperCase()}
                  </Avatar>
                ) : (
                  <Avatar icon={<UserOutlined />} style={{ backgroundColor: '#52c41a' }} />
                )}
              </Space>
            </div>
          );
        }
        if (message.role !== 'assistant') return null;

        const isStreamingThis = busy && message === lastMessage;
        const ctx: PartContext = {
          isDarkMode,
          streaming: isStreamingThis,
          buttonsDisabled: busy || status === 'complete' || !onButton,
          liveOffer: live?.message === index && 'part' in live ? live.part : null,
          onButton,
        };
        const blocks = messageBlocks(parts, isStreamingThis, { opening: message.id === openingId });
        const evaluationPart = parts.find(isEvaluationPart);
        const evaluationFromPart =
          evaluationPart?.type === 'tool-submit_quiz_evaluation' &&
          evaluationPart.state === 'output-available'
            ? evaluationPart.output
            : evaluationPart?.type === 'data-evaluation'
              ? evaluationPart.data
              : null;

        if (blocks.length === 0 && !evaluationPart) return null;

        // A hint ends with the Next button alone, in its last bubble, once the
        // reply is in (a card could still arrive while it streams). Live only
        // while nothing has superseded it (`buttonSetsOf`).
        let hintBubble = -1;
        if (hintReplies.has(index) && !isStreamingThis) {
          blocks.forEach((block, i) => {
            if (block.kind === 'content' && block.entries.some(e => e.part.type !== 'data-step')) {
              hintBubble = i;
            }
          });
        }
        const hintLive = live?.message === index && 'hint' in live;

        return (
          <div
            key={message.id}
            className="mb-4 flex flex-col items-start"
            data-message-role="assistant"
          >
            {blocks.map((block, blockIndex) => {
              const followed = blockIndex < blocks.length - 1;
              if (block.kind === 'result') {
                return (
                  <div
                    key={block.key}
                    className={followed ? 'mb-2' : undefined}
                    data-testid="quiz-result-row"
                  >
                    <Space align="start">
                      <AssistantAvatar />
                      <div className="rounded-lg border border-[#d9d9d9] bg-white px-4 py-3 text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
                        {block.entries.map(({ part, index }) => (
                          <AssistantPart key={index} part={part} index={index} ctx={ctx} />
                        ))}
                      </div>
                    </Space>
                  </div>
                );
              }
              const steps = stepsOf(block.entries.map(entry => entry.part));
              const inBubble = block.entries.filter(entry => entry.part.type !== 'data-step');
              return (
                <div
                  key={block.key}
                  className={`flex w-full flex-col items-start${followed ? ' mb-4' : ''}`}
                >
                  {steps.length > 0 && (
                    <StepList
                      steps={steps}
                      // Open while these files are being read: the reply's
                      // last block, with nothing yet that they were read for.
                      active={
                        isStreamingThis &&
                        !followed &&
                        !block.entries.some(e => endsTheWait(e.part))
                      }
                      isDarkMode={isDarkMode}
                    />
                  )}
                  {inBubble.length > 0 && (
                    <Space align="start">
                      <AssistantAvatar />
                      <Bubble variant="assistant" testId="quiz-assistant-bubble">
                        {inBubble.map(({ part, index }) => (
                          <AssistantPart key={index} part={part} index={index} ctx={ctx} />
                        ))}
                        {blockIndex === hintBubble && (
                          <NextStepButtons
                            actions={HINT_ACTIONS}
                            disabled={ctx.buttonsDisabled || !hintLive}
                            onAction={onButton}
                          />
                        )}
                      </Bubble>
                    </Space>
                  )}
                </div>
              );
            })}
            {evaluationPart && (
              <div className="w-full">
                {renderResults(evaluationFromPart, {
                  ownClosingText: tailOf(blocks).some(part => part.type === 'text'),
                  spaced: blocks.length > 0,
                })}
              </div>
            )}
          </div>
        );
      })}

      {messagesLeftLine && (
        <p
          className="-mt-2 mb-4 pl-10 text-xs text-gray-500 dark:text-gray-400"
          data-testid="quiz-messages-left"
        >
          {messagesLeftLine}
        </p>
      )}

      {activity && (
        <div className="mb-4 flex justify-start" data-testid="quiz-typing">
          <Space>
            <AssistantAvatar />
            <div className="flex items-center gap-2 rounded-lg border border-[#d9d9d9] bg-white px-4 py-3 dark:border-gray-600 dark:bg-gray-800">
              <TypingIndicator color="#10b981" />
              <Text type="secondary" style={{ marginLeft: 4 }}>
                {activity}
              </Text>
            </div>
          </Space>
        </div>
      )}

      {errorLine && !busy && (
        <div className="mb-4 flex justify-start" data-testid="quiz-error">
          <Space align="start">
            <AssistantAvatar />
            <Bubble variant="assistant">
              <p className="my-1">{errorLine}</p>
              {onRetryStart && (
                <Button size="small" className="mt-2" onClick={onRetryStart}>
                  Start again
                </Button>
              )}
            </Bubble>
          </Space>
        </div>
      )}

      {/* A completed attempt whose transcript carries no evaluation part still shows its results. */}
      {status === 'complete' && renderResults(null)}

      <div ref={endRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code highlighting theme (as the legacy chat does)
// ---------------------------------------------------------------------------

const useHighlightTheme = (isDarkMode: boolean) => {
  useEffect(() => {
    document.querySelector('link[data-hljs-theme]')?.remove();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.setAttribute('data-hljs-theme', 'true');
    link.href = isDarkMode
      ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css'
      : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
    document.head.appendChild(link);
    return () => {
      document.querySelector('link[data-hljs-theme]')?.remove();
    };
  }, [isDarkMode]);
};

// ---------------------------------------------------------------------------
// Time on the attempt (the same api.quiz actions the legacy chat posts)
// ---------------------------------------------------------------------------

const postQuizAction = (payload: Record<string, unknown>, preferBeacon = false) => {
  const body = JSON.stringify(payload);
  if (preferBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    try {
      if (navigator.sendBeacon('/api/quiz', new Blob([body], { type: 'application/json' }))) {
        return;
      }
    } catch {
      // fall through to fetch
    }
  }
  void fetch('/api/quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }).catch(() => {});
};

function useAttemptTime({
  attemptId,
  active,
  isVisible,
  initialTotalMs,
  initialUnfocusedMs,
}: {
  attemptId: string;
  active: boolean;
  isVisible: boolean;
  initialTotalMs: number;
  initialUnfocusedMs: number;
}) {
  const { getMetricsSnapshot, finalizeCurrentSession } = useQuizFocusMetrics({
    isActive: active,
    attemptId,
    initialTotalMs,
    initialUnfocusedMs,
  });
  const lastSentRef = useRef({ totalMs: initialTotalMs, unfocusedMs: initialUnfocusedMs });
  const activeRef = useRef(active);
  activeRef.current = active;
  const finalizeRef = useRef(finalizeCurrentSession);
  finalizeRef.current = finalizeCurrentSession;

  const sendUpdate = useCallback(
    (preferBeacon = false) => {
      if (!activeRef.current) return;
      const snapshot = getMetricsSnapshot();
      if (!snapshot) return;
      const previous = lastSentRef.current;
      if (snapshot.totalMs === previous.totalMs && snapshot.unfocusedMs === previous.unfocusedMs) {
        return;
      }
      const unfocusedMs = Math.min(snapshot.unfocusedMs, snapshot.totalMs);
      postQuizAction(
        {
          _action: 'updateMetrics',
          attemptId,
          totalDurationMs: snapshot.totalMs,
          unfocusedDurationMs: unfocusedMs,
        },
        preferBeacon
      );
      lastSentRef.current = { totalMs: snapshot.totalMs, unfocusedMs };
    },
    [attemptId, getMetricsSnapshot]
  );

  const recordClose = useCallback(() => {
    const snapshot = finalizeRef.current();
    if (!snapshot) return;
    postQuizAction(
      {
        _action: 'recordModalClose',
        attemptId,
        totalDurationMs: snapshot.totalMs,
        unfocusedDurationMs: Math.min(snapshot.unfocusedMs, snapshot.totalMs),
      },
      true
    );
  }, [attemptId]);

  // A gap since the drawer was last closed counts as time away (server side).
  const openedRef = useRef(false);
  useEffect(() => {
    if (!active || openedRef.current) return;
    openedRef.current = true;
    postQuizAction({ _action: 'recordModalOpen', attemptId });
  }, [active, attemptId]);

  // A checkpoint soon after opening, then every 30 seconds.
  useEffect(() => {
    if (!active) return undefined;
    const first = setTimeout(() => sendUpdate(), 5000);
    const every = setInterval(() => sendUpdate(), 30000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [active, sendUpdate]);

  // Tab hidden: save now. Page leaving: record the close.
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') sendUpdate(true);
    };
    const onPageHide = () => recordClose();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [active, sendUpdate, recordClose]);

  // The drawer closing records the close.
  const wasVisibleRef = useRef(isVisible);
  useEffect(() => {
    if (active && wasVisibleRef.current && !isVisible) recordClose();
    wasVisibleRef.current = isVisible;
  }, [active, isVisible, recordClose]);

  // Leaving the drawer by navigation records the close too, once the drawer
  // has really been open (not a development double mount).
  useEffect(() => {
    const mountedAt = Date.now();
    return () => {
      if (activeRef.current && Date.now() - mountedAt > 1000) recordClose();
    };
  }, [recordClose]);

  // The attempt completed while open (its task completes it after the last
  // message): send the time up to now, once. The focus tracker has already
  // stopped the clock when `active` turned false, so this is the final count.
  // It is also what the results panel shows from then on, as the legacy chat
  // did: the drawer's refresh can read the attempt before this write lands.
  const wasActiveRef = useRef(active);
  const finalSentRef = useRef(false);
  const [finalMetrics, setFinalMetrics] = useState<ResultsFocusMetrics | null>(null);
  useEffect(() => {
    const completedNow = wasActiveRef.current && !active;
    wasActiveRef.current = active;
    if (!completedNow || finalSentRef.current) return;
    finalSentRef.current = true;
    const snapshot = getMetricsSnapshot();
    if (!snapshot) return;
    const focusedMs = Math.max(0, snapshot.totalMs - snapshot.unfocusedMs);
    setFinalMetrics({
      totalMs: snapshot.totalMs,
      focusedMs,
      percentage: snapshot.totalMs > 0 ? Math.round((focusedMs / snapshot.totalMs) * 100) : 100,
    });
    const previous = lastSentRef.current;
    if (snapshot.totalMs === previous.totalMs && snapshot.unfocusedMs === previous.unfocusedMs) {
      return;
    }
    const unfocusedMs = Math.min(snapshot.unfocusedMs, snapshot.totalMs);
    postQuizAction({
      _action: 'updateMetrics',
      attemptId,
      totalDurationMs: snapshot.totalMs,
      unfocusedDurationMs: unfocusedMs,
    });
    lastSentRef.current = { totalMs: snapshot.totalMs, unfocusedMs };
  }, [active, attemptId, getMetricsSnapshot]);

  /** Save the time so far now (before the attempt completes); the final count once it has. */
  return { flush: sendUpdate, finalMetrics };
}

// ---------------------------------------------------------------------------
// The live chat (the attempt's owner, attempt open)
// ---------------------------------------------------------------------------

const QUIZ_CHAT_TASK_ID = 'quiz-attempt';
const EDITOR_PLACEHOLDER = 'Type your response... (use Code button to add code snippets)';

/** How often the drawer refreshes while it waits for an opening's saved reply. */
const SAVED_OPENING_POLL_MS = 1500;
/**
 * How long it waits. Past the task's turn deadline (four minutes) an opening
 * has saved its reply or a notice, so nothing saved by then means none is
 * coming.
 */
const SAVED_OPENING_WAIT_MS = 5 * 60_000;

function LiveQuizChat({
  attempt,
  transcript,
  chatStarted = false,
  chatActivity = null,
  messagesLeft = null,
  userLogin,
  userImage,
  focusMetrics,
  isVisible = true,
}: QuizChatProps) {
  const attemptId = attempt.id;
  const { isDarkMode } = useDarkMode();
  const revalidator = useRevalidator();
  const revalidateRef = useRef(() => revalidator.revalidate());
  revalidateRef.current = () => revalidator.revalidate();

  const initialMessages = useMemo(() => transcript ?? [], []); // eslint-disable-line react-hooks/exhaustive-deps
  const [persisted] = useState(() => readPersistedSession(attemptId));
  const resuming = persisted?.isStreaming === true && !persisted.closed;
  // Read once, as the drawer opens, like the transcript: a refresh of the
  // drawer while this tab's own opening runs finds that opening stored, and
  // must not turn the tab that began it into one that joins it.
  const [startedAtOpen] = useState(chatStarted);
  // The opening was admitted but nothing of it is saved yet: its turn is
  // running for another tab or window (a reply is saved when its turn ends).
  // Sending begin again would start a second opening or be refused, so this
  // tab joins the running reply instead (see the join below).
  const joinsOpening = startedAtOpen && initialMessages.length === 0 && !resuming;
  // Unless it was admitted longer ago than a turn can run: then nothing is
  // coming, and Start again is offered at once.
  const [lostAtOpen] = useState(() => joinsOpening && openingOverdue(chatActivity));
  // The session closed while this chat was open: the task closes it on every
  // permanent refusal and once the attempt is complete.
  const [closedWhileOpen, setClosedWhileOpen] = useState(false);
  // The task refused a message because the grant behind this tab's session
  // no longer holds (`session_ended`). From then on the tab keeps no session
  // state, so a reload asks the session route for a session, which writes a
  // new grant, instead of reusing this one.
  const sessionEndedRef = useRef(false);

  const transportRef = useRef<{ seedResumeCursor?: (chatId: string, cursor: string) => void }>(
    null
  );
  const transport = useTriggerChatTransport({
    task: QUIZ_CHAT_TASK_ID,
    // Called when this tab holds no session state for the attempt (nothing
    // stored in this tab, or a session the transport creates again). The
    // stored cursor opens the reply stream just past the last finished reply,
    // which the transcript already shows, instead of reading it again.
    startSession: async ({ chatId }) => {
      const { publicAccessToken, resumeCursor } = await requestSession(chatId);
      if (resumeCursor) transportRef.current?.seedResumeCursor?.(chatId, resumeCursor);
      return { publicAccessToken };
    },
    accessToken: ({ chatId }) => requestSessionToken(chatId),
    ...(persisted ? { sessions: { [attemptId]: persisted } } : {}),
    onSessionChange: (chatId, state) => {
      persistSession(chatId, sessionEndedRef.current ? null : state);
      if (state?.closed) setClosedWhileOpen(true);
    },
  });
  transportRef.current = transport;

  // What useChat reads replies through: the transport, minus any reply the
  // chat already holds (`withoutReplayedMessages`). A join's resume first
  // readies the transport to read the running opening (`readyToJoinOpening`).
  const messagesRef = useRef<readonly QuizUIMessage[]>(initialMessages);
  const joinNextRef = useRef(false);
  const chatTransport = useMemo((): ChatTransport<QuizUIMessage> => {
    const replayed = withoutReplayedMessages(
      transport as unknown as ChatTransport<QuizUIMessage>,
      () => messagesRef.current
    );
    return {
      ...replayed,
      reconnectToStream: async options => {
        if (joinNextRef.current) {
          joinNextRef.current = false;
          if (!(await readyToJoinOpening(transport, options.chatId))) return null;
        }
        return replayed.reconnectToStream(options);
      },
    };
  }, [transport]);

  // The messages each reply to a student message says the attempt still
  // admits (`data-messages-left`, counted by admission; never saved).
  const [streamedLeft, setStreamedLeft] = useState<number | null>(null);

  const { messages, sendMessage, status, error, resumeStream, setMessages, clearError } =
    useChat<QuizUIMessage>({
      id: attemptId,
      messages: initialMessages,
      transport: chatTransport,
      // Re-attach to a reply this tab was streaming when the page was reloaded.
      // Only then: a resume and a start must never race on one chat.
      resume: resuming,
      onData: part => {
        if (part.type === 'data-messages-left') setStreamedLeft(part.data.remaining);
      },
    });
  messagesRef.current = messages;
  const { sendAction } = useChatActions({ sendMessage });

  // Joining an opening that runs elsewhere (`joinsOpening`): first its reply
  // stream (`joining`), then, when that brought no reply, the saved transcript
  // (`awaitingSaved`), refreshed until it has the opening. Nothing saved
  // within SAVED_OPENING_WAIT_MS means the opening is lost (`openingLost`),
  // and only then is begin offered again.
  const [joining, setJoining] = useState(false);
  const [awaitingSaved, setAwaitingSaved] = useState(false);
  const [openingLost, setOpeningLost] = useState(lostAtOpen);

  const busy = status === 'submitted' || status === 'streaming' || joining || awaitingSaved;
  const evaluationSeen = hasEvaluation(messages);
  const complete = Boolean(attempt.completed_at) || evaluationSeen;
  // A session closed without an evaluation (the attempt can no longer take
  // messages) leaves nothing to send to either; nor does a refusal for good.
  const sessionClosed =
    closedWhileOpen ||
    (typeof transport.sessionStatus === 'function' &&
      transport.sessionStatus(attemptId) === 'closed');
  const refusedForGood = status === 'error' && isRefusalForGood(error);
  const canSend = !complete && !sessionClosed && !refusedForGood;

  const time = useAttemptTime({
    attemptId,
    active: !complete,
    isVisible,
    initialTotalMs: Number(attempt.total_duration_ms ?? 0),
    initialUnfocusedMs: Number(attempt.unfocused_duration_ms ?? 0),
  });

  // A new attempt starts with the typed `begin` action; its turn streams into
  // useChat like any reply. Not re-sent when a reply is being resumed.
  const beganRef = useRef(false);
  // This tab has sent begin: a start it retries is a begin, never a join.
  const [beganHere, setBeganHere] = useState(false);
  const begin = useCallback(() => {
    beganRef.current = true;
    setBeganHere(true);
    setOpeningLost(false);
    void sendAction({ type: 'begin' });
  }, [sendAction]);
  // Sent once the mount has held, not from the mount effect itself: useChat
  // stops its chat when it unmounts, which aborts the request in flight, and
  // StrictMode (the client entry) unmounts and remounts every effect once in
  // development. A begin sent from the first mount was aborted that way: the
  // server ran the turn but its reply never reached the drawer. A torn-down
  // mount cancels its pending send; the mount that stays sends it.
  useEffect(() => {
    if (beganRef.current || initialMessages.length > 0 || resuming || startedAtOpen) {
      return undefined;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && !beganRef.current) begin();
    });
    return () => {
      cancelled = true;
    };
  }, [begin, initialMessages.length, resuming, startedAtOpen]);

  // Join the running opening: read its reply stream from the start. When that
  // brings no reply (the opening already finished, or its stream had nothing
  // yet) and no error, wait for the saved transcript. An error stays on
  // screen, and its retry joins again: begin is never re-sent from here.
  const [joinEnded, setJoinEnded] = useState(false);
  const join = useCallback(() => {
    setJoining(true);
    joinNextRef.current = true;
    void resumeStream().finally(() => {
      joinNextRef.current = false;
      setJoining(false);
      setJoinEnded(true);
    });
  }, [resumeStream]);
  const hasReply = messages.some(m => m.role === 'assistant');
  useEffect(() => {
    if (!joinEnded) return;
    setJoinEnded(false);
    if (!hasReply && status !== 'error') setAwaitingSaved(true);
  }, [joinEnded, hasReply, status]);
  // Started once the mount has held, for the reason begin is (above).
  const joinedRef = useRef(false);
  useEffect(() => {
    if (!joinsOpening || lostAtOpen || joinedRef.current) return undefined;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || joinedRef.current) return;
      joinedRef.current = true;
      join();
    });
    return () => {
      cancelled = true;
    };
  }, [joinsOpening, lostAtOpen, join]);

  // A begin refused because the quiz has already started (another tab began
  // it first) waits for the saved transcript too, rather than offering a
  // begin that would be refused the same way.
  const alreadyStarted =
    status === 'error' && errorLineFor(error) === QUIZ_REFUSAL_COPY.already_started && !hasReply;
  useEffect(() => {
    if (!alreadyStarted) return;
    clearError();
    setAwaitingSaved(true);
  }, [alreadyStarted, clearError]);

  // Waiting for the saved opening: the drawer refreshes every
  // SAVED_OPENING_POLL_MS until the transcript has it, for at most
  // SAVED_OPENING_WAIT_MS.
  useEffect(() => {
    if (!awaitingSaved) return undefined;
    revalidateRef.current();
    const every = setInterval(() => revalidateRef.current(), SAVED_OPENING_POLL_MS);
    const lost = setTimeout(() => {
      setAwaitingSaved(false);
      setOpeningLost(true);
    }, SAVED_OPENING_WAIT_MS);
    return () => {
      clearInterval(every);
      clearTimeout(lost);
    };
  }, [awaitingSaved]);

  // The refreshed transcript has the opening: the chat takes it as it is.
  useEffect(() => {
    if (!awaitingSaved || !transcript?.some(m => m.role === 'assistant')) return;
    if (!messagesRef.current.some(m => m.role === 'assistant')) {
      clearError();
      setMessages(transcript);
    }
    setAwaitingSaved(false);
  }, [awaitingSaved, transcript, setMessages, clearError]);

  // Once the evaluation is in, or the attempt can take no more turns (the
  // session closed, or a refusal for good), and the reply has finished,
  // refresh the drawer once: its title, close prompt and results panel read
  // the attempt as stored, which a refused turn may have completed (at the
  // message limit, the refusal completes it, and the refresh brings its
  // results).
  const ended = evaluationSeen || closedWhileOpen || refusedForGood;
  const refreshedRef = useRef(false);
  useEffect(() => {
    if (!ended || busy || refreshedRef.current) return;
    refreshedRef.current = true;
    revalidateRef.current();
  }, [ended, busy]);

  // A session_ended refusal: drop the tab's session state, and keep it
  // dropped (`sessionEndedRef`).
  const sessionEnded =
    status === 'error' && errorLineFor(error) === QUIZ_REFUSAL_COPY.session_ended;
  useEffect(() => {
    if (!sessionEnded) return;
    sessionEndedRef.current = true;
    persistSession(attemptId, null);
  }, [sessionEnded, attemptId]);

  // A button click the task refused before admitting it (sent too soon after
  // the last message, say) never happened on the server: it leaves the chat,
  // and its buttons are live again (`withoutRefusedClick`).
  const refusedBeforeAdmission = status === 'error' && isRefusedBeforeAdmission(error);
  useEffect(() => {
    if (!refusedBeforeAdmission) return;
    const kept = withoutRefusedClick(messagesRef.current);
    if (kept) setMessages(kept);
  }, [refusedBeforeAdmission, error, setMessages]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy || !canSend) return;
      time.flush();
      void sendMessage({ text: trimmed });
    },
    [busy, canSend, sendMessage, time]
  );

  const onButton = useCallback((text: string) => send(text), [send]);

  const shown = messages.filter(m => !m.metadata?.hidden);
  // `complete` for the test drivers only once the closing reply has finished,
  // so a reader waiting on it sees the whole transcript.
  const chatStatus: QuizChatStatus =
    attempt.completed_at || (evaluationSeen && !busy) ? 'complete' : busy ? 'streaming' : 'ready';
  const errorLine =
    status === 'error' && error ? errorLineFor(error) : openingLost ? START_FAILED_LINE : null;
  // Nothing to start again once the attempt can take no more messages.
  const startFailed = Boolean(errorLine) && shown.length === 0 && canSend;
  // Once the refreshed attempt says it was submitted at the message limit, its
  // results say so: the refusal's line is not repeated above them.
  const endedAtLimit = attempt.ended_by === 'turn_limit';
  const shownErrorLine =
    endedAtLimit && errorLine === QUIZ_REFUSAL_COPY.turn_limit ? null : errorLine;
  // The server's count, from the loader and from each reply: it only goes
  // down, so the lower one is the current one. None once nothing can be sent.
  const knownLeft = [messagesLeft, streamedLeft].filter((n): n is number => typeof n === 'number');
  const left = canSend && knownLeft.length > 0 ? Math.min(...knownLeft) : null;
  // A start that failed is tried again the way it was made: a join joins
  // again, and begin is sent again only for an attempt with no opening, one
  // whose opening was lost, or one this tab began.
  const retryStart = startedAtOpen && !openingLost && !beganHere ? join : begin;

  return (
    <div
      className="flex h-full flex-col"
      data-testid="quiz-chat"
      data-quiz-status={chatStatus}
      data-quiz-runtime="trigger_chat"
    >
      <div className="flex flex-1 flex-col overflow-hidden">
        <QuizTranscript
          messages={messages}
          status={chatStatus}
          busy={busy}
          isDarkMode={isDarkMode}
          userLogin={userLogin}
          userImage={userImage}
          evaluationRecord={attempt.evaluation_json ?? null}
          focusMetrics={time.finalMetrics ?? focusMetrics}
          onButton={canSend ? onButton : null}
          errorLine={shownErrorLine}
          onRetryStart={startFailed ? retryStart : null}
          endedAtLimit={endedAtLimit}
          messagesLeft={left}
        />
      </div>

      {/* Gone once the attempt is complete, as in the legacy chat; a closed
          session without an evaluation leaves it in place, inert. */}
      {!complete && (
        <div className="mt-4 border-t border-[#f0f0f0] pt-4 dark:border-gray-700">
          <div
            data-testid="quiz-editor"
            className={canSend ? undefined : 'pointer-events-none opacity-50'}
          >
            <ChatEditor
              onSubmit={send}
              loading={busy}
              disabled={!canSend}
              placeholder={
                sessionClosed || refusedForGood
                  ? "This quiz can't continue right now."
                  : EDITOR_PLACEHOLDER
              }
              sendButtonTestId="quiz-send"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The saved transcript (staff, completed attempts)
// ---------------------------------------------------------------------------

function SavedQuizChat({ attempt, transcript, userLogin, userImage, focusMetrics }: QuizChatProps) {
  const { isDarkMode } = useDarkMode();
  const messages = transcript ?? [];
  const complete = Boolean(attempt.completed_at) || hasEvaluation(messages);
  const chatStatus: QuizChatStatus = complete ? 'complete' : 'ready';

  return (
    <div
      className="flex h-full flex-col"
      data-testid="quiz-chat"
      data-quiz-status={chatStatus}
      data-quiz-runtime="trigger_chat"
    >
      <div className="flex flex-1 flex-col overflow-hidden">
        <QuizTranscript
          messages={messages}
          status={chatStatus}
          busy={false}
          isDarkMode={isDarkMode}
          userLogin={userLogin}
          userImage={userImage}
          evaluationRecord={attempt.evaluation_json ?? null}
          focusMetrics={focusMetrics}
          scrollToResults={complete}
          endedAtLimit={attempt.ended_by === 'turn_limit'}
        />
      </div>
    </div>
  );
}

/**
 * Whether this viewer drives the attempt's chat session: its owner, on an
 * attempt that is not complete. Anyone else reads the saved transcript.
 */
export const drivesSession = ({
  readOnly,
  viewerOwnsAttempt,
  attempt,
}: Pick<QuizChatProps, 'readOnly' | 'viewerOwnsAttempt' | 'attempt'>) =>
  !readOnly && viewerOwnsAttempt === true && Boolean(attempt?.id) && !attempt.completed_at;

function QuizChat(props: QuizChatProps) {
  const { isDarkMode } = useDarkMode();
  useHighlightTheme(isDarkMode);
  // Decided once: a refreshed loader (the attempt completing) must not swap
  // the live chat for the saved one under a reply that is still streaming.
  const [live] = useState(() => drivesSession(props));
  return live ? <LiveQuizChat {...props} /> : <SavedQuizChat {...props} />;
}

export default QuizChat;
