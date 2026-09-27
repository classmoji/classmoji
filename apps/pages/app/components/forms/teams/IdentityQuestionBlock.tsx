import { answerCountText, IDENTITY_BLOCK_LABELS, studentsSeeText } from './teamsView.ts';
import type { AnswerCount, CheckLine } from './types.ts';

/**
 * The part of an identity question's row under its rule: "Don't leave anyone
 * as the only:" with one checkbox per answer and the class count for it, the
 * rule's one-line hint, the checks about it (the single-answer warning, the
 * teams-of-two line; facts only, no names), and what students see under the
 * question on the form.
 *
 * A ticked answer is protected: no one who gave it is left as the only one on
 * a team. An unticked answer is a wildcard (`wildcard_option_ids`), ignored by
 * the rule. Counts are the class's, never who.
 *
 * Controlled: the row keeps the wildcards (a patch replaces the whole list, so
 * the row holds its draft between saves) and gets the next list back.
 *
 * Presentational: props in, the next wildcard list out.
 */

export interface IdentityQuestionBlockProps {
  /** Prefix of every control id: `${idPrefix}-protect-${option_id}`. */
  idPrefix: string;
  /** SetupQuestion.answer_counts: each answer and how many gave it. */
  answers: readonly AnswerCount[];
  /** The rule's wildcard answers (unticked); [] = every answer is protected. */
  wildcards: readonly string[];
  /** Check lines about this question's rule (warnings; never names). */
  checks: readonly CheckLine[];
  /** The question's help text on the form; null = none. */
  helpText: string | null;
  disabled: boolean;
  /** The next wildcard list, in the answers' order. */
  onChange: (wildcards: string[]) => void;
}

export function IdentityQuestionBlock({
  idPrefix,
  answers,
  wildcards,
  checks,
  helpText,
  disabled,
  onChange,
}: IdentityQuestionBlockProps) {
  const unticked = new Set(wildcards);
  const labelId = `${idPrefix}-protect-label`;

  const toggle = (optionId: string, protect: boolean) => {
    const next = new Set(unticked);
    if (protect) next.delete(optionId);
    else next.add(optionId);
    // Answers' order, then any stored id the question no longer has.
    const known = answers.map(answer => answer.option_id);
    onChange([...known.filter(id => next.has(id)), ...[...next].filter(id => !known.includes(id))]);
  };

  return (
    <div className="mt-3 space-y-2" data-testid={`${idPrefix}-identity`}>
      {answers.length > 0 ? (
        <div
          role="group"
          aria-labelledby={labelId}
          className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800/60"
        >
          <span id={labelId} className="text-xs font-medium text-gray-700 dark:text-gray-200">
            {IDENTITY_BLOCK_LABELS.protect}
          </span>
          {answers.map(answer => {
            const id = `${idPrefix}-protect-${answer.option_id}`;
            return (
              <label
                key={answer.option_id}
                htmlFor={id}
                className="inline-flex items-center gap-1.5 text-sm text-gray-800 dark:text-gray-100"
              >
                <input
                  id={id}
                  type="checkbox"
                  checked={!unticked.has(answer.option_id)}
                  disabled={disabled}
                  onChange={event => toggle(answer.option_id, event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 disabled:cursor-not-allowed dark:border-gray-600"
                />
                <span>{answerCountText(answer)}</span>
              </label>
            );
          })}
        </div>
      ) : null}

      <p className="text-xs text-gray-500 dark:text-gray-400">{IDENTITY_BLOCK_LABELS.hint}</p>

      {checks.map((check, index) => (
        <p
          key={`${check.code}-${index}`}
          data-testid={`${idPrefix}-identity-check`}
          data-level={check.level}
          className={`text-xs ${
            check.level === 'error'
              ? 'text-red-700 dark:text-red-300'
              : 'text-amber-800 dark:text-amber-300'
          }`}
        >
          {check.message}
        </p>
      ))}

      {helpText ? (
        <p
          data-testid={`${idPrefix}-students-see`}
          className="text-xs italic text-gray-500 dark:text-gray-400"
        >
          {studentsSeeText(helpText)}
        </p>
      ) : null}
    </div>
  );
}

export default IdentityQuestionBlock;
