import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRevalidator } from 'react-router';
import { Avatar, Button, Skeleton, Space, Typography } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { useChat } from '@ai-sdk/react';
import { useChatActions, useTriggerChatTransport } from '@trigger.dev/sdk/chat/react';
import type { ChatSessionPersistedState } from '@trigger.dev/sdk/chat';
import {
  QUIZ_AGENT_ERROR_COPY,
  QUIZ_FAILURE_COPY,
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
 * marker from `data-question-result`, the Try again / Next buttons from
 * `offer_next_step`, the results panel from the stored evaluation record. Any
 * other part (reasoning, internal tools, unknown data) renders nothing. Parts
 * render in arrival order, except that a question's marker renders above a
 * later question's card in the same message (`displayOrder`). As in the legacy
 * chat, a marker is not inside a bubble: it gets its own row with its own
 * avatar, and what follows it (the files read, the next card) starts a new
 * bubble (`messageBlocks`). The rest follows the legacy chat's flow too: the
 * opening reply's welcome is a bubble of its own, above the files read and
 * question 1; text after a question card is not shown; a card waits for the
 * marker of the question before it; the activity line ("Thinking...",
 * "Exploring code...", "Looking things up…") stays up until a card, the
 * buttons or a notice arrive;
 * the evaluation's closing line sits above the results panel.
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
}

export interface QuizChatProps {
  quiz: { id: string; question_count?: number | null };
  attempt: QuizChatAttempt;
  /** The projected transcript from the loader. */
  transcript?: QuizUIMessage[] | null;
  /** The viewer is the attempt's owner (decided by the loader). */
  viewerOwnsAttempt?: boolean;
  readOnly?: boolean;
  userLogin?: string | null;
  userImage?: string | null;
  focusMetrics?: ResultsFocusMetrics | null;
  isVisible?: boolean;
}

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
 * Lines the server writes as fixed copy for students (api.quiz, the session
 * route, the task's sanitized errors). An error whose text is one of these is
 * shown as is; any other error text (a network failure, a library message, the
 * AI SDK's own "An error occurred.") is replaced by REPLY_FAILED_LINE. The
 * task's lines come from the module its sanitizer writes them from.
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

/** A session token for the attempt, from the session route (start and refresh alike). */
export const requestSessionToken = async (attemptId: string): Promise<string> => {
  const response = await fetch('/api/quiz-chat/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ attemptId }),
  });
  const body = (await response.json().catch(() => null)) as {
    publicAccessToken?: unknown;
    message?: unknown;
    code?: unknown;
  } | null;
  if (!response.ok || typeof body?.publicAccessToken !== 'string') {
    const message =
      typeof body?.message === 'string' && FIXED_ERROR_COPY.has(body.message)
        ? body.message
        : START_FAILED_LINE;
    throw new QuizChatSessionError(message, typeof body?.code === 'string' ? body.code : null);
  }
  return body.publicAccessToken;
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
 * A part of the assistant's reply that renders: inside a bubble, or (a
 * question's marker) in its own row. A question card still arriving shows its
 * placeholder only while its message is streaming, so a turn that ended before
 * the card leaves no empty card behind, and only in a bubble that already
 * shows something (`messageBlocks`). With `streaming` false this is the set of
 * settled parts.
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
      return part.state === 'output-available';
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

/** A part that ends the wait for the reply: a card, the buttons, or a notice. */
const endsTheWait = (part: QuizPart) =>
  part.type === 'tool-present_question' ||
  part.type === 'tool-offer_next_step' ||
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

/** The line offer_next_step puts above its buttons, when it has one. */
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
  /** Buttons are disabled: a later student message exists, a turn is running, or read-only. */
  buttonsDisabled: boolean;
  onButton: ((text: string, action: NextStepAction) => void) | null;
}

/** One part inside the assistant's bubble, by type. */
export function AssistantPart({ part, ctx }: { part: QuizPart; ctx: PartContext }) {
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
    case 'tool-offer_next_step':
      return part.state === 'output-available' ? (
        <NextStepButtons
          actions={part.output.actions}
          leadIn={leadInOf(part.output)}
          disabled={ctx.buttonsDisabled}
          onAction={ctx.onButton}
        />
      ) : null;
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
}: TranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const shown = messages.filter(m => !m.metadata?.hidden);
  const lastMessage = shown[shown.length - 1];
  // The opening reply: its welcome is a bubble of its own.
  const openingId = shown.find(m => m.role === 'assistant')?.id;

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
          <QuizResults evaluation={record} focusMetrics={focusMetrics} />
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

        const answered = shown.slice(index + 1).some(m => m.role === 'user');
        const isStreamingThis = busy && message === lastMessage;
        const ctx: PartContext = {
          isDarkMode,
          streaming: isStreamingThis,
          buttonsDisabled: answered || busy || status === 'complete' || !onButton,
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
                          <AssistantPart key={index} part={part} ctx={ctx} />
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
                          <AssistantPart key={index} part={part} ctx={ctx} />
                        ))}
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

