import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { FormOption } from '@classmoji/services/form-contract';

import { makeOption } from '../fieldTypes.ts';

/**
 * The option list editor, shared by dropdown, multi-select, ranked choice, and
 * both axes of a matrix.
 *
 * Each row is `{ id, label, description? }`. The DESCRIPTION is not decoration:
 * it is the rubric line under a matrix column ("Consistently — present for
 * every meeting"), which is the whole reason options are objects rather than
 * strings. Editing a label never touches the id, so rewording a rubric leaves
 * every answer that chose it still pointing at the same option.
 */

interface OptionsEditorProps {
  options: FormOption[];
  onChange: (options: FormOption[]) => void;
  /** Below this count the delete buttons disappear — the schema needs them. */
  minimum?: number;
  /** Ceiling from FORM_LIMITS, passed in so the caller owns the message. */
  maximum?: number;
  label?: string;
  /** Rubric text is meaningful on matrix axes, noise on a plain dropdown. */
  withDescriptions?: boolean;
}

export default function OptionsEditor({
  options,
  onChange,
  minimum = 1,
  maximum = 30,
  label = 'Options',
  withDescriptions = false,
}: OptionsEditorProps) {
  const update = (id: string, patch: Partial<FormOption>) =>
    onChange(options.map(option => (option.id === id ? { ...option, ...patch } : option)));

  const remove = (id: string) => onChange(options.filter(option => option.id !== id));

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {label}
        </span>
        <span className="text-xs text-gray-400">
          {options.length} / {maximum}
        </span>
      </div>

      <div className="space-y-1.5">
        {options.map(option => (
          <div key={option.id} className="flex items-start gap-1.5">
            <div className="flex-1 space-y-1">
              <input
                value={option.label}
                onChange={event => update(option.id, { label: event.target.value })}
                aria-label={`${label} label`}
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
              />
              {withDescriptions ? (
                <input
                  value={option.description ?? ''}
                  onChange={event =>
                    update(option.id, {
                      // An empty string is not a description: the schema's
                      // `.optional()` means absent, and storing '' would put a
                      // blank rubric line under every column.
                      description: event.target.value === '' ? undefined : event.target.value,
                    })
                  }
                  placeholder="Description (optional) — e.g. what earns this rating"
                  aria-label={`${label} description`}
                  className="w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                />
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => remove(option.id)}
              disabled={options.length <= minimum}
              aria-label="Remove option"
              className="mt-1.5 text-gray-400 hover:text-red-600 disabled:opacity-30 dark:hover:text-red-400"
            >
              <IconTrash size={15} />
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => onChange([...options, makeOption(`Option ${options.length + 1}`)])}
        disabled={options.length >= maximum}
        className="mt-2 flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline disabled:opacity-40 dark:text-blue-400"
      >
        <IconPlus size={13} /> Add option
      </button>
    </div>
  );
}
