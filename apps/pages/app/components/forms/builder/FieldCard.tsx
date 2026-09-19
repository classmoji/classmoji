import { useSortable } from '@dnd-kit/sortable';
import {
  IconChevronDown,
  IconChevronRight,
  IconGripVertical,
  IconTrash,
} from '@tabler/icons-react';
import type { FormField } from '@classmoji/services/form-contract';

import { isDisplayField, metaFor } from '../fieldTypes.ts';
import FieldConfig, { type ScopeChoices } from './FieldConfig.tsx';

/**
 * One row of the field LIST — a drag handle, a type chip, a summary, and the
 * configuration body when it is expanded.
 *
 * A list, not a canvas. Forms in a course are a column of questions; a
 * free-placement editor would buy nothing and cost every alignment decision.
 * Reordering is the only spatial operation, so the drag handle is the only
 * drag affordance: dragging by the card body would fight text selection inside
 * the expanded config.
 */

interface FieldCardProps {
  field: FormField;
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
  scopes: ScopeChoices;
}

/** One line describing the field without opening it. */
function summarize(field: FormField): string {
  if (isDisplayField(field.type)) return (field.text as string) ?? '';
  const label = (field.label as string) ?? '';
  return label;
}

export default function FieldCard({
  field,
  expanded,
  onToggle,
  onChange,
  onRemove,
  scopes,
}: FieldCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
  });

  const meta = metaFor(field.type);

  // `@dnd-kit/utilities` (which owns `CSS.Transform.toString`) is a transitive
  // dependency of @dnd-kit/sortable, not a declared dependency of this app.
  // Writing the translate by hand keeps the import graph honest, and a sortable
  // list only ever translates — none of the helper's scale handling is lost.
  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-lg border bg-white dark:bg-gray-800 ${
        isDragging ? 'border-blue-400 opacity-80 shadow-lg' : 'border-gray-200 dark:border-gray-700'
      }`}
    >
      <div className="flex items-start gap-2 px-2.5 py-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${summarize(field) || meta?.label}`}
          className="mt-0.5 cursor-grab text-gray-300 hover:text-gray-500 dark:text-gray-600"
        >
          <IconGripVertical size={16} />
        </button>

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex flex-1 items-start gap-2 text-left"
        >
          {expanded ? (
            <IconChevronDown size={15} className="mt-1 shrink-0 text-gray-400" />
          ) : (
            <IconChevronRight size={15} className="mt-1 shrink-0 text-gray-400" />
          )}
          <span className="min-w-0 flex-1">
            <span className="mr-2 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-gray-500 dark:bg-gray-700 dark:text-gray-300">
              {meta?.label ?? field.type}
            </span>
            <span className="text-sm text-gray-800 dark:text-gray-100">{summarize(field)}</span>
            {field.required ? <span className="ml-1 text-red-500">*</span> : null}
          </span>
        </button>

        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove field"
          className="mt-0.5 text-gray-300 hover:text-red-600 dark:text-gray-600 dark:hover:text-red-400"
        >
          <IconTrash size={15} />
        </button>
      </div>

      {expanded ? (
        <div className="border-t border-gray-100 px-3 pb-3 dark:border-gray-700">
          <FieldConfig field={field} onChange={onChange} scopes={scopes} />
        </div>
      ) : null}
    </div>
  );
}
