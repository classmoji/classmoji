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
  GRADING_RULE_SENTENCE,
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
import StepList, { type QuizStep } from './StepList';
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
 * other part (reasoning, internal tools, unknown data) renders nothing.
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

/** A part that renders inside the assistant's bubble. */
const rendersInBubble = (part: QuizPart) => {
  switch (part.type) {
    case 'text':
      return part.text.trim().length > 0;
    case 'data-question-result':
    case 'data-notice':
      return true;
    case 'tool-present_question':
      return part.state !== 'output-error' && part.state !== 'output-denied';
    case 'tool-offer_next_step':
      return part.state === 'output-available';
    default:
      return false;
  }
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

const Bubble = ({ variant, children }: { variant: 'assistant' | 'user'; children: ReactNode }) => (
  <div
    className={
      variant === 'assistant'
        ? 'min-w-fit max-w-[70%] break-words rounded-lg border border-[#d9d9d9] bg-white px-4 py-3 text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100'
        : 'min-w-fit max-w-[70%] break-words rounded-lg bg-[#f0f2f5] px-4 py-3 text-gray-900 dark:bg-gray-700 dark:text-gray-100'
    }
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

interface PartContext {
  isDarkMode: boolean;
  /** Buttons are disabled: a later student message exists, a turn is running, or read-only. */
  buttonsDisabled: boolean;
  onButton: ((text: string, action: NextStepAction) => void) | null;
}

/** One part inside the assistant's bubble, by type. */
export function AssistantPart({ part, ctx }: { part: QuizPart; ctx: PartContext }) {
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
      if (part.state === 'input-streaming' || part.state === 'input-available') {
        return <QuestionCardSkeleton />;
      }
      return null;
    }
    case 'tool-offer_next_step':
      return part.state === 'output-available' ? (
        <NextStepButtons
          actions={part.output.actions}
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

/** The transcript: grading rule, messages, the typing indicator, the results panel. */
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

  // The results panel renders once: at the first evaluation part, from the
  // stored record when the loader has it.
  let resultsRendered = false;
  const renderResults = (fallback: QuizEvaluationRecordV2 | null | undefined) => {
    const record = evaluationRecord ?? fallback ?? null;
    if (resultsRendered || !record) return null;
    resultsRendered = true;
    return (
      <div ref={resultsRef}>
        <QuizResults evaluation={record} focusMetrics={focusMetrics} />
      </div>
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

  const lastHasVisibleReply =
    lastMessage?.role === 'assistant' && visibleParts(lastMessage).some(rendersInBubble);
  const showTyping = busy && !lastHasVisibleReply;

  return (
    <div
      tabIndex={0} // eslint-disable-line -- keyboard scrolling of the conversation
      role="log"
      aria-live="polite"
      aria-label="Quiz conversation"
      className="flex-1 overflow-y-auto px-4 pb-4 outline-none"
    >
      <div
        className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        data-testid="quiz-grading-rule"
      >
        {GRADING_RULE_SENTENCE}
      </div>

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
        const ctx: PartContext = {
          isDarkMode,
          buttonsDisabled: answered || busy || status === 'complete' || !onButton,
          onButton,
        };
        const steps = stepsOf(parts);
        const inBubble = parts.filter(rendersInBubble);
        const evaluationPart = parts.find(isEvaluationPart);
        const evaluationFromPart =
          evaluationPart?.type === 'tool-submit_quiz_evaluation' &&
          evaluationPart.state === 'output-available'
            ? evaluationPart.output
            : evaluationPart?.type === 'data-evaluation'
              ? evaluationPart.data
              : null;
        const isStreamingThis = busy && message === lastMessage;

        if (steps.length === 0 && inBubble.length === 0 && !evaluationPart) return null;

        return (
          <div
            key={message.id}
            className="mb-4 flex flex-col items-start"
            data-message-role="assistant"
          >
            {steps.length > 0 && <StepList steps={steps} active={isStreamingThis} />}
            {inBubble.length > 0 && (
              <Space align="start">
                <AssistantAvatar />
                <Bubble variant="assistant">
                  {parts.map((part, i) =>
                    rendersInBubble(part) ? <AssistantPart key={i} part={part} ctx={ctx} /> : null
                  )}
                </Bubble>
              </Space>
            )}
            {evaluationPart && <div className="w-full">{renderResults(evaluationFromPart)}</div>}
          </div>
        );
      })}

      {showTyping && (
        <div className="mb-4 flex justify-start" data-testid="quiz-typing">
          <Space>
            <AssistantAvatar />
            <div className="flex items-center gap-2 rounded-lg border border-[#d9d9d9] bg-white px-4 py-3 dark:border-gray-600 dark:bg-gray-800">
              <TypingIndicator color="#10b981" />
              <Text type="secondary">Thinking...</Text>
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

  /** Save the time so far now (before the attempt completes). */
  return { flush: sendUpdate };
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

  const transport = useTriggerChatTransport({
    task: QUIZ_CHAT_TASK_ID,
    startSession: async ({ chatId }) => ({
      publicAccessToken: await requestSessionToken(chatId),
    }),
    accessToken: ({ chatId }) => requestSessionToken(chatId),
    ...(persisted ? { sessions: { [attemptId]: persisted } } : {}),
    onSessionChange: (chatId, state) => persistSession(chatId, state),
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
    typeof transport.sessionStatus === 'function' &&
    transport.sessionStatus(attemptId) === 'closed';
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
  useEffect(() => {
    if (beganRef.current || initialMessages.length > 0 || resuming) return;
    begin();
  }, [begin, initialMessages.length, resuming]);

  // Once the evaluation is in and the reply has finished, refresh the drawer
  // (its title and close prompt read the completed attempt).
  const completedRef = useRef(false);
  useEffect(() => {
    if (!evaluationSeen || busy || completedRef.current) return;
    completedRef.current = true;
    revalidateRef.current();
  }, [evaluationSeen, busy]);

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
          focusMetrics={focusMetrics}
          onButton={canSend ? onButton : null}
          errorLine={errorLine}
          onRetryStart={startFailed ? begin : null}
        />
      </div>

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
              complete
                ? 'Quiz completed!'
                : sessionClosed
                  ? "This quiz can't continue right now."
                  : EDITOR_PLACEHOLDER
            }
            sendButtonTestId="quiz-send"
          />
        </div>
      </div>
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
