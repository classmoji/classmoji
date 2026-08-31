import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { IconGripVertical, IconPlus, IconTrash } from '@tabler/icons-react';
import { FORM_LIMITS, type FormField, type FormOption } from '@classmoji/services/form-contract';

import { NESTABLE_FIELD_TYPE_META, isDisplayField, makeField, metaFor } from '../fieldTypes.ts';
import OptionsEditor from './OptionsEditor.tsx';

/**
 * The expanded body of a field card: label, help, required, and whatever else
 * the field's own definition schema accepts.
 *
 * Every control writes a PATCH onto the stored field object, and the object is
 * the normalized definition the server handed back — so the builder edits
 * exactly what will be re-parsed on save, ids and all. Nothing here invents a
 * separate editing shape that would have to be translated on the way out.
 *
 * The schemas are `.strict()`. That is why UI-only state (which card is open,
 * which one is dragging) lives in the builder's own state and never on the
 * field: an extra key here is a save failure, not a silently dropped property.
 */

export interface ScopeChoices {
  tags: Array<{ id: string; name: string }>;
  repositories: Array<{ id: string; title: string }>;
}

interface FieldConfigProps {
  field: FormField;
  onChange: (patch: Record<string, unknown>) => void;
  scopes: ScopeChoices;
  /** Inner fields of a repeat group: no nesting, no group-only controls. */
  nested?: boolean;
}

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white';

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="mb-3">
    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
      {label}
    </div>
    {children}
  </div>
);

/**
 * One inner field of a repeat group: a drag handle, a type chip, and its own
 * configuration body.
 *
 * MODULE SCOPE, because it calls `useSortable`. Declared inside `TypeSpecific`
 * it would be a fresh component type on every keystroke in the config pane, and
 * dnd-kit would re-register a brand-new sortable node each time — the drag
 * would drop the moment anything else re-rendered.
 */
function SortableInnerField({
  field,
  scopes,
  onChange,
  onRemove,
  canRemove,
}: {
  field: FormField;
  scopes: ScopeChoices;
  onChange: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
  });

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-md border p-2.5 ${
        isDragging ? 'border-blue-400 opacity-80' : 'border-gray-200 dark:border-gray-700'
      }`}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${String(field.label ?? metaFor(field.type)?.label ?? field.type)}`}
            className="cursor-grab text-gray-300 hover:text-gray-500 dark:text-gray-600"
          >
            <IconGripVertical size={14} />
          </button>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            {metaFor(field.type)?.label ?? field.type}
          </span>
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="Remove inner field"
          className="text-gray-400 hover:text-red-600 disabled:opacity-30"
        >
          <IconTrash size={14} />
        </button>
      </div>
      <FieldConfig field={field} scopes={scopes} nested onChange={onChange} />
    </div>
  );
}