function LiveQuizChat({
  attempt,
  transcript,
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
  // The session closed while this chat was open: the task closes it on every
  // permanent refusal and once the attempt is complete.
  const [closedWhileOpen, setClosedWhileOpen] = useState(false);

  const transport = useTriggerChatTransport({
    task: QUIZ_CHAT_TASK_ID,
    startSession: async ({ chatId }) => ({
      publicAccessToken: await requestSessionToken(chatId),
    }),
    accessToken: ({ chatId }) => requestSessionToken(chatId),
    ...(persisted ? { sessions: { [attemptId]: persisted } } : {}),
    onSessionChange: (chatId, state) => {
      persistSession(chatId, state);
      if (state?.closed) setClosedWhileOpen(true);
    },
  });

  const { messages, sendMessage, status, error } = useChat<QuizUIMessage>({
    id: attemptId,
    messages: initialMessages,
    transport,
    // Re-attach to a reply this tab was streaming when the page was reloaded.
    // Only then: a resume and a start must never race on one chat.
    resume: resuming,
  });
  const { sendAction } = useChatActions({ sendMessage });

  const busy = status === 'submitted' || status === 'streaming';
  const evaluationSeen = hasEvaluation(messages);
  const complete = Boolean(attempt.completed_at) || evaluationSeen;
  // A session closed without an evaluation (the attempt can no longer take
  // messages) leaves nothing to send to either.
  const sessionClosed =
    closedWhileOpen ||
    (typeof transport.sessionStatus === 'function' &&
      transport.sessionStatus(attemptId) === 'closed');
  const canSend = !complete && !sessionClosed;

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
  const begin = useCallback(() => {
    beganRef.current = true;
    void sendAction({ type: 'begin' });
  }, [sendAction]);
  // Sent once the mount has held, not from the mount effect itself: useChat
  // stops its chat when it unmounts, which aborts the request in flight, and
  // StrictMode (the client entry) unmounts and remounts every effect once in
  // development. A begin sent from the first mount was aborted that way: the
  // server ran the turn but its reply never reached the drawer. A torn-down
  // mount cancels its pending send; the mount that stays sends it.
  useEffect(() => {
    if (beganRef.current || initialMessages.length > 0 || resuming) return undefined;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && !beganRef.current) begin();
    });
    return () => {
      cancelled = true;
    };
  }, [begin, initialMessages.length, resuming]);

  // Once the evaluation is in, or the attempt can take no more turns (the
  // session closed, or the session route refused it for good), and the reply
  // has finished, refresh the drawer once: its title, close prompt and results
  // panel read the attempt as stored, which a refused turn may have completed.
  const refusedForGood = status === 'error' && isPermanentSessionRefusal(error);
  const ended = evaluationSeen || closedWhileOpen || refusedForGood;
  const refreshedRef = useRef(false);
  useEffect(() => {
    if (!ended || busy || refreshedRef.current) return;
    refreshedRef.current = true;
    revalidateRef.current();
  }, [ended, busy]);

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
  const errorLine = status === 'error' && error ? errorLineFor(error) : null;
  const startFailed = Boolean(errorLine) && shown.length === 0;

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
          errorLine={errorLine}
          onRetryStart={startFailed ? begin : null}
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
                sessionClosed ? "This quiz can't continue right now." : EDITOR_PLACEHOLDER
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
