import { lazy, Suspense, type ComponentProps } from 'react';
import { Skeleton } from 'antd';
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
 * reached from the shared components index.
 */
const QuizChat = lazy(() => import('./QuizChat'));

type LegacyProps = ComponentProps<typeof QuizAttemptInterface>;

export type QuizAttemptViewProps = LegacyProps & {
  transcript?: QuizUIMessage[] | null;
  viewerOwnsAttempt?: boolean;
};

export const isChatRuntimeAttempt = (attempt: unknown) =>
  (attempt as { agent_runtime?: unknown } | null)?.agent_runtime === 'trigger_chat';

/** Shown while the chat loads. */
const QuizChatLoading = () => (
  <div className="flex h-full flex-col px-4 pt-2" data-testid="quiz-chat-loading">
    <Skeleton active title={false} paragraph={{ rows: 4 }} />
  </div>
);

function QuizAttemptView(props: QuizAttemptViewProps) {
  if (isChatRuntimeAttempt(props.attempt)) {
    const { quiz, attempt, transcript, viewerOwnsAttempt, readOnly, userLogin, userImage } = props;
    // Keyed by attempt: the preview's "start new" navigates to another attempt
    // on the same drawer route, and a chat never carries over between attempts.
    return (
      <Suspense fallback={<QuizChatLoading />}>
        <QuizChat
          key={String((attempt as { id?: unknown } | null)?.id ?? '')}
          quiz={quiz as QuizChatProps['quiz']}
          attempt={attempt as unknown as QuizChatProps['attempt']}
          transcript={transcript ?? []}
          viewerOwnsAttempt={viewerOwnsAttempt === true}
          readOnly={Boolean(readOnly)}
          userLogin={userLogin ?? null}
          userImage={userImage ?? null}
          focusMetrics={(props.focusMetrics as QuizChatProps['focusMetrics']) ?? null}
          isVisible={props.isVisible ?? true}
        />
      </Suspense>
    );
  }
  const { transcript: _transcript, viewerOwnsAttempt: _owns, ...legacyProps } = props;
  return <QuizAttemptInterface {...legacyProps} />;
}

export default QuizAttemptView;
