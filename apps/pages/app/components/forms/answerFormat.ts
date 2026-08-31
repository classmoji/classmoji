import type { FormField, FormFieldType, FormOption } from '@classmoji/services/form-contract';

import { unhandledFieldType } from './fieldTypes.ts';

/**
 * Turning a stored answer back into something a human reads.
 *
 * PURE MODULE, browser-safe: the contract is reached through the
 * `@classmoji/services/form-contract` subpath (zod and nothing else), so this
 * is importable from the responses table, the response drawer, AND the
 * server-side CSV builder. That shared use is the point — a status chip, a
 * drawer, and an export that each re-derived "what does option id
 * 3f2a… mean" would eventually disagree about the same response.
 *
 * Answers key on UUIDs, never on labels (see formContract's header), so every
 * function here takes the FIELD whose definition holds the id→label map. A
 * label that has since been reworded therefore reads with its CURRENT wording,
 * which is what an instructor expects; the identity of the choice is the id.
 */

/** Options as stored on a choice-shaped field. */
export const optionsOf = (field: FormField): FormOption[] => (field.options as FormOption[]) ?? [];

/**
 * The label of one option id, or the raw id when the option is gone.
 *
 * The fallback matters: a response is read against a revision's field list, and
 * a stale draft or a hand-written import can carry an id no longer in it.
 * Showing the id is ugly and honest; showing an empty cell would look like an
 * unanswered question.
 */
export function optionLabel(field: FormField, id: unknown): string {
  if (typeof id !== 'string') return '';
  return optionsOf(field).find(option => option.id === id)?.label ?? id;
}

/** Matrix rows and columns, in definition order. */
export function matrixOf(field: FormField): { rows: FormOption[]; columns: FormOption[] } {
  const matrix = field.matrix as { rows?: FormOption[]; columns?: FormOption[] } | undefined;
  return { rows: matrix?.rows ?? [], columns: matrix?.columns ?? [] };
}

/** The separator every multi-value answer uses, in the table and the CSV alike. */
export const MULTI_JOIN = '; ';

/**
 * How each type occupies a table or a CSV.
 *
 * `scalar` fits one cell. `wide` cannot: a matrix needs a sub-column per row and
 * a repeat_group needs a row per review target, so both are handled explicitly
 * wherever they matter and this map is what keeps them out of the places that
 * assume one column per field. `display` collects nothing and never becomes a
 * column at all.
 *
 * A `Record<FormFieldType, …>` rather than a `Set` of the exceptions: a set of
 * exceptions silently classifies an unknown new type as scalar, which is the
 * one answer that is wrong for anything interesting. This does not compile until
 * a new type says which it is.
 */
const LAYOUT: Record<FormFieldType, 'scalar' | 'wide' | 'display'> = {
  short_text: 'scalar',
  long_text: 'scalar',
  email: 'scalar',
  number: 'scalar',
  dropdown: 'scalar',
  multiselect: 'scalar',
  switch: 'scalar',
  opinion_scale: 'scalar',
  ranked_choice: 'scalar',
  roster_select: 'scalar',
  matrix: 'wide',
  repeat_group: 'wide',
  heading: 'display',
  paragraph: 'display',
  banner: 'display',
};

export function isScalarField(field: FormField): boolean {
  return LAYOUT[field.type] === 'scalar';
}

/** Display blocks collect nothing, so they never become a column. */
export function isDisplayOnly(field: FormField): boolean {
  return LAYOUT[field.type] === 'display';
}

/**
 * One answer as a single line of text.
 *
 * Returns '' for an unanswered field — an optional field is legitimately blank
 * and must not read as "false" or "0".
 */
