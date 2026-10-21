import { Tooltip } from 'antd';
import Emoji from '~/components/ui/display/Emoji';

/**
 * A quiz grade as the classroom's emoji, the way repo grades are shown (a
 * `score-N` badge on the numeric scale; `Emoji` draws both). No number is ever
 * shown (E1).
 *
 *   - adjusted with `originalEmoji`: "orig → new" and an "adjusted" chip (D6, D8);
 *     adjusted without it: the new emoji and the chip.
 *   - `lateHours` > 0: an "Nh late" chip.
 *   - no emoji: an em dash; with `noScale` (a scored attempt in a classroom
 *     with no grading scale) the dash says why (`NoScaleGrade`).
 */
export interface QuizGradeEmojiProps {
  emoji: string | null;
  originalEmoji?: string | null;
  adjusted?: boolean;
  lateHours?: number | null;
  size?: 'sm' | 'md' | 'lg';
  /** The attempt is scored but the classroom has no grading scale to show it on. */
  noScale?: boolean;
}

/** Whether a classroom's scale (emoji → grade) has nothing to show a grade with. */
export const isNoScale = (scale: Readonly<Record<string, number>> | null | undefined) =>
  !scale || Object.keys(scale).length === 0;

/**
 * A scored quiz grade in a classroom with no grading scale: an em dash that
 * says why, never "Pending", "No score" or "Completed". The one place this
 * display lives (the no-scale rule may change).
 */
export const NoScaleGrade = () => (
  <Tooltip title="No grading scale">
    <span
      data-testid="quiz-grade-no-scale"
      className="text-gray-400 dark:text-gray-500 cursor-help"
    >
      —
    </span>
  </Tooltip>
);

const FONT_SIZE: Record<NonNullable<QuizGradeEmojiProps['size']>, number> = {
  sm: 16,
  md: 20,
  lg: 32,
};

/** The "adjusted" chip (D8). */
export const AdjustedChip = () => (
  <span
    data-testid="quiz-grade-adjusted"
    className="inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 whitespace-nowrap"
  >
    adjusted
  </span>
);

/** How late an attempt completed, as the Assignments page says it. */
export const LateChip = ({ hours }: { hours: number }) => (
  <span
    data-testid="quiz-grade-late"
    className="inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-700 dark:text-orange-300 whitespace-nowrap"
  >
    {hours}h late
  </span>
);

/**
 * What a late quiz grade counts for after the late penalty, beside the grade:
 * "→ 👀" with a tooltip. The quizzes list, the Assignments tab and the
 * dashboard show it the same way. Nothing when there is no counted emoji.
 */
export const CountedEmoji = ({ emoji }: { emoji: string | null | undefined }) =>
  emoji ? (
    <Tooltip title="What it counts for after the late penalty">
      <span
        data-testid="quiz-grade-counted"
        className="inline-flex items-center gap-1 text-xs font-semibold text-orange-700 dark:text-orange-300 whitespace-nowrap"
      >
        → <Emoji emoji={emoji} fontSize={16} />
      </span>
    </Tooltip>
  ) : null;

export function QuizGradeEmoji({
  emoji,
  originalEmoji = null,
  adjusted = false,
  lateHours = null,
  size = 'sm',
  noScale = false,
}: QuizGradeEmojiProps) {
  const fontSize = FONT_SIZE[size];
  if (!emoji && noScale) return <NoScaleGrade />;
  if (!emoji) {
    return (
      <span data-testid="quiz-grade-none" className="text-gray-400 dark:text-gray-500">
        —
      </span>
    );
  }
  const showOriginal = adjusted && Boolean(originalEmoji) && originalEmoji !== emoji;
  return (
    <span
      data-testid="quiz-grade"
      className="inline-flex items-center gap-1.5 whitespace-nowrap align-middle"
    >
      {showOriginal && (
        <>
          <span data-testid="quiz-grade-original" className="inline-flex opacity-80">
            <Emoji emoji={originalEmoji as string} fontSize={fontSize} />
          </span>
          <span aria-hidden className="text-xs text-gray-400 dark:text-gray-500">
            →
          </span>
        </>
      )}
      <span data-testid="quiz-grade-emoji" className="inline-flex">
        <Emoji emoji={emoji} fontSize={fontSize} />
      </span>
      {adjusted && <AdjustedChip />}
      {typeof lateHours === 'number' && lateHours > 0 && <LateChip hours={lateHours} />}
    </span>
  );
}

export default QuizGradeEmoji;
