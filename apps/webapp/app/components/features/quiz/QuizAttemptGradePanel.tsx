import { useEffect, useState } from 'react';
import { Link, useFetcher, useLocation } from 'react-router';
import { App, Button, Input } from 'antd';
import dayjs from 'dayjs';
import { useCallout } from '@classmoji/ui-components';
import type { StaffAttemptGradePanel } from '~/utils/quizPayloads';
import Emoji from '~/components/ui/display/Emoji';
import { LateChip } from './QuizGradeEmoji';
import { QuizEmojiPicker } from './QuizEmojiPicker';

/**
 * The staff side of a completed attempt in its drawer: the "Instructor" panel
 * (grade, adjust with the classroom's scale, a comment to the student,
 * revert) and the open regrade/resubmit request, which is resolved in the
 * queue (`?resolve=<id>` opens its resolve modal there). Emoji only (E1).
 * Posts to the drawer route's own action (`_action: 'adjust' | 'revert'`);
 * the server re-checks everything and returns refusals as data. In a
 * read-only classroom (`panel.canEdit` false) only the grade shows.
 */

const formatDate = (iso: string | null) => (iso ? dayjs(iso).format('MMM D') : null);

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-center gap-3 py-1.5">
    <div className="w-24 shrink-0 text-sm text-gray-500 dark:text-gray-400">{label}</div>
    <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
  </div>
);

/**
 * What the attempt counts for after its late penalty. While an emoji is being
 * picked (`pick`), what that emoji would count for (`panel.countedByEmoji`).
 */
const Counted = ({
  panel,
  pick = null,
  label = true,
}: {
  panel: StaffAttemptGradePanel;
  pick?: string | null;
  label?: boolean;
}) => {
  const grade = panel.grade;
  const late = grade?.lateHours ?? 0;
  if (!grade || (!grade.countedEmoji && !(late > 0))) return null;
  const counted = pick
    ? (panel.countedByEmoji[pick] ?? pick)
    : (grade.countedEmoji ?? grade.emoji ?? null);
  return (
    <span
      data-testid="quiz-adjust-counted"
      className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400"
    >
      {label && 'Counted'}
      {counted ? (
        <Emoji emoji={counted} fontSize={16} />
      ) : (
        <span className="text-gray-400 dark:text-gray-500">—</span>
      )}
      {late > 0 ? <LateChip hours={late} /> : null}
    </span>
  );
};

/** Under the adjust panel: the attempt's open request, resolved in the queue. */
const OpenRequestNote = ({ resolveUrl }: { resolveUrl: string }) => (
  <div
    data-testid="quiz-adjust-open-request"
    className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 px-4 py-2.5 text-sm text-amber-800 dark:border-neutral-800 dark:text-amber-300"
  >
    <span>This attempt has an open regrade/resubmit request</span>
    <Link
      to={resolveUrl}
      className="font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200"
    >
      Resolve request
    </Link>
  </div>
);

