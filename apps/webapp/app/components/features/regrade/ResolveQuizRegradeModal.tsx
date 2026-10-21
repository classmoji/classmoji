import { useEffect, useState } from 'react';
import { Button, Input, Modal, Segmented } from 'antd';
import { useFetcher, useLocation } from 'react-router';
import { useCallout } from '@classmoji/ui-components';
import { countedQuizEmoji } from '@classmoji/utils';

import UserAvatar from '~/components/shared/UserAvatar';
import Emoji from '~/components/ui/display/Emoji';
import QuizGradeEmoji from '~/components/features/quiz/QuizGradeEmoji';
import QuizEmojiPicker from '~/components/features/quiz/QuizEmojiPicker';
import { quizRequestLabel, type RegradeRequestRowData } from './types';

type Remedy = 'adjust' | 'keep';

interface ResolveQuizRegradeModalProps {
  /** An open quiz request (`quiz` set). Null closes the modal. */
  request: RegradeRequestRowData | null;
  /** The classroom's scale, emoji → grade. */
  scale: Record<string, number>;
  /** `late_penalty_points_per_hour`: what the Counted line takes off a late attempt. */
  latePenaltyPerHour: number;
  onClose: () => void;
}

const LateNote = ({ hours }: { hours: number }) => (
  <span className="text-xs text-ink-3">{hours > 0 ? `${hours}h late` : 'On time'}</span>
);

/**
 * Resolve a quiz regrade/resubmit request: Adjust score (APPROVED, with an
 * emoji off the classroom's scale) or Keep score (DENIED). A reply to the
 * student is required either way. Posts to the requests page's own action.
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
  const [remedy, setRemedy] = useState<Remedy>('adjust');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  // The request the last submission was for, so an earlier request's error
  // never shows on the next one opened.
  const [submittedFor, setSubmittedFor] = useState<string | null>(null);

  // A fresh form for every request opened.
  useEffect(() => {
    setRemedy('adjust');
    setEmoji(null);
    setReply('');
  }, [request?.id]);

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
  const canSubmit = reply.trim().length > 0 && (remedy === 'keep' || Boolean(emoji));
  const title = remedy === 'adjust' ? 'Adjust score' : 'Keep score';

  const submit = () => {
    if (!request || !canSubmit) return;
    setSubmittedFor(request.id);
    fetcher.submit(
      {
        intent: 'resolve-quiz',
        requestId: request.id,
        resolution: remedy === 'adjust' ? 'APPROVED' : 'DENIED',
        emoji: remedy === 'adjust' ? emoji : null,
        comment: reply.trim(),
      },
      { method: 'post', action: pathname, encType: 'application/json' }
    );
  };

  // The same helper as the attempt drawer's Counted line.
  const counted = countedQuizEmoji(emoji, scale, late, latePenaltyPerHour);

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
          disabled={!canSubmit}
          data-testid="resolve-quiz-submit"
        >
          {title}
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

          <Segmented
            value={remedy}
            onChange={value => setRemedy(value as Remedy)}
            options={[
              { value: 'adjust', label: 'Adjust score' },
              { value: 'keep', label: 'Keep score' },
            ]}
          />

          <div>
            <div className="text-[13px] text-ink-3 mb-1">Student comment</div>
            <div className="rounded-md px-3 py-2 bg-stone-50 dark:bg-neutral-800/60 ring-1 ring-stone-200 dark:ring-neutral-700 text-ink-1 whitespace-pre-wrap break-words">
              {request.student_comment || (
                <span className="italic text-gray-400 dark:text-gray-500">No comment</span>
              )}
            </div>
          </div>

          {remedy === 'adjust' ? (
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-4 gap-y-3">
              <span className="text-[13px] text-ink-3">Original</span>
              <span>
                <QuizGradeEmoji emoji={quiz.originalEmoji} size="md" />
              </span>
              {quiz.adjusted && (
                <>
                  <span className="text-[13px] text-ink-3">Current</span>
                  <span>
                    <QuizGradeEmoji emoji={quiz.effectiveEmoji} adjusted size="md" />
                  </span>
                </>
              )}
              <span className="text-[13px] text-ink-3">Adjusted</span>
              <span>
                <QuizEmojiPicker
                  scaleEmojis={Object.keys(scale)}
                  value={emoji}
                  onChange={setEmoji}
                  disabled={submitting}
                />
              </span>
              <span className="text-[13px] text-ink-3">Counted</span>
              <span className="inline-flex items-center gap-2">
                {counted ? (
                  <Emoji emoji={counted} fontSize={20} />
                ) : (
                  <span className="text-gray-400 dark:text-gray-500">—</span>
                )}
                <LateNote hours={late} />
              </span>
            </div>
          ) : (
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-4 gap-y-3">
              <span className="text-[13px] text-ink-3">Grade</span>
              <span className="inline-flex items-center gap-2">
                <QuizGradeEmoji
                  emoji={quiz.effectiveEmoji}
                  originalEmoji={quiz.originalEmoji}
                  adjusted={quiz.adjusted}
                  size="md"
                />
                {late === 0 && <LateNote hours={0} />}
              </span>
              {late > 0 && (
                <>
                  <span className="text-[13px] text-ink-3">Counted</span>
                  <span className="inline-flex items-center gap-2">
                    <QuizGradeEmoji emoji={quiz.countedEmoji ?? null} size="md" />
                    <LateNote hours={late} />
                  </span>
                </>
              )}
            </div>
          )}

          <div>
            <label htmlFor="resolve-quiz-reply" className="block text-sm text-ink-1 mb-1">
              <span className="text-red-500 mr-1">*</span>Reply to student
            </label>
            <Input.TextArea
              id="resolve-quiz-reply"
              rows={3}
              value={reply}
              onChange={e => setReply(e.target.value)}
              disabled={submitting}
              maxLength={2000}
            />
          </div>

          {fetcher.data?.error && fetcher.state === 'idle' && submittedFor === request.id && (
            <div className="text-sm text-rose-600 dark:text-rose-400">{fetcher.data.error}</div>
          )}
        </div>
      )}
    </Modal>
  );
};

export default ResolveQuizRegradeModal;
