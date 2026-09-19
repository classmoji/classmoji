import type { FormField } from '@classmoji/services/form-contract';

import {
  formatAnswer,
  innerFieldsOf,
  isDisplayOnly,
  matrixOf,
  optionLabel,
  targetName,
  targetsFor,
  type ResolvedTarget,
} from './answerFormat.ts';
import { FieldShell } from './FormPreview.tsx';

/**
 * One submitted response, rendered read-only.
 *
 * Shares `FieldShell` with the builder preview on purpose: the drawer is the
 * instructor's view of a form someone filled in, and it should read as that
 * form — same label, same required marker, same help text, same order — with
 * the controls replaced by what was actually answered.
 *
 * Two shapes get real structure rather than a flattened line, because flattening
 * them loses the answer:
 *  - MATRIX renders as the same grid the filler saw, with the chosen cell
 *    marked. "Communication: Excellent; Reliability: Good" is a summary, not a
 *    reading of a rubric.
 *  - REPEAT_GROUP renders one card per review target, named from the response's
 *    own `resolved_context` snapshot. Nothing in the UI creates these responses
 *    yet — this is built off the CONTRACT, generically, so that when the
 *    classroom fill path lands the drawer already reads its output. Targets the
 *    snapshot marks as removed (or that appear only in the answers) are greyed
 *    and labelled: the review still happened and the instructor must still see
 *    it, but the person is no longer on the team.
 */

const blank = <span className="italic text-gray-400 dark:text-gray-500">No answer</span>;

function ScalarAnswer({ field, value }: { field: FormField; value: unknown }) {
  const text = formatAnswer(field, value);
  if (!text) return blank;

  // A multi-value answer reads as a list, not as one long semicolon-joined
  // line — the joined form belongs in a table cell and a CSV, not here.
  if (field.type === 'multiselect' || field.type === 'ranked_choice') {
    const ids = Array.isArray(value) ? value : [];
    if (ids.length === 0) return blank;
    const ordered = field.type === 'ranked_choice';
    return (
      <ol className="flex list-none flex-col gap-1 text-sm text-gray-800 dark:text-gray-100">
        {ids.map((id, index) => (
          <li key={`${String(id)}-${index}`} className="flex items-start gap-2">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {ordered ? index + 1 : '✓'}
            </span>
            <span>{optionLabel(field, id)}</span>
          </li>
        ))}
      </ol>
    );
  }

  return <div className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-100">{text}</div>;
}

function MatrixAnswer({ field, value }: { field: FormField; value: unknown }) {
  const { rows, columns } = matrixOf(field);
  const answer = (value ?? {}) as Record<string, unknown>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr>
            <th className="px-2 py-1" />
            {columns.map(column => (
              <th
                key={column.id}
                className="px-2 py-1 font-medium text-gray-500 dark:text-gray-400"
                title={column.description}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id} className="border-t border-gray-100 dark:border-gray-800">
              <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300">{row.label}</td>
              {columns.map(column => {
                const chosen = answer[row.id] === column.id;
                return (
                  <td key={column.id} className="px-2 py-1.5">
                    <span
                      aria-label={chosen ? `${row.label}: ${column.label}` : undefined}
                      className={`inline-block h-3.5 w-3.5 rounded-full border ${
                        chosen
                          ? 'border-blue-600 bg-blue-600 dark:border-blue-400 dark:bg-blue-400'
                          : 'border-gray-300 dark:border-gray-600'
                      }`}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TargetCard({
  field,
  target,
  review,
}: {
  field: FormField;
  target: ResolvedTarget;
  review: unknown;
}) {
  const answered = review !== null && review !== undefined;
  const inner = (review ?? {}) as Record<string, unknown>;

  return (
    <div
      className={`mb-3 rounded-md border p-3 ${
        target.removed
          ? 'border-dashed border-gray-300 opacity-60 dark:border-gray-700'
          : 'border-gray-200 dark:border-gray-700'
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
          {targetName(target)}
        </span>
        {target.removed ? (
          <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">
            No longer on the team
          </span>
        ) : null}
      </div>
      {answered ? (
        innerFieldsOf(field).map(child => (
          <AnswerField key={child.id} field={child} value={inner[child.id]} />
        ))
      ) : (
        <div className="text-sm italic text-gray-400 dark:text-gray-500">Not reviewed</div>
      )}
    </div>
  );
}

function RepeatGroupAnswer({
  field,
  value,
  resolvedContext,
}: {
  field: FormField;
  value: unknown;
  resolvedContext: unknown;
}) {
  const targets = targetsFor(resolvedContext, field.id, value);
  const answer = (value ?? {}) as Record<string, unknown>;

  if (targets.length === 0) {
    return (
      <span className="text-sm italic text-gray-400 dark:text-gray-500">No review targets</span>
    );
  }

  return (
    <div>
      {targets.map(target => (
        <TargetCard
          key={target.user_id}
          field={field}
          target={target}
          review={answer[target.user_id]}
        />
      ))}
    </div>
  );
}

/** One field of the definition with the answer that was given for it. */
export function AnswerField({
  field,
  value,
  resolvedContext,
}: {
  field: FormField;
  value: unknown;
  resolvedContext?: unknown;
}) {
  // A heading or a banner is part of the form's prose, not of the response.
  // Keeping them out is what makes the drawer a list of answers rather than a
  // second copy of the questionnaire.
  if (isDisplayOnly(field)) return null;

  return (
    <FieldShell field={field}>
      {field.type === 'matrix' ? (
        <MatrixAnswer field={field} value={value} />
      ) : field.type === 'repeat_group' ? (
        <RepeatGroupAnswer field={field} value={value} resolvedContext={resolvedContext} />
      ) : (
        <ScalarAnswer field={field} value={value} />
      )}
    </FieldShell>
  );
}

/** Every answer in a response, in the order its revision defines. */
export default function AnswerView({
  fields,
  answers,
  resolvedContext,
}: {
  fields: FormField[];
  answers: Record<string, unknown>;
  resolvedContext?: unknown;
}) {
  const answerable = fields.filter(field => !isDisplayOnly(field));

  if (answerable.length === 0) {
    return (
      <div className="text-sm italic text-gray-400 dark:text-gray-500">
        This revision has no answerable fields.
      </div>
    );
  }

  return (
    <div>
      {answerable.map(field => (
        <AnswerField
          key={field.id}
          field={field}
          value={answers?.[field.id]}
          resolvedContext={resolvedContext}
        />
      ))}
      {/* An answer whose field is gone from this revision is not shown by the
          loop above. It cannot be rendered meaningfully (no label, no option
          map), but silently omitting it would misrepresent the response, so it
          is counted. */}
      <OrphanNote fields={answerable} answers={answers} />
    </div>
  );
}

function OrphanNote({
  fields,
  answers,
}: {
  fields: FormField[];
  answers: Record<string, unknown>;
}) {
  const known = new Set(fields.map(field => field.id));
  const orphans = Object.keys(answers ?? {}).filter(id => !known.has(id));
  if (orphans.length === 0) return null;
  return (
    <div className="mt-2 text-xs text-gray-400 dark:text-gray-500">
      {orphans.length} answer{orphans.length === 1 ? '' : 's'} belong to fields that are no longer
      in this revision.
    </div>
  );
}
