import { useEffect, useState } from 'react';
import { Button, Modal } from 'antd';
import { useFetcher, useLocation } from 'react-router';
import { useCallout } from '@classmoji/ui-components';
import { countedQuizEmoji } from '@classmoji/utils';

import UserAvatar from '~/components/shared/UserAvatar';
import { quizRequestLabel, type RegradeRequestRowData } from './types';
import { QuizResolveFields, useQuizResolveForm } from './QuizResolveForm';

interface ResolveQuizRegradeModalProps {
  /** An open quiz request (`quiz` set). Null closes the modal. */
  request: RegradeRequestRowData | null;
  /** The classroom's scale, emoji → grade. */
  scale: Record<string, number>;
  /** `late_penalty_points_per_hour`: what the Counted line takes off a late attempt. */
  latePenaltyPerHour: number;
  onClose: () => void;
}

/**
 * Resolve a quiz regrade/resubmit request from the queue: the shared form
 * (`QuizResolveFields`, also in the attempt drawer) in a modal. Posts to the
 * requests page's own action.
 */
const ResolveQuizRegradeModal = ({
  request,
  scale,
  latePenaltyPerHour,
  onClose,
}: ResolveQuizRegradeModalProps) => {
  const fetcher = useFetcher<{ success?: string; info?: string; error?: string }>();
  const { pathname } = useLocation();
  const callout = useCallout();
  const form = useQuizResolveForm(request?.id);
  // The request the last submission was for, so an earlier request's error
  // never shows on the next one opened.
  const [submittedFor, setSubmittedFor] = useState<string | null>(null);

  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data || !submittedFor) return;
    if (fetcher.data.success || fetcher.data.info) {
      callout.show({
        variant: fetcher.data.success ? 'success' : 'info',
        title: (fetcher.data.success ?? fetcher.data.info) as string,
        autoDismissMs: 2000,
      });
      setSubmittedFor(null);
      onClose();
    }
    // `callout` is stable per provider; `onClose` is the table's setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const quiz = request?.quiz ?? null;
  const late = quiz?.lateHours ?? 0;
  const submitting = fetcher.state !== 'idle';

  const submit = () => {
    if (!request || !form.canSubmit) return;
    setSubmittedFor(request.id);
    fetcher.submit(
      { intent: 'resolve-quiz', requestId: request.id, ...form.payload() },
      { method: 'post', action: pathname, encType: 'application/json' }
    );
  };

  return (
    <Modal
      open={Boolean(request && quiz)}
      title="Resolve request"
      onCancel={onClose}
      destroyOnHidden
      footer={[
        <Button key="cancel" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>,
        <Button
          key="submit"
          type="primary"
          onClick={submit}
          loading={submitting}
          disabled={!form.canSubmit}
          data-testid="resolve-quiz-submit"
        >
          {form.submitLabel}
        </Button>,
      ]}
    >
      {request && quiz && (
        <div className="flex flex-col gap-4 pt-1">
          <div className="flex items-center gap-2.5">
            <UserAvatar
              image={request.student.image}
              name={request.student.name}
              login={request.student.login}
              size={32}
            />
            <div className="min-w-0">
              <div className="font-semibold text-ink-1 truncate">
                {request.student.name ?? request.student.login}
              </div>
              <div className="text-xs text-ink-3 truncate">{quizRequestLabel(quiz)}</div>
            </div>
          </div>

          <div>
            <div className="text-[13px] text-ink-3 mb-1">Student comment</div>
            <div className="rounded-md px-3 py-2 bg-stone-50 dark:bg-neutral-800/60 ring-1 ring-stone-200 dark:ring-neutral-700 text-ink-1 whitespace-pre-wrap break-words">
              {request.student_comment || (
                <span className="italic text-gray-400 dark:text-gray-500">No comment</span>
              )}
            </div>
          </div>

          <QuizResolveFields
            form={form}
            grade={{
              originalEmoji: quiz.originalEmoji,
              effectiveEmoji: quiz.effectiveEmoji,
              adjusted: quiz.adjusted,
              lateHours: late,
              countedEmoji: quiz.countedEmoji ?? null,
            }}
            scaleEmojis={Object.keys(scale)}
            // The same helper as the attempt drawer's Counted line.
            countedFor={emoji => countedQuizEmoji(emoji, scale, late, latePenaltyPerHour)}
            disabled={submitting}
            idPrefix="resolve-quiz"
            error={
              fetcher.data?.error && fetcher.state === 'idle' && submittedFor === request.id
                ? fetcher.data.error
                : null
            }
          />
        </div>
      )}
    </Modal>
  );
};

export default ResolveQuizRegradeModal;
