import type { FormField } from '@classmoji/services/form-contract';
import { toCsv } from '@classmoji/utils';

import {
  formatAnswer,
  innerFieldsOf,
  isDisplayOnly,
  matrixOf,
  reviewedTargets,
  targetName,
  targetsFor,
} from '~/components/forms/answerFormat.ts';

/**
 * The two response exports.
 *
 * WIDE — one row per response — is the general-purpose sheet: identity, the
 * submission's own metadata, the staff triage columns, then every answer. It is
 * what replaces the Fillout→Notion round trip, with `staff_status` standing in
 * for the Notion Status property.
 *
 * LONG — one row per (response × review target) — exists because a peer review
 * is not one record. A wide sheet would need a column per teammate per rubric
 * line, and the teammate set differs per respondent, so the columns would not
 * even be the same for two rows. Offered only when the definition actually has
 * a repeat group.
 *
 * ── Columns come from the CURRENT revision ─────────────────────────────────
 * Responses may have been filled against several revisions of the same form.
 * Field ids are stable across revisions (that is the whole reason answers key
 * on uuids), so the current revision's field list is the one column set that
 * lines every response up. An answer whose field was removed in a later
 * revision has no column and does not appear — noted in the drawer, where
 * there is room to say so.
 *
 * ── Text cells ─────────────────────────────────────────────────────────────
 * Cells go through `@classmoji/utils`' shared `toCsv`, which applies the
 * platform's consistent text-cell handling for spreadsheets. Nothing here
 * formats a cell by hand.
 */

/** The response shape both builders read. Matches the loader's row. */
export interface ExportableResponse {
  id: string;
  name: string | null;
  email: string;
  submitted_at: string;
  verified_at: string | null;
  submission_state: string;
  staff_status: string | null;
  staff_note: string | null;
  answers: Record<string, unknown>;
  resolved_context: unknown;
}

/** Identity + metadata + triage, ahead of every answer column. */
const LEAD_HEADERS = [
  'Name',
  'Email',
  'Submitted at',
  'Verified at',
  'Submission state',
  'Staff status',
  'Staff note',
];

const leadCells = (response: ExportableResponse) => [
  response.name ?? '',
  response.email,
  response.submitted_at,
  response.verified_at ?? '',
  response.submission_state,
  response.staff_status ?? '',
  response.staff_note ?? '',
];

/** Fields that contribute a column: everything that collects an answer. */
const answerFields = (fields: FormField[]): FormField[] => fields.filter(f => !isDisplayOnly(f));

/** Does this definition need the two-row header at all? */
export const hasMatrix = (fields: FormField[]): boolean =>
  answerFields(fields).some(field => field.type === 'matrix');

/** Does this definition have a repeat group, i.e. is the long export offered? */
export const hasRepeatGroup = (fields: FormField[]): boolean =>
  answerFields(fields).some(field => field.type === 'repeat_group');

const scaleOf = (field: FormField) => field.scale as { min: number; max: number } | undefined;

/**
 * A column heading.
 *
 * An opinion scale carries its range HERE rather than in every cell. The table
 * shows "7 / 10" because a reader scanning one row needs the ceiling next to
 * the number; a spreadsheet column does not — it needs to be averageable, and
 * "7 / 10" in 87 cells is text that has to be split before it can be summed.
 * The range belongs to the question, so it goes on the question.
 */
function headerLabel(field: FormField): string {
  const label = (field.label as string) ?? '';
  if (field.type === 'repeat_group') return `${label} (teammates reviewed)`;
  const scale = field.type === 'opinion_scale' ? scaleOf(field) : undefined;
  return scale ? `${label} (${scale.min}–${scale.max})` : label;
}

/** A cell, keeping numeric answers numeric. */
function cellFor(field: FormField, value: unknown): string | number {
  if (field.type === 'opinion_scale' || field.type === 'number') {
    return typeof value === 'number' ? value : '';
  }
  return formatAnswer(field, value);
}

/**
 * The wide sheet.
 *
 * A matrix spans one column per row, so its own label has nowhere to sit on a
 * single header line. The grades export solved this years ago with two header
 * rows — a group row naming the block and a sub-row naming each column — and
 * this uses the same shape so an instructor who has opened a grades CSV already
 * knows how to read this one. The group row is emitted ONLY when a matrix is
 * present: adding a blank first line to every waitlist export would be a cost
 * paid by every form for the sake of the few that need it.
 */
