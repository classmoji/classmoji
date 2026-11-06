import { lazy, Suspense } from 'react';
import { Button, Result, Skeleton } from 'antd';
import { ErrorBoundary } from 'react-error-boundary';
import { captureBoundaryError } from '~/utils/sentry.client';
import { isTriggerChatAttempt } from '@classmoji/utils';
import type { QuizUIMessage } from '@classmoji/utils/quiz-agent';
import LegacyQuizTranscript, { type LegacyQuizTranscriptProps } from './LegacyQuizTranscript';
import type { QuizChatProps } from './QuizChat';

/**
 * The attempt drawer's body, chosen by the runtime the attempt was stamped
 * with when it was created (`attempt.agent_runtime`): `trigger_chat` (every
 * attempt created now) renders QuizChat; anything else is an attempt from the
 * retired ai-agent runtime and renders LegacyQuizTranscript, read-only
 * whatever the drawer passes, completed or not.
 *
 * QuizChat is loaded only when a chat attempt renders: it brings the AI SDK
 * and the Trigger chat client, which no other page needs, and this module is
 * reached from the shared components index. If it cannot be loaded (or fails
 * to render), the drawer offers a reload instead of the route's error page.
 */
const QuizChat = lazy(() => import('./QuizChat'));

export type QuizAttemptViewProps = {
  quiz: Record<string, unknown>;
  attempt: Record<string, unknown> | null;
  /** A legacy attempt's saved messages (a chat attempt sends none). */
  messages?: LegacyQuizTranscriptProps['messages'];
  userLogin: string | null;
  userImage?: string | null;
  readOnly?: boolean;
  focusMetrics?: LegacyQuizTranscriptProps['focusMetrics'];
  isVisible?: boolean;
  onClose?: (newAttemptId?: string) => void;
  transcript?: QuizUIMessage[] | null;
  viewerOwnsAttempt?: boolean;
  /** A chat attempt's opening was admitted (see QuizChatProps). */
  chatStarted?: boolean;
  /** When a chat attempt last admitted a turn (see QuizChatProps). */
  chatActivity?: QuizChatProps['chatActivity'];
  /** How many more messages an open chat attempt admits (see QuizChatProps). */
  messagesLeft?: number | null;
  /** What else the drawer loaders send (org, result, …); unread here. */
  [key: string]: unknown;
};

export const isChatRuntimeAttempt = (attempt: unknown) =>
  isTriggerChatAttempt(attempt as { agent_runtime?: unknown } | null);

/** Shown while the chat loads. */
const QuizChatLoading = () => (
  <div className="flex h-full flex-col px-4 pt-2" data-testid="quiz-chat-loading">
    <Skeleton active title={false} paragraph={{ rows: 4 }} />
  </div>
);

/** Shown when the chat could not be loaded. */
const QuizChatLoadFailed = () => (
  <div className="flex h-full flex-col px-4 pt-2" data-testid="quiz-chat-load-failed">
    <Result
      status="warning"
      title="This quiz couldn't load."
      extra={
        <Button type="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
    />
  </div>
);

function QuizAttemptView(props: QuizAttemptViewProps) {
  if (isChatRuntimeAttempt(props.attempt)) {
    const {
      quiz,
      attempt,
      transcript,
      viewerOwnsAttempt,
      chatStarted,
      chatActivity,
      messagesLeft,
      readOnly,
      userLogin,
      userImage,
    } = props;
    // Keyed by attempt: the preview's "start new" navigates to another attempt
    // on the same drawer route, and a chat never carries over between attempts.
    return (
      <ErrorBoundary
        key={String((attempt as { id?: unknown } | null)?.id ?? '')}
        fallback={<QuizChatLoadFailed />}
        onError={captureBoundaryError}
      >
        <Suspense fallback={<QuizChatLoading />}>
          <QuizChat
            quiz={quiz as QuizChatProps['quiz']}
            attempt={attempt as unknown as QuizChatProps['attempt']}
            transcript={transcript ?? []}
            viewerOwnsAttempt={viewerOwnsAttempt === true}
            chatStarted={chatStarted === true}
            chatActivity={chatActivity ?? null}
            messagesLeft={typeof messagesLeft === 'number' ? messagesLeft : null}
            readOnly={Boolean(readOnly)}
            userLogin={userLogin ?? null}
            userImage={userImage ?? null}
            focusMetrics={(props.focusMetrics as QuizChatProps['focusMetrics']) ?? null}
            isVisible={props.isVisible ?? true}
          />
        </Suspense>
      </ErrorBoundary>
    );
  }
  return (
    <LegacyQuizTranscript
      attempt={props.attempt}
      messages={props.messages}
      userLogin={props.userLogin}
      userImage={props.userImage ?? null}
      focusMetrics={props.focusMetrics ?? null}
    />
  );
}

export default QuizAttemptView;
