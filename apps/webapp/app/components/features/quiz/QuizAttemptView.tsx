import { lazy, Suspense, type ComponentProps } from 'react';
import { Button, Result, Skeleton } from 'antd';
import { ErrorBoundary } from 'react-error-boundary';
import type { QuizUIMessage } from '@classmoji/utils/quiz-agent';
import QuizAttemptInterface from './QuizAttemptInterface';
import type { QuizChatProps } from './QuizChat';

/**
 * The attempt drawer's body, chosen by the runtime the attempt was stamped
 * with when it was created (`attempt.agent_runtime`): `trigger_chat` renders
 * QuizChat, anything else the legacy QuizAttemptInterface with exactly the
 * props it has always received.
 *
 * QuizChat is loaded only when a chat attempt renders: it brings the AI SDK
 * and the Trigger chat client, which no other page needs, and this module is
 * reached from the shared components index. If it cannot be loaded (or fails
 * to render), the drawer offers a reload instead of the route's error page.
 */
const QuizChat = lazy(() => import('./QuizChat'));

type LegacyProps = ComponentProps<typeof QuizAttemptInterface>;

export type QuizAttemptViewProps = LegacyProps & {
  transcript?: QuizUIMessage[] | null;
  viewerOwnsAttempt?: boolean;
  /** A chat attempt's opening was admitted (see QuizChatProps). */
  chatStarted?: boolean;
  /** When a chat attempt last admitted a turn (see QuizChatProps). */
  chatActivity?: QuizChatProps['chatActivity'];
};

export const isChatRuntimeAttempt = (attempt: unknown) =>
  (attempt as { agent_runtime?: unknown } | null)?.agent_runtime === 'trigger_chat';

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
      >
        <Suspense fallback={<QuizChatLoading />}>
          <QuizChat
            quiz={quiz as QuizChatProps['quiz']}
            attempt={attempt as unknown as QuizChatProps['attempt']}
            transcript={transcript ?? []}
            viewerOwnsAttempt={viewerOwnsAttempt === true}
            chatStarted={chatStarted === true}
            chatActivity={chatActivity ?? null}
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
  const {
    transcript: _transcript,
    viewerOwnsAttempt: _owns,
    chatStarted: _started,
    chatActivity: _activity,
    ...legacyProps
  } = props;
  return <QuizAttemptInterface {...legacyProps} />;
}

export default QuizAttemptView;
