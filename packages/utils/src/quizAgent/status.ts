/**
 * The per-turn CURRENT STATUS block, rebuilt from the database each turn and
 * given to the model as a hidden part of the student's message. State only: the
 * rules for what to do with it live in the prompt.
 */

export type AttemptProgress = {
  questionCount: number;
  /** Highest question number presented so far (0 before the first). */
  presented: number;
  /** Question numbers with a recorded result, ascending. */
  finalized: number[];
  completed: boolean;
  hasEvaluation: boolean;
  /** The admitted student message of this turn was a button click. */
  lastAction?: 'next' | 'try_again';
};

export function buildTurnStatus(p: AttemptProgress): string {
  const finalized = new Set(p.finalized);
  const lines = [
    'CURRENT STATUS (state only — the rules in your instructions decide what to do with it):',
  ];

  if (p.completed) {
    lines.push('Phase: COMPLETE');
    lines.push(`Questions with a recorded result: ${finalized.size}/${p.questionCount}`);
    lines.push('The quiz is complete and its evaluation has been submitted.');
    return lines.join('\n');
  }

  const phase =
    p.presented === 0
      ? 'FIRST_QUESTION'
      : p.presented >= p.questionCount
        ? 'FINAL_QUESTION'
        : 'IN_PROGRESS';
  lines.push(`Phase: ${phase}`);
  lines.push(`Questions presented: ${p.presented}/${p.questionCount}`);
  lines.push(`Questions with a recorded result: ${finalized.size}/${p.questionCount}`);

  if (p.presented === 0) {
    lines.push('No question has been presented yet. The next one is Question 1.');
  } else {
    const current = p.presented;
    const isLast = current >= p.questionCount;
    if (!finalized.has(current)) {
      lines.push(
        isLast
          ? `Question awaiting a result: Question ${current} — the last one.`
          : `Question awaiting a result: Question ${current}`
      );
    }
    if (isLast) {
      lines.push('There is no next question after it.');
    } else if (finalized.has(current)) {
      lines.push(`Next question to present: Question ${current + 1}`);
    } else {
      lines.push(`Next question to present, once it has a result: Question ${current + 1}`);
    }
    const missing: number[] = [];
    for (let n = 1; n < current; n++) if (!finalized.has(n)) missing.push(n);
    if (missing.length > 0) {
      lines.push(`Earlier questions with no recorded result: ${missing.join(', ')}`);
    }
    if (isLast && finalized.size >= p.questionCount && missing.length === 0) {
      lines.push('Every question has a recorded result; the evaluation has not been submitted.');
    }
  }

  if (p.lastAction === 'next') lines.push('The student clicked Next.');
  if (p.lastAction === 'try_again') lines.push('The student clicked Try again.');
  return lines.join('\n');
}