/** The inner question list of a repeat group, reorderable within itself. */
function InnerFieldList({
  fields,
  scopes,
  onChange,
}: {
  fields: FormField[];
  scopes: ScopeChoices;
  onChange: (fields: FormField[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = fields.findIndex(field => field.id === active.id);
    const to = fields.findIndex(field => field.id === over.id);
    if (from === -1 || to === -1) return;
    onChange(arrayMove(fields, from, to));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={fields.map(field => field.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {fields.map(child => (
            <SortableInnerField
              key={child.id}
              field={child}
              scopes={scopes}
              // The last question cannot go: an empty repeat group is a
              // definition the contract refuses (`innerFieldList` is `.min(1)`),
              // so removing it would make the form unsavable with no clue why.
              canRemove={fields.length > 1}
              onRemove={() => onChange(fields.filter(other => other.id !== child.id))}
              onChange={patch =>
                onChange(
                  fields.map(other =>
                    other.id === child.id ? ({ ...other, ...patch } as FormField) : other
                  )
                )
              }
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

/** Display blocks carry prose and nothing else — no label, no required. */
function DisplayConfig({ field, onChange }: Pick<FieldConfigProps, 'field' | 'onChange'>) {
  return (
    <>
      <Row label="Text">
        <textarea
          value={(field.text as string) ?? ''}
          rows={field.type === 'heading' ? 1 : 3}
          onChange={event => onChange({ text: event.target.value })}
          className={inputClass}
        />
      </Row>
      {field.type === 'banner' ? (
        <Row label="Tone">
          <select
            value={(field.tone as string) ?? 'info'}
            onChange={event => onChange({ tone: event.target.value })}
            className={inputClass}
          >
            <option value="info">Info</option>
            <option value="warning">Warning</option>
          </select>
        </Row>
      ) : null}
    </>
  );
}

function TypeSpecific({ field, onChange, scopes, nested }: FieldConfigProps) {
  switch (field.type) {
    case 'email':
      return (
        <Row label="Restrict to a domain (optional)">
          <input
            value={(field.domain as string) ?? ''}
            placeholder="dartmouth.edu"
            onChange={event =>
              onChange({
                domain: event.target.value.trim() === '' ? undefined : event.target.value,
              })
            }
            className={inputClass}
          />
        </Row>
      );

    case 'number':
      return (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
              Min
            </div>
            <input
              type="number"
              value={(field.min as number | undefined) ?? ''}
              onChange={event =>
                onChange({
                  min: event.target.value === '' ? undefined : Number(event.target.value),
                })
              }
              className={inputClass}
            />
          </div>
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
              Max
            </div>
            <input
              type="number"
              value={(field.max as number | undefined) ?? ''}
              onChange={event =>
                onChange({
                  max: event.target.value === '' ? undefined : Number(event.target.value),
                })
              }
              className={inputClass}
            />
          </div>
        </div>
      );

    case 'dropdown':
    case 'multiselect':
      return (
        <div className="mb-3">
          <OptionsEditor
            options={field.options as FormOption[]}
            onChange={options => onChange({ options })}
            maximum={FORM_LIMITS.MAX_OPTIONS}
          />
        </div>
      );

    case 'opinion_scale': {
      const scale = field.scale as {
        min: number;
        max: number;
        minLabel?: string;
        maxLabel?: string;
      };
      return (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
                From
              </div>
              <input
                type="number"
                value={scale.min}
                onChange={event =>
                  onChange({ scale: { ...scale, min: Number(event.target.value) } })
                }
                className={inputClass}
              />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
                To
              </div>
              <input
                type="number"
                value={scale.max}
                onChange={event =>
                  onChange({ scale: { ...scale, max: Number(event.target.value) } })
                }
                className={inputClass}
              />
            </div>
          </div>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <input
              value={scale.minLabel ?? ''}
              placeholder="Label for the low end"
              onChange={event =>
                onChange({
                  scale: {
                    ...scale,
                    minLabel: event.target.value === '' ? undefined : event.target.value,
                  },
                })
              }
              className={inputClass}
            />
            <input
              value={scale.maxLabel ?? ''}
              placeholder="Label for the high end"
              onChange={event =>
                onChange({
                  scale: {
                    ...scale,
                    maxLabel: event.target.value === '' ? undefined : event.target.value,
                  },
                })
              }
              className={inputClass}
            />
          </div>
        </>
      );
    }

    case 'ranked_choice': {
      const options = field.options as FormOption[];
      const ranks = (field.ranks as number) ?? 1;
      return (
        <>
          <div className="mb-3">
            <OptionsEditor
              options={options}
              onChange={next =>
                // Ranks may never exceed the option count — the schema refuses
                // it, so the editor clamps as options are removed instead of
                // letting the form become unsavable.
                onChange({ options: next, ranks: Math.min(ranks, Math.max(next.length, 1)) })
              }
              maximum={FORM_LIMITS.MAX_OPTIONS}
            />
          </div>
          <Row label="How many ranks">
            <input
              type="number"
              min={1}
              max={Math.min(options.length, FORM_LIMITS.MAX_RANKS)}
              value={ranks}
              onChange={event =>
                onChange({
                  ranks: Math.max(
                    1,
                    Math.min(Number(event.target.value) || 1, options.length || 1)
                  ),
                })
              }
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Each option can be picked once, so this cannot exceed {options.length} options.
            </p>
          </Row>
        </>
      );
    }

    case 'roster_select':
      return (
        <>
          <Row label="Who appears in the list">
            <select
              value={(field.optionSource as string) ?? 'roster'}
              onChange={event => onChange({ optionSource: event.target.value })}
              className={inputClass}
            >
              <option value="roster">Students on the roster</option>
              <option value="teaching_team">Teaching team</option>
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              The list is written into the form when you publish it, so it is a fixed snapshot of
              who was in the class at that moment.
            </p>
          </Row>
          <label className="mb-3 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
            <input
              type="checkbox"
              checked={Boolean(field.multiple)}
              onChange={event => onChange({ multiple: event.target.checked })}
            />
            Allow picking more than one person
          </label>
        </>
      );

    case 'matrix': {
      const matrix = field.matrix as {
        rows: FormOption[];
        columns: FormOption[];
        required_rows: 'all' | 'any' | 'none';
      };
      return (
        <>
          <div className="mb-3">
            <OptionsEditor
              label="Rows (what is being rated)"
              options={matrix.rows}
              onChange={rows => onChange({ matrix: { ...matrix, rows } })}
              maximum={FORM_LIMITS.MAX_MATRIX_ROWS}
            />
          </div>
          <div className="mb-3">
            <OptionsEditor
              label="Columns (the rating scale)"
              options={matrix.columns}
              onChange={columns => onChange({ matrix: { ...matrix, columns } })}
              maximum={FORM_LIMITS.MAX_MATRIX_COLUMNS}
              withDescriptions
            />
          </div>
          <Row label="Which rows must be answered">
            <select
              value={matrix.required_rows}
              onChange={event =>
                onChange({
                  matrix: {
                    ...matrix,
                    required_rows: event.target.value as 'all' | 'any' | 'none',
                  },
                })
              }
              className={inputClass}
            >
              <option value="all">Every row</option>
              <option value="any">At least one row</option>
              <option value="none">None — all optional</option>
            </select>
          </Row>
        </>
      );
    }

    case 'repeat_group': {
      if (nested) return null;
      const repeat = field.repeat as {
        over: 'teammates';
        scope: { by: 'tag' | 'repository' | 'classroom'; tag_id?: string; repository_id?: string };
        exclude_self: true;
        require_all_targets: boolean;
        min_entries?: number;
        max_entries?: number;
      };
      const inner = (field.fields as FormField[]) ?? [];

      const setScope = (by: 'tag' | 'repository' | 'classroom') => {
        // Rebuild the scope rather than patching it: the schema requires the id
        // that matches `by` and forbids the others, so carrying a stale
        // `tag_id` into a repository scope would fail validation at save.
        if (by === 'tag') {
          onChange({ repeat: { ...repeat, scope: { by, tag_id: scopes.tags[0]?.id } } });
        } else if (by === 'repository') {
          onChange({
            repeat: { ...repeat, scope: { by, repository_id: scopes.repositories[0]?.id } },
          });
        } else {
          onChange({ repeat: { ...repeat, scope: { by } } });
        }
      };

      return (
        <>
          <Row label="Which teams define the teammates">
            {/* `Row` draws its label as a div, so every control in this panel
                names ITSELF — without that a screen reader announces four
                unlabelled selects, and the panel is unusable. */}
            <select
              aria-label="Which teams define the teammates"
              value={repeat.scope.by}
              onChange={event => setScope(event.target.value as 'tag' | 'repository' | 'classroom')}
              className={inputClass}
            >
              <option value="tag">A team set (tag)</option>
              <option value="repository">A team-based assignment</option>
              <option value="classroom">The whole classroom</option>
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Pick the tag or assignment that actually defines the teams — a class can run project
              teams and lab pairs at the same time, and the wrong one reviews the wrong people.
            </p>
          </Row>

          {repeat.scope.by === 'tag' ? (
            <Row label="Tag">
              <select
                aria-label="Team set tag"
                value={repeat.scope.tag_id ?? ''}
                onChange={event =>
                  onChange({
                    repeat: { ...repeat, scope: { by: 'tag', tag_id: event.target.value } },
                  })
                }
                className={inputClass}
              >
                <option value="" disabled>
                  Choose a tag…
                </option>
                {scopes.tags.map(tag => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
              {scopes.tags.length === 0 ? (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                  This classroom has no tags yet — tag the teams first, or scope by assignment.
                </p>
              ) : null}
            </Row>
          ) : null}

          {repeat.scope.by === 'repository' ? (
            <Row label="Assignment">
              <select
                aria-label="Team-based assignment"
                value={repeat.scope.repository_id ?? ''}
                onChange={event =>
                  onChange({
                    repeat: {
                      ...repeat,
                      scope: { by: 'repository', repository_id: event.target.value },
                    },
                  })
                }
                className={inputClass}
              >
                <option value="" disabled>
                  Choose an assignment…
                </option>
                {scopes.repositories.map(repo => (
                  <option key={repo.id} value={repo.id}>
                    {repo.title}
                  </option>
                ))}
              </select>
              {scopes.repositories.length === 0 ? (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                  No team-based assignments in this classroom yet.
                </p>
              ) : null}
            </Row>
          ) : null}

          {/* `exclude_self` is `z.literal(true)` in the contract — nobody
              reviews themselves, and v1 does not offer the other answer. Shown
              rather than hidden so the rule is visible where the rest of the
              group is configured, and disabled so it cannot promise a setting
              the save would refuse. */}
          <label className="mb-3 flex items-start gap-2 text-sm text-gray-500 dark:text-gray-400">
            <input type="checkbox" checked disabled className="mt-0.5" />
            <span>
              Leave the person filling the form out of their own review list
              <span className="block text-xs">Always on — nobody reviews themselves.</span>
            </span>
          </label>

          <label className="mb-3 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
            <input
              type="checkbox"
              checked={repeat.require_all_targets}
              onChange={event =>
                onChange({ repeat: { ...repeat, require_all_targets: event.target.checked } })
              }
            />
            Every teammate must be reviewed before the form can be submitted
          </label>

          {/* Bounds on how many teammates get reviewed. Left empty they follow
              the team: "all of them" when every teammate is required, "as many
              as you like" when they are not. An explicit number is the escape
              hatch for a seven-person team where three reviews is the ask. */}
          <div className="mb-3 grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
                Fewest reviews
              </div>
              <input
                type="number"
                aria-label="Fewest reviews"
                min={0}
                placeholder={repeat.require_all_targets ? 'everyone' : 'no minimum'}
                value={repeat.min_entries ?? ''}
                onChange={event =>
                  onChange({
                    repeat: {
                      ...repeat,
                      min_entries:
                        event.target.value === '' ? undefined : Number(event.target.value),
                    },
                  })
                }
                className={inputClass}
              />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
                Most reviews
              </div>
              <input
                type="number"
                aria-label="Most reviews"
                min={1}
                placeholder="the whole team"
                value={repeat.max_entries ?? ''}
                onChange={event =>
                  onChange({
                    repeat: {
                      ...repeat,
                      max_entries:
                        event.target.value === '' ? undefined : Number(event.target.value),
                    },
                  })
                }
                className={inputClass}
              />
            </div>
          </div>

          <div className="mb-2 mt-4 border-t border-gray-200 pt-3 text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
            Asked about each teammate
          </div>

          {/* The inner list gets its OWN DndContext. Two contexts is what makes
              a cross-boundary drag impossible rather than merely discouraged:
              this one cannot see the outer field list's sortable ids, so an
              inner question can be reordered among its siblings and can never
              be dropped into the form body (where a `repeat_group` child would
              become a top-level field asking about nobody). */}
          <InnerFieldList
            fields={inner}
            scopes={scopes}
            onChange={fields => onChange({ fields })}
          />

          <div data-testid={`inner-palette-${field.id}`} className="mt-2 flex flex-wrap gap-1.5">
            {NESTABLE_FIELD_TYPE_META.map(meta => (
              <button
                key={meta.type}
                type="button"
                onClick={() => onChange({ fields: [...inner, makeField(meta.type)] })}
                className="flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300"
              >
                <IconPlus size={11} /> {meta.label}
              </button>
            ))}
          </div>
        </>
      );
    }

    default:
      return null;
  }
}

export default function FieldConfig(props: FieldConfigProps) {
  const { field, onChange } = props;

  if (isDisplayField(field.type)) {
    return (
      <div className="pt-1">
        <DisplayConfig field={field} onChange={onChange} />
      </div>
    );
  }

  return (
    <div className="pt-1">
      <Row label="Label">
        <input
          value={(field.label as string) ?? ''}
          onChange={event => onChange({ label: event.target.value })}
          className={inputClass}
        />
      </Row>

      <Row label="Help text (optional)">
        <input
          value={(field.help as string) ?? ''}
          placeholder="Shown under the field"
          onChange={event =>
            onChange({ help: event.target.value === '' ? undefined : event.target.value })
          }
          className={inputClass}
        />
      </Row>

      <TypeSpecific {...props} />

      {/* A repeat group has no meaningful "required" of its own: what it demands
          is "every teammate reviewed", which is `require_all_targets` above. A
          required group would also be unsatisfiable for a team of one, whose
          answer is legitimately an empty object. */}
      {field.type === 'repeat_group' ? null : (
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
          <input
            type="checkbox"
            checked={Boolean(field.required)}
            onChange={event => onChange({ required: event.target.checked })}
          />
          Required
          {field.type === 'switch' ? (
            <span className="text-xs text-gray-500">— must be switched on to submit</span>
          ) : null}
        </label>
      )}
    </div>
  );
}
