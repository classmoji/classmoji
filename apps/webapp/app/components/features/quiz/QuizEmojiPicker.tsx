import Emoji from '~/components/ui/display/Emoji';

/**
 * Pick one grade from the classroom's scale (emoji, or `score-N` badges on
 * the numeric scale), styled like the repo grading picker (`EmojiGrader`),
 * which submits a repo grade on click and so can't be reused here. Controlled:
 * it only reports the pick. The attempt's current grade is marked "current".
 */
export interface QuizEmojiPickerProps {
  /** The scale's emoji, best first. */
  scaleEmojis: readonly string[];
  value: string | null;
  onChange: (emoji: string) => void;
  disabled?: boolean;
  /**
   * The grade the attempt shows now, marked "current" in the picker: picking
   * it keeps the score (the server writes no adjustment for it).
   */
  currentEmoji?: string | null;
}

export function QuizEmojiPicker({
  scaleEmojis,
  value,
  onChange,
  disabled = false,
  currentEmoji = null,
}: QuizEmojiPickerProps) {
  if (scaleEmojis.length === 0) {
    return (
      <span className="text-sm text-gray-500 dark:text-gray-400">
        This classroom has no grading scale.
      </span>
    );
  }
  return (
    <div
      role="radiogroup"
      aria-label="Grade"
      data-testid="quiz-emoji-picker"
      className="inline-flex flex-wrap items-start gap-1 rounded-lg bg-white p-1.5 shadow-sm ring-1 ring-stone-200 dark:bg-neutral-900 dark:ring-neutral-700"
    >
      {scaleEmojis.map(key => {
        const selected = key === value;
        const current = key === currentEmoji;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={current ? `${key} (current grade)` : undefined}
            title={current ? 'Current grade: picking it keeps the score' : undefined}
            disabled={disabled}
            data-testid={`quiz-emoji-option-${key}`}
            onClick={() => onChange(key)}
            className={`flex cursor-pointer flex-col items-center rounded-md px-2 py-1 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-neutral-700 ${
              selected ? 'bg-amber-100 dark:bg-amber-500/25' : ''
            }`}
          >
            <Emoji emoji={key} fontSize={18} />
            {current && (
              <span
                data-testid="quiz-emoji-current"
                className="mt-0.5 text-[10px] leading-none text-gray-500 dark:text-gray-400"
              >
                current
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default QuizEmojiPicker;