export function QuizRegradeRequestBanner({
  request,
  resolveUrl,
}: {
  request: NonNullable<StaffAttemptGradePanel['openRequest']>;
  /** The queue with this request's resolve modal open (`?resolve=<id>`). */
  resolveUrl: string;
}) {
  return (
    <div
      data-testid="quiz-regrade-banner"
      className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/40 dark:bg-amber-500/10"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-semibold text-amber-800 dark:text-amber-300">
          Regrade/resubmit request
        </span>
        <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300">
          In Review
        </span>
      </div>
      {request.comment && (
        <div className="whitespace-pre-wrap rounded-md bg-white px-3 py-2 text-sm text-gray-800 ring-1 ring-amber-200 dark:bg-neutral-900 dark:text-gray-100 dark:ring-amber-500/30">
          {request.comment}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-amber-800/80 dark:text-amber-300/80">
          {[
            request.studentName,
            request.createdAt ? dayjs(request.createdAt).format('MMM D, h:mm A') : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <Link
          to={resolveUrl}
          className="text-sm font-medium text-amber-800 underline underline-offset-2 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-200"
        >
          Resolve in Regrade/Resubmit Requests
        </Link>
      </div>
    </div>
  );
}

export function QuizAttemptGradePanel({
  panel,
  resolveUrl = null,
}: {
  panel: StaffAttemptGradePanel;
  /** The open request's resolve modal in the queue, when there is one. */
  resolveUrl?: string | null;
}) {
  const fetcher = useFetcher<{ ok?: boolean; success?: string; error?: string }>();
  const { pathname } = useLocation();
  const callout = useCallout();
  const { modal } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState<string | null>(panel.adjustedEmoji);
  const [comment, setComment] = useState(panel.comment ?? '');
  const busy = fetcher.state !== 'idle';
  const grade = panel.grade;

  // A fresh panel (after a save, or another attempt) starts from the saved state.
  useEffect(() => {
    setPick(panel.adjustedEmoji);
    setComment(panel.comment ?? '');
  }, [panel.attemptId, panel.adjustedEmoji, panel.comment]);

  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    if (fetcher.data.error) {
      callout.show({ variant: 'error', title: fetcher.data.error });
    } else if (fetcher.data.ok) {
      setEditing(false);
      if (fetcher.data.success) {
        callout.show({ variant: 'success', title: fetcher.data.success, autoDismissMs: 2000 });
      }
    }
    // `callout` is stable per provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const submit = (body: Record<string, unknown>) =>
    fetcher.submit(body as never, {
      method: 'POST',
      action: pathname,
      encType: 'application/json',
    });

  const save = () => {
    const body: Record<string, unknown> = {
      _action: 'adjust',
      attemptId: panel.attemptId,
      comment,
    };
    if (pick && pick !== panel.adjustedEmoji) body.emoji = pick;
    submit(body);
  };

  const revert = () =>
    modal.confirm({
      title: 'Revert the adjustment?',
      content: "The AI's grade counts again. The comment to the student stays.",
      okText: 'Revert',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () => submit({ _action: 'revert', attemptId: panel.attemptId }),
    });

  const canEdit = panel.canEdit;
  const header = (
    <div className="flex items-center justify-between border-b border-stone-200 px-4 py-2.5 dark:border-neutral-800">
      <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">Instructor</span>
      {canEdit && !editing && (grade?.adjusted || panel.comment) && (
        <Button size="small" onClick={() => setEditing(true)}>
          Edit
        </Button>
      )}
    </div>
  );

  let body: React.ReactNode;
  if (editing && canEdit) {
    body = (
      <div className="px-4 py-3">
        <Row label="Original">
          <Emoji
            emoji={(grade?.adjusted ? grade.originalEmoji : grade?.emoji) ?? ''}
            fontSize={18}
          />
        </Row>
        <Row label="Adjusted">
          <QuizEmojiPicker
            scaleEmojis={panel.scaleEmojis}
            value={pick}
            onChange={setPick}
            disabled={busy}
          />
        </Row>
        {(grade?.countedEmoji || (grade?.lateHours ?? 0) > 0) && (
          <Row label="Counted">
            <Counted panel={panel} pick={pick} label={false} />
          </Row>
        )}
        <div className="mt-2">
          <label
            htmlFor={`quiz-adjust-comment-${panel.attemptId}`}
            className="mb-1 block text-sm text-gray-700 dark:text-gray-300"
          >
            Comment to student <span className="text-gray-400">(optional)</span>
          </label>
          <Input.TextArea
            id={`quiz-adjust-comment-${panel.attemptId}`}
            data-testid="quiz-adjust-comment"
            rows={3}
            value={comment}
            maxLength={5000}
            onChange={e => setComment(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button
            onClick={() => {
              setEditing(false);
              setPick(panel.adjustedEmoji);
              setComment(panel.comment ?? '');
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="primary" onClick={save} loading={busy} data-testid="quiz-adjust-save">
            Save
          </Button>
        </div>
      </div>
    );
  } else if (grade?.adjusted || panel.comment) {
    const by = [panel.adjustedByName, formatDate(panel.adjustedAt)].filter(Boolean).join(' · ');
    const commentBy = [panel.commentByName, formatDate(panel.commentAt)]
      .filter(Boolean)
      .join(' · ');
    body = (
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {grade?.adjusted ? (
            <span className="inline-flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
              Adjusted
              <Emoji emoji={grade.originalEmoji ?? ''} fontSize={18} />
              <span className="text-gray-400">→</span>
              <Emoji emoji={grade.emoji ?? ''} fontSize={18} />
              {by && <span className="text-xs text-gray-500 dark:text-gray-400">by {by}</span>}
              {canEdit && (
                <button
                  type="button"
                  onClick={revert}
                  disabled={busy}
                  data-testid="quiz-adjust-revert"
                  className="cursor-pointer text-sm text-red-600 underline underline-offset-2 hover:text-red-700 disabled:opacity-50 dark:text-red-400"
                >
                  Revert
                </button>
              )}
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
              Grade
              <Emoji emoji={grade?.emoji ?? ''} fontSize={18} />
            </span>
          )}
          <Counted panel={panel} />
        </div>
        {panel.comment && (
          <div className="mt-3">
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Comment to student
              {commentBy && <span data-testid="quiz-comment-by"> · {commentBy}</span>}
            </div>
            <div className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-100">
              {panel.comment}
            </div>
          </div>
        )}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <span className="inline-flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          Grade
          <Emoji emoji={grade?.emoji ?? ''} fontSize={18} />
          <Counted panel={panel} />
        </span>
        {canEdit && (
          <div className="flex gap-2">
            <Button onClick={() => setEditing(true)} data-testid="quiz-adjust-open">
              Adjust score
            </Button>
            <Button onClick={() => setEditing(true)}>Add comment</Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="quiz-adjust-panel"
      className="mb-4 rounded-xl bg-white ring-1 ring-stone-200 dark:bg-neutral-900 dark:ring-neutral-800"
    >
      {header}
      {body}
      {resolveUrl && <OpenRequestNote resolveUrl={resolveUrl} />}
    </div>
  );
}

export default QuizAttemptGradePanel;
