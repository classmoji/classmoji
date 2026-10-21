import Emoji from '~/components/ui/display/Emoji';

/**
 * A quiz grade as the classroom's emoji, the way repo grades are shown (a
 * `score-N` badge on the numeric scale; `Emoji` draws both). No number is ever
 * shown (E1).
 *
 *   - adjusted with `originalEmoji`: "orig → new" and an "adjusted" chip (D6, D8);
 *     adjusted without it: the new emoji and the chip.
 *   - `lateHours` > 0: an "Nh late" chip.
 *   - no emoji: an em dash.
 */
export interface QuizGradeEmojiProps {
  emoji: string | null;
  originalEmoji?: string | null;
  adjusted?: boolean;
  lateHours?: number | null;
  size?: 'sm' | 'md' | 'lg';
}

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

export function QuizGradeEmoji({
  emoji,
  originalEmoji = null,
  adjusted = false,
  lateHours = null,
  size = 'sm',
}: QuizGradeEmojiProps) {
  const fontSize = FONT_SIZE[size];
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
