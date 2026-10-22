import { useEffect, useState } from 'react';
import { Input, Segmented } from 'antd';
import { QUIZ_REGRADE_REPLY_MAX_LENGTH } from '@classmoji/utils';

import Emoji from '~/components/ui/display/Emoji';
import QuizGradeEmoji from '~/components/features/quiz/QuizGradeEmoji';
import QuizEmojiPicker from '~/components/features/quiz/QuizEmojiPicker';

/**
 * The body of a quiz regrade/resubmit resolution, shared by the queue's
 * resolve modal (`ResolveQuizRegradeModal`) and the staff attempt drawer's
 * request banner (E13): Adjust score (APPROVED, an emoji off the classroom's
 * scale) or Keep score (DENIED), the grade rows (original, current, the
 * picker, what it counts for after the late penalty) and the required reply
 * to the student. Each caller keeps its own frame, buttons and POST target;
 * `useQuizResolveForm` holds the state both read.
 */

export type QuizResolveRemedy = 'adjust' | 'keep';

/** The attempt's grade as the form shows it: emoji only (E1). */
export interface QuizResolveGrade {
  originalEmoji: string | null;
  effectiveEmoji: string | null;
  adjusted: boolean;
  /** Whole hours late; 0 on time; null when the quiz has no due date. */
  lateHours: number | null;
  /** The current grade after the late penalty. */
  countedEmoji: string | null;
}

export interface QuizResolveFormState {
  remedy: QuizResolveRemedy;
  setRemedy: (remedy: QuizResolveRemedy) => void;
  emoji: string | null;
  setEmoji: (emoji: string | null) => void;
  reply: string;
  setReply: (reply: string) => void;
  /** A reply, and an emoji when adjusting. */
  canSubmit: boolean;
  /** "Adjust score" / "Keep score": the submit button's label. */
  submitLabel: string;
  /** What both POST targets read. */
  payload: () => {
    resolution: 'APPROVED' | 'DENIED';
    emoji: string | null;
    comment: string;
  };
}

/**
 * The form's state, fresh whenever `resetKey` (the request id) changes.
 * `currentEmoji` is the grade the attempt shows now: Adjust with it is a Keep
 * (the server resolves it DENIED), so the button says "Keep score".
 */
export const useQuizResolveForm = (
  resetKey: string | null | undefined,
  currentEmoji: string | null = null
): QuizResolveFormState => {
  const [remedy, setRemedy] = useState<QuizResolveRemedy>('adjust');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [reply, setReply] = useState('');

  useEffect(() => {
    setRemedy('adjust');
    setEmoji(null);
    setReply('');
  }, [resetKey]);

  const keepsScore = remedy === 'keep' || (Boolean(emoji) && emoji === currentEmoji);
  return {
    remedy,
    setRemedy,
    emoji,
    setEmoji,
    reply,
    setReply,
    canSubmit:
      reply.trim().length > 0 &&
      reply.trim().length <= QUIZ_REGRADE_REPLY_MAX_LENGTH &&
      (remedy === 'keep' || Boolean(emoji)),
    submitLabel: keepsScore ? 'Keep score' : 'Adjust score',
    payload: () => ({
      resolution: remedy === 'adjust' ? 'APPROVED' : 'DENIED',
      emoji: remedy === 'adjust' ? emoji : null,
      comment: reply.trim(),
    }),
  };
};

/** "Nh late" / "On time"; nothing for a quiz with no due date (`hours` null). */
const LateNote = ({ hours }: { hours: number | null }) =>
  hours === null ? null : (
    <span className="text-xs text-ink-3">{hours > 0 ? `${hours}h late` : 'On time'}</span>
  );

export function QuizResolveFields({
  form,
  grade,
  scaleEmojis,
  countedFor,
  disabled = false,
  idPrefix,
  error = null,
}: {
  form: QuizResolveFormState;
  grade: QuizResolveGrade;
  /** The classroom's scale, best first: what the picker offers. */
  scaleEmojis: string[];
  /** What a picked emoji counts for after the late penalty. */
  countedFor: (emoji: string | null) => string | null;
  disabled?: boolean;
  /** Keeps the reply's label/id pair unique on the page. */
  idPrefix: string;
  /** The last submission's refusal, shown under the reply. */
  error?: string | null;
}) {
  const lateNote = grade.lateHours;
  const late = lateNote ?? 0;
  const counted = countedFor(form.emoji);
  const picksCurrent = Boolean(form.emoji) && form.emoji === grade.effectiveEmoji;
  const replyId = `${idPrefix}-reply`;

  return (
    <div className="flex flex-col gap-4">
      <Segmented
        value={form.remedy}
        onChange={value => form.setRemedy(value as QuizResolveRemedy)}
        disabled={disabled}
        options={[
          { value: 'adjust', label: 'Adjust score' },
          { value: 'keep', label: 'Keep score' },
        ]}
        className="self-start"
      />

      {form.remedy === 'adjust' ? (
        <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-4 gap-y-3">
          <span className="text-[13px] text-ink-3">Original</span>
          <span>
            <QuizGradeEmoji emoji={grade.originalEmoji} size="md" />
          </span>
          {grade.adjusted && (
            <>
              <span className="text-[13px] text-ink-3">Current</span>
              <span>
                <QuizGradeEmoji emoji={grade.effectiveEmoji} adjusted size="md" />
              </span>
            </>
          )}
          <span className="text-[13px] text-ink-3">Adjusted</span>
          <span>
            <QuizEmojiPicker
              scaleEmojis={scaleEmojis}
              value={form.emoji}
              onChange={form.setEmoji}
              disabled={disabled}
              currentEmoji={grade.effectiveEmoji}
            />
          </span>
          {picksCurrent && (
            <>
              <span />
              <span data-testid="quiz-resolve-keeps" className="text-xs text-ink-3">
                That is the current grade: picking it keeps the score.
              </span>
            </>
          )}
          <span className="text-[13px] text-ink-3">Counted</span>
          <span data-testid="quiz-resolve-counted" className="inline-flex items-center gap-2">
            {counted ? (
              <Emoji emoji={counted} fontSize={20} />
            ) : (
              <span className="text-gray-400 dark:text-gray-500">—</span>
            )}
            <LateNote hours={lateNote} />
          </span>
        </div>
      ) : (
        <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-4 gap-y-3">
          <span className="text-[13px] text-ink-3">Grade</span>
          <span className="inline-flex items-center gap-2">
            <QuizGradeEmoji
              emoji={grade.effectiveEmoji}
              originalEmoji={grade.originalEmoji}
              adjusted={grade.adjusted}
              size="md"
            />
            {late === 0 && <LateNote hours={lateNote} />}
          </span>
          {late > 0 && (
            <>
              <span className="text-[13px] text-ink-3">Counted</span>
              <span className="inline-flex items-center gap-2">
                <QuizGradeEmoji emoji={grade.countedEmoji} size="md" />
                <LateNote hours={late} />
              </span>
            </>
          )}
        </div>
      )}

      <div>
        <label htmlFor={replyId} className="block text-sm text-ink-1 mb-1">
          <span className="text-red-500 mr-1">*</span>Reply to student
        </label>
        <Input.TextArea
          id={replyId}
          data-testid="quiz-resolve-reply"
          rows={3}
          value={form.reply}
          onChange={e => form.setReply(e.target.value)}
          disabled={disabled}
          maxLength={QUIZ_REGRADE_REPLY_MAX_LENGTH}
          showCount
        />
      </div>

      {error && <div className="text-sm text-rose-600 dark:text-rose-400">{error}</div>}
    </div>
  );
}

export default QuizResolveFields;