export function buildWideCsv(fields: FormField[], responses: ExportableResponse[]): string {
  const columns = answerFields(fields);
  const twoRow = hasMatrix(fields);

  const groupRow: string[] = twoRow ? LEAD_HEADERS.map(() => '') : [];
  const headerRow: string[] = [...LEAD_HEADERS];

  for (const field of columns) {
    const label = (field.label as string) ?? '';
    if (field.type === 'matrix') {
      const { rows } = matrixOf(field);
      rows.forEach((row, index) => {
        if (twoRow) groupRow.push(index === 0 ? label : '');
        headerRow.push(row.label);
      });
      continue;
    }
    if (twoRow) groupRow.push('');
    headerRow.push(headerLabel(field));
  }

  const body = responses.map(response => {
    const cells: (string | number)[] = leadCells(response);
    for (const field of columns) {
      const value = response.answers?.[field.id];
      if (field.type === 'matrix') {
        const { rows, columns: matrixColumns } = matrixOf(field);
        const answer = (value ?? {}) as Record<string, unknown>;
        for (const row of rows) {
          const chosen = matrixColumns.find(column => column.id === answer[row.id]);
          cells.push(chosen?.label ?? '');
        }
        continue;
      }
      if (field.type === 'repeat_group') {
        // A count, not the reviews. The reviews are the long sheet's job — and
        // trying to fit them here is exactly what the long sheet exists to
        // avoid.
        cells.push(reviewedTargets(value).length);
        continue;
      }
      cells.push(cellFor(field, value));
    }
    return cells;
  });

  return toCsv(twoRow ? [groupRow, headerRow, ...body] : [headerRow, ...body]);
}

/**
 * The long sheet: one row per review written.
 *
 * Target identity comes from the response's OWN `resolved_context` snapshot,
 * which is why account deletion or a roster change later cannot orphan a
 * review. A target the snapshot marks removed still gets its row — the review
 * happened, and dropping it would quietly change the data an instructor is
 * reading.
 *
 * Inner matrix answers are flattened to a single cell here. A second level of
 * sub-columns would make the header unreadable, and the wide sheet already
 * carries matrices with their own columns.
 */
export function buildLongCsv(fields: FormField[], responses: ExportableResponse[]): string {
  const groups = answerFields(fields).filter(field => field.type === 'repeat_group');
  const inner = groups.flatMap(group => innerFieldsOf(group)).filter(f => !isDisplayOnly(f));

  // One column per DISTINCT inner field across all groups; a form with two
  // review blocks keeps them in one sheet, distinguished by the Review block
  // column rather than by two disjoint column sets.
  const innerColumns: FormField[] = [];
  const seen = new Set<string>();
  for (const field of inner) {
    if (seen.has(field.id)) continue;
    seen.add(field.id);
    innerColumns.push(field);
  }

  const headerRow = [
    'Reviewer',
    'Reviewer email',
    'Review block',
    'Reviewee',
    'Reviewee email',
    'Reviewee status',
    'Submitted at',
    ...innerColumns.map(headerLabel),
  ];

  const body: (string | number)[][] = [];
  for (const response of responses) {
    for (const group of groups) {
      const value = response.answers?.[group.id];
      const answer = (value ?? {}) as Record<string, unknown>;
      for (const target of targetsFor(response.resolved_context, group.id, value)) {
        const review = (answer[target.user_id] ?? {}) as Record<string, unknown>;
        body.push([
          response.name ?? '',
          response.email,
          (group.label as string) ?? '',
          targetName(target),
          target.email ?? '',
          target.removed ? 'No longer on the team' : 'On the team',
          response.submitted_at,
          ...innerColumns.map(field => cellFor(field, review[field.id])),
        ]);
      }
    }
  }

  return toCsv([headerRow, ...body]);
}

/** `waitlist-responses-2026-08-30.csv` — dated, so two exports never collide. */
export function csvFilename(formSlug: string, kind: 'responses' | 'reviews'): string {
  return `${formSlug}-${kind}-${new Date().toISOString().slice(0, 10)}.csv`;
}

/**
 * A CSV response.
 *
 * `no-store` because the body is applicant PII in its most portable form; a
 * shared cache holding one of these is the same problem as a cached responses
 * page, only easier to miss.
 */
export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
