import Emoji from '~/components/ui/display/Emoji';

/**
 * How a resolved quiz regrade/resubmit request reads, the same on the
 * requests page and the student's result panel: the status tag's word
 * (Approved / Denied) and the remedy, "Score adjusted A → B" or "Score kept
 * A", with A the grade asked about and B what the resolution left.
 */

/** A quiz request's status tag: its decision (the result panel uses the same words). */
export const QUIZ_STATUS_LABEL: Record<string, string> = {
  IN_REVIEW: 'In Review',
  APPROVED: 'Approved',
  DENIED: 'Denied',
};

/**
 * The remedy a resolved quiz request got, under its status tag: "Score
 * adjusted A → B" or "Score kept A", the same words as the student's result
 * panel.
 */
export const QuizRemedy = ({
  status,
  previousEmoji,
  resolvedEmoji,
}: {
  status: string;
  previousEmoji: string | null;
  resolvedEmoji: string | null;
}) => {
  if (status === 'APPROVED') {
    return (
      <span data-testid="quiz-remedy" className="inline-flex items-center gap-1 whitespace-nowrap">
        Score adjusted
        {previousEmoji && <Emoji emoji={previousEmoji} fontSize={14} />}
        {previousEmoji && <span aria-hidden>→</span>}
        {resolvedEmoji && <Emoji emoji={resolvedEmoji} fontSize={14} />}
      </span>
    );
  }
  if (status === 'DENIED') {
    const kept = resolvedEmoji ?? previousEmoji;
    return (
      <span data-testid="quiz-remedy" className="inline-flex items-center gap-1 whitespace-nowrap">
        Score kept
        {kept && <Emoji emoji={kept} fontSize={14} />}
      </span>
    );
  }
  return null;
};
