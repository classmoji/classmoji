import type { FormField, FormOption } from '@classmoji/services/form-contract';

import { isDisplayField } from './fieldTypes.ts';

/**
 * A READ-ONLY approximation of a form, rendered straight from a definition.
 *
 * This is the builder's live-preview pane today. It lives in
 * `app/components/forms/` rather than beside the builder because the fill
 * renderer will need exactly this layout — label, required marker, help text,
 * control — and the two must not drift into two different-looking forms. When
 * the renderer lands it takes over the control slot with real inputs and keeps
 * `FieldShell` and the display blocks as they are.
 *
 * Deliberately inert: every control is disabled and nothing is wired to state.
 * A preview that half-works invites the instructor to test their form in it and
 * draw conclusions from a renderer that is not the one respondents will see.
 */

const REQUIRED = <span className="ml-0.5 text-red-500">*</span>;

/**
 * Label + required marker + control slot + help text.
 *
 * Exported because the response drawer renders stored ANSWERS through the same
 * shell (see `AnswerView.tsx`): an instructor reading a submission should see
 * the questions laid out exactly as the person answering them did, and two
 * shells would drift into two different-looking forms.
 */
export function FieldShell({ field, children }: { field: FormField; children?: React.ReactNode }) {
  const label = field.label as string | undefined;
  const help = field.help as string | undefined;

  return (
    <div className="mb-5">
      {label ? (
        <div className="mb-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
          {label}
          {field.required ? REQUIRED : null}
        </div>
      ) : null}
      {children}
      {help ? <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{help}</div> : null}
    </div>
  );
}

const inputBox = (extra = '') =>
  `w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-500 ${extra}`;

const optionsOf = (field: FormField): FormOption[] => (field.options as FormOption[]) ?? [];

function DisplayBlock({ field }: { field: FormField }) {
  const text = (field.text as string) ?? '';

  if (field.type === 'heading') {
    return (
      <h3 className="mb-3 mt-6 text-base font-semibold text-gray-900 dark:text-white">{text}</h3>
    );
  }
  if (field.type === 'banner') {
    const warning = field.tone === 'warning';
    return (
      <div
        className={`mb-5 rounded-md border px-3 py-2 text-sm ${
          warning
            ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200'
            : 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200'
        }`}
      >
        {text}
      </div>
    );
  }
  return <p className="mb-5 text-sm text-gray-600 dark:text-gray-300">{text}</p>;
}

function Control({ field }: { field: FormField }) {
  switch (field.type) {
    case 'long_text':
      return <div className={inputBox('h-20')} />;

    case 'email':
      return (
        <div className={inputBox()}>
          {(field.domain as string | undefined)
            ? `name@${field.domain as string}`
            : 'name@example.com'}
        </div>
      );

    case 'number':
      return <div className={inputBox()}>0</div>;

    case 'dropdown':
      return <div className={inputBox()}>{optionsOf(field)[0]?.label ?? 'Choose…'}</div>;

    case 'multiselect':
      return (
        <div className="flex flex-col gap-1.5">
          {optionsOf(field).map(item => (
            <label
              key={item.id}
              className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300"
            >
              <span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-sm border border-gray-300 dark:border-gray-600" />
              <span>
                {item.label}
                {item.description ? (
                  <span className="block text-xs text-gray-400">{item.description}</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      );

    case 'switch':
      return (
        <div className="flex items-center gap-2">
          <span className="h-4 w-7 rounded-full bg-gray-200 dark:bg-gray-700" />
          <span className="text-sm text-gray-400 dark:text-gray-500">No</span>
        </div>
      );

    case 'opinion_scale': {
      const scale = field.scale as {
        min: number;
        max: number;
        minLabel?: string;
        maxLabel?: string;
      };
      const steps: number[] = [];
      // Cap the drawn steps: a 1–100 scale is legal and would otherwise paint a
      // hundred boxes into a narrow pane.
      for (let n = scale.min; n <= Math.min(scale.max, scale.min + 14); n++) steps.push(n);
      return (
        <div>
          <div className="flex flex-wrap gap-1">
            {steps.map(step => (
              <span
                key={step}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400"
              >
                {step}
              </span>
            ))}
            {scale.max > scale.min + 14 ? (
              <span className="self-center text-xs text-gray-400">… {scale.max}</span>
            ) : null}
          </div>
          {scale.minLabel || scale.maxLabel ? (
            <div className="mt-1 flex justify-between text-xs text-gray-400">
              <span>{scale.minLabel}</span>
              <span>{scale.maxLabel}</span>
            </div>
          ) : null}
        </div>
      );
    }

    case 'ranked_choice': {
      const ranks = (field.ranks as number) ?? 1;
      return (
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: Math.min(ranks, 8) }, (_, index) => (
            <div key={index} className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-xs font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                {index + 1}
              </span>
              <div className={inputBox('flex-1')}>
                {optionsOf(field)[index]?.label ?? 'Choose an option…'}
              </div>
            </div>
          ))}
        </div>
      );
    }

    case 'roster_select':
      return (
        <div className={inputBox()}>
          {field.optionSource === 'teaching_team'
            ? 'Search the teaching team…'
            : 'Search the roster…'}
          <span className="ml-2 text-xs italic">resolved at publish</span>
        </div>
      );

    case 'matrix': {
      const matrix = field.matrix as { rows: FormOption[]; columns: FormOption[] };
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr>
                <th className="px-2 py-1" />
                {matrix.columns.map(column => (
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
              {matrix.rows.map(row => (
                <tr key={row.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300">{row.label}</td>
                  {matrix.columns.map(column => (
                    <td key={column.id} className="px-2 py-1.5">
                      <span className="inline-block h-3.5 w-3.5 rounded-full border border-gray-300 dark:border-gray-600" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case 'repeat_group': {
      const inner = (field.fields as FormField[]) ?? [];
      return (
        <div className="rounded-md border border-dashed border-gray-300 p-3 dark:border-gray-600">
          <div className="mb-2 text-xs uppercase tracking-wide text-gray-400">
            Once per teammate · placeholder shown
          </div>
          <div className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-200">
            Teammate 1
          </div>
          {inner.map(child => (
            <FieldPreview key={child.id} field={child} />
          ))}
        </div>
      );
    }

    default:
      return <div className={inputBox()} />;
  }
}

/** One field: display block, or a labelled inert control. */
export function FieldPreview({ field }: { field: FormField }) {
  if (isDisplayField(field.type)) return <DisplayBlock field={field} />;
  return (
    <FieldShell field={field}>
      <Control field={field} />
    </FieldShell>
  );
}

/** The whole definition, in order. */
export default function FormPreview({ fields }: { fields: FormField[] }) {
  if (fields.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-gray-300 py-10 text-center text-sm text-gray-400 dark:border-gray-600">
        Add a field to see it here.
      </div>
    );
  }
  return (
    <div>
      {fields.map(field => (
        <FieldPreview key={field.id} field={field} />
      ))}
    </div>
  );
}
