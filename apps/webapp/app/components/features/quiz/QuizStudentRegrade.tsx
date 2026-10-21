import { useEffect, useState } from 'react';
import { useFetcher, useLocation } from 'react-router';
import { Alert, Button, Form, Input, Modal } from 'antd';
import dayjs from 'dayjs';
import { useCallout } from '@classmoji/ui-components';
import type { InstructorCommentView, StudentQuizRegradeView } from '~/utils/quizPayloads';
import Emoji from '~/components/ui/display/Emoji';

/**
 * The student's side of a completed quiz attempt: the "Request
 * regrade/resubmit" button in the evaluation card's header (E4), replaced by
 * a "Regrade requested" status while a request is in review (D7), and the
 * blocks above the results: the instructor's comment and the latest resolved
 * request (status, from → to or "Score kept", the staff reply). Posts to the
 * attempt route's own action (`_action: 'requestRegrade'`); the server takes
 * the attempt from the URL and the student from the session.
 */

const formatDate = (iso: string | null) => (iso ? dayjs(iso).format('MMM D') : null);

export const REGRADE_COMMENT_MAX = 2000;

export function QuizRegradeButton({
  quizName,
  attemptNumber,
  regrade,
}: {
  quizName: string;
  attemptNumber: number | null;
  regrade: StudentQuizRegradeView;
}) {
  const fetcher = useFetcher<{ ok?: boolean; created?: boolean; error?: string }>();
  const { pathname } = useLocation();
  const callout = useCallout();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const busy = fetcher.state !== 'idle';

  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    if (fetcher.data.error) {
      callout.show({ variant: 'error', title: fetcher.data.error });
    } else if (fetcher.data.ok) {
      setOpen(false);
      setComment('');
      // An open request already existed (D7): the student is told so, not that a new one went out.
      callout.show({
        variant: fetcher.data.created === false ? 'info' : 'success',
        title:
          fetcher.data.created === false
            ? 'You already have a regrade/resubmit request in review'
            : 'Regrade/resubmit request sent',
      });
    }
  }, [fetcher.state, fetcher.data]);

  if (regrade.open) {
    return (
      <span
        data-testid="quiz-regrade-status"
        className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold bg-sky-500/15 text-sky-700 dark:text-sky-300"
      >
        Regrade requested
      </span>
    );
  }

  const label = ['Quiz', quizName, attemptNumber ? `Attempt ${attemptNumber}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="quiz-regrade-open">
        Request regrade/resubmit
      </Button>
      <Modal
        open={open}
        title="Request regrade/resubmit"
        okText="Request regrade/resubmit"
        onOk={() =>
          fetcher.submit(
            { _action: 'requestRegrade', comment },
            { method: 'POST', action: pathname, encType: 'application/json' }
          )
        }
        onCancel={() => setOpen(false)}
        okButtonProps={{ disabled: !comment.trim(), loading: busy }}
        cancelButtonProps={{ danger: true, type: 'primary', disabled: busy }}
        destroyOnClose
      >
        <Alert message="Explain your regrade/resubmit request below." type="info" showIcon banner />
        <Form layout="vertical" className="mt-4">
          <Form.Item label="Assignment">
            <span data-testid="quiz-regrade-target" className="text-gray-800 dark:text-gray-100">
              {label}
            </span>
          </Form.Item>
          <Form.Item label="Comment" required>
            <Input.TextArea
              data-testid="quiz-regrade-comment"
              rows={6}
              value={comment}
              maxLength={REGRADE_COMMENT_MAX}
              onChange={e => setComment(e.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

export function QuizStudentGradeNotes({
  comment,
  regrade,
  currentEmoji,
}: {
  comment: InstructorCommentView | null;
  regrade: StudentQuizRegradeView;
  /** The attempt's grade now, as the classroom's emoji. */
  currentEmoji: string | null;
}) {
  const resolved = regrade.resolved;
  if (!comment && !resolved) return null;
  return (
    <div className="mb-4 flex flex-col gap-3">
      {comment && (
        <div
          data-testid="quiz-instructor-comment"
          className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 dark:border-sky-500/30 dark:bg-sky-500/10"
        >
          <div className="mb-1 text-sm font-semibold text-gray-800 dark:text-gray-100">
            Instructor comment
          </div>
          <div className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-100">
            {comment.text}
          </div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {[comment.byName, formatDate(comment.at)].filter(Boolean).join(' · ')}
          </div>
        </div>
      )}
      {resolved && (
        <div
          data-testid="quiz-regrade-resolved"
          className="rounded-xl bg-white px-4 py-3 ring-1 ring-stone-200 dark:bg-neutral-900 dark:ring-neutral-800"
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-gray-800 dark:text-gray-100">
              Regrade/resubmit request:
            </span>
            <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-green-500/15 text-green-700 dark:text-green-300">
              Resolved
            </span>
            {resolved.status === 'APPROVED' ? (
              <span className="inline-flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
                Score adjusted
                {resolved.previousEmoji && (
                  <>
                    <Emoji emoji={resolved.previousEmoji} fontSize={16} />
                    <span className="text-gray-400">→</span>
                  </>
                )}
                {currentEmoji && <Emoji emoji={currentEmoji} fontSize={16} />}
              </span>
            ) : (
              <span className="text-gray-600 dark:text-gray-300">Score kept</span>
            )}
          </div>
          {resolved.reply && (
            <div className="mt-2 whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-100">
              {resolved.reply}
            </div>
          )}
          {(resolved.resolvedByName || resolved.resolvedAt) && (
            <div
              data-testid="quiz-regrade-resolved-by"
              className="mt-1 text-xs text-gray-500 dark:text-gray-400"
            >
              {[resolved.resolvedByName, formatDate(resolved.resolvedAt)]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