export function formatAnswer(field: FormField, value: unknown): string {
  if (value === null || value === undefined) return '';

  switch (field.type) {
    case 'switch':
      return value ? 'Yes' : 'No';

    case 'opinion_scale': {
      const scale = field.scale as { max?: number } | undefined;
      // The mockup's "7 / 10": a bare 7 is meaningless without the ceiling, and
      // the ceiling lives in the definition, not in the answer.
      return scale?.max === undefined ? String(value) : `${String(value)} / ${scale.max}`;
    }

    case 'dropdown':
      return optionLabel(field, value);

    case 'roster_select':
      return Array.isArray(value)
        ? value.map(item => optionLabel(field, item)).join(MULTI_JOIN)
        : optionLabel(field, value);

    case 'multiselect':
      return Array.isArray(value)
        ? value.map(item => optionLabel(field, item)).join(MULTI_JOIN)
        : '';

    case 'ranked_choice':
      // Rank is positional, so the order of the stored array IS the answer.
      // Numbering it keeps that visible in a flat cell.
      return Array.isArray(value)
        ? value.map((item, index) => `${index + 1}. ${optionLabel(field, item)}`).join(MULTI_JOIN)
        : '';

    case 'matrix': {
      const { rows, columns } = matrixOf(field);
      const answer = (value ?? {}) as Record<string, unknown>;
      return rows
        .filter(row => answer[row.id] !== undefined && answer[row.id] !== null)
        .map(row => {
          const column = columns.find(candidate => candidate.id === answer[row.id]);
          return `${row.label}: ${column?.label ?? String(answer[row.id])}`;
        })
        .join(MULTI_JOIN);
    }

    case 'repeat_group':
      return `${reviewedTargets(value).length} reviewed`;

    // Plain scalars: what was stored IS what a person typed.
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'number':
      return String(value);

    // Display blocks carry no answer, so there is nothing to format. They are
    // filtered out upstream by `isDisplayOnly`; this is here so the switch is
    // exhaustive rather than relying on the caller having remembered.
    case 'heading':
    case 'paragraph':
    case 'banner':
      return '';

    default:
      // The old `String(value)` fallback is why a new type would have exported
      // a raw ISO timestamp into a spreadsheet and told nobody.
      return unhandledFieldType(field.type, 'answerFormat.formatAnswer');
  }
}

/** The target ids a repeat-group answer actually carries a review for. */
export function reviewedTargets(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, review]) => review !== null && review !== undefined)
    .map(([targetId]) => targetId);
}

// ─── Per-respondent review context ──────────────────────────────────────────

/** One review target, as snapshotted into `FormResponse.resolved_context`. */
export interface ResolvedTarget {
  user_id: string;
  name?: string | null;
  email?: string | null;
  /** Set when the person left the team after the review was written. */
  removed?: boolean;
}

/**
 * The review targets resolved for one response's repeat group.
 *
 * Read GENERICALLY off the stored context rather than from any UI's assumption
 * about it: nothing creates repeat-group responses yet, and this surface must
 * render whatever the classroom submit path eventually snapshots. Targets that
 * are present in the ANSWERS but absent from the context are appended — a
 * review whose target vanished from the snapshot must still be visible, not
 * silently dropped from the drawer and the export.
 */
export function targetsFor(
  resolvedContext: unknown,
  groupId: string,
  answerValue?: unknown
): ResolvedTarget[] {
  const context = (resolvedContext ?? {}) as { targets?: Record<string, unknown> };
  const raw = context.targets?.[groupId];
  const targets: ResolvedTarget[] = Array.isArray(raw)
    ? raw
        .filter((entry): entry is ResolvedTarget => Boolean(entry) && typeof entry === 'object')
        .map(entry => ({ ...entry, user_id: String(entry.user_id) }))
    : [];

  const known = new Set(targets.map(target => target.user_id));
  for (const targetId of reviewedTargets(answerValue)) {
    if (!known.has(targetId)) targets.push({ user_id: targetId, removed: true });
  }
  return targets;
}

/** A target's display name, falling back to whatever identity survives. */
export const targetName = (target: ResolvedTarget): string =>
  target.name || target.email || target.user_id;

/** The inner field list of a repeat group. */
export const innerFieldsOf = (field: FormField): FormField[] => (field.fields as FormField[]) ?? [];
