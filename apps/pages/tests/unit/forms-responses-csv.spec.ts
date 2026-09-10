import { test, expect } from '@playwright/test';
import type { FormField } from '@classmoji/services/form-contract';

import {
  buildWideCsv,
  type ExportableResponse,
} from '../../app/forms/admin/responsesCsv.server.ts';

/**
 * The WIDE export's lead columns, pinned.
 *
 * ── Why this is a unit test ────────────────────────────────────────────────
 * The wide sheet is a CONTRACT with a file an instructor already has open. Its
 * lead columns are the ones a saved filter, a VLOOKUP, or a Notion import maps
 * by position, so the cost of moving one is paid silently, months later, by
 * somebody whose sheet now reads the staff note as the submission state. "Added
 * by" was appended LAST for exactly that reason, and nothing in the type system
 * says so — `LEAD_HEADERS` is a private array, and a well-meaning alphabetise or
 * an "identity columns belong together" tidy would reorder it without a single
 * red mark. This spec is the mark.
 *
 * The second thing pinned here is the two-row header's PADDING. The group row
 * exists only when a matrix is present, and it is padded with one empty cell per
 * lead column before the matrix label is pushed. Adding a lead column without
 * adding to the padding — which is what happens if the padding is ever written
 * as a literal count rather than derived from the header list — slides every
 * group label one column left of the block it names, and the sheet still opens
 * fine. Nobody notices until they read it.
 *
 * An end-to-end export test cannot see either property: it downloads one form's
 * CSV and confirms the bytes look like a CSV.
 */

let seq = 0;
const field = (patch: Record<string, unknown>): FormField =>
  ({
    id: `dddddddd-dddd-4ddd-8ddd-dddddddddd${String(++seq).padStart(2, '0')}`,
    required: false,
    ...patch,
  }) as unknown as FormField;

/** The lead columns, in the order the sheet promises them. */
const LEAD = [
  'Name',
  'Email',
  'Submitted at',
  'Verified at',
  'Submission state',
  'Staff status',
  'Staff note',
  'Added by',
];

/** Where "Added by" sits, and therefore where the answers start. */
const ADDED_BY = LEAD.indexOf('Added by');

const response = (patch: Partial<ExportableResponse> = {}): ExportableResponse => ({
  id: 'response-1',
  name: 'Ada Lovelace',
  email: 'ada@example.edu',
  submitted_at: '2026-09-10T12:00:00.000Z',
  verified_at: null,
  submission_state: 'submitted',
  staff_status: null,
  staff_note: null,
  answers: {},
  resolved_context: null,
  ...patch,
});

/**
 * The CSV back into cells.
 *
 * A naive split is only safe while no cell needs quoting, so that is asserted
 * rather than assumed — a fixture that grew a comma would otherwise shift every
 * index in this file and the failure would read as a column-order regression.
 */
const cells = (csv: string): string[][] => {
  expect(csv).not.toContain('"');
  return csv.split('\r\n').map(line => line.split(','));
};

test.describe('buildWideCsv — lead columns', () => {
  test('the header is the eight lead columns, in order, then the answers', () => {
    const fields = [
      field({ type: 'banner', text: 'FIFO, no guarantees.', tone: 'info' }),
      field({ type: 'short_text', label: 'Full name', required: true }),
      field({ type: 'long_text', label: 'Why this class?' }),
    ];

    const [header] = cells(buildWideCsv(fields, [response()]));

    // Stated in full rather than as "starts with": the point of the assertion is
    // that "Added by" is the LAST lead column, which a prefix check would miss.
    expect(header).toEqual([...LEAD, 'Full name', 'Why this class?']);
  });

  test('a form with no matrix emits ONE header row', () => {
    const fields = [field({ type: 'short_text', label: 'Full name' })];
    const rows = cells(buildWideCsv(fields, [response()]));

    expect(rows).toHaveLength(2); // header + the one response
    expect(rows[0][0]).toBe('Name');
  });
});

test.describe('buildWideCsv — the Added by cell', () => {
  const fields = [field({ type: 'short_text', label: 'Full name' })];
  const addedByCell = (patch: Partial<ExportableResponse>) =>
    cells(buildWideCsv(fields, [response(patch)]))[1][ADDED_BY];

  test('a resolved staff name is what the cell says', () => {
    expect(
      addedByCell({ added_by: 'user-grace', added_by_name: 'Grace Hopper' })
    ).toBe('Grace Hopper');
  });

  test('an unresolved adder falls back to the id, not to a blank', () => {
    // A deleted account — or one whose profile carries neither name nor login —
    // still wrote the row. An empty cell here would say the respondent filled
    // the form in themselves, which is the one thing it must never say.
    expect(addedByCell({ added_by: 'user-ghost', added_by_name: null })).toBe('user-ghost');
    expect(addedByCell({ added_by: 'user-ghost' })).toBe('user-ghost');
  });

  test('nobody added it — the ordinary case — is empty', () => {
    expect(addedByCell({ added_by: null })).toBe('');
    expect(addedByCell({})).toBe('');
  });

  test('a name is never invented from a null adder', () => {
    // added_by_name without added_by is incoherent input; the cell keys on the
    // id, so a stale name cannot leak into a respondent-filled row.
    expect(addedByCell({ added_by: null, added_by_name: 'Grace Hopper' })).toBe('');
  });
});

test.describe('buildWideCsv — the two-row header a matrix forces', () => {
  const matrix = () =>
    field({
      type: 'matrix',
      label: 'Rate each topic',
      matrix: {
        rows: [
          { id: 'row-recursion', label: 'Recursion' },
          { id: 'row-pointers', label: 'Pointers' },
        ],
        columns: [
          { id: 'col-shaky', label: 'Shaky' },
          { id: 'col-solid', label: 'Solid' },
        ],
      },
    });

  test('the group row is padded to the FULL lead-column count', () => {
    const grid = matrix();
    const rows = cells(buildWideCsv([grid], [response()]));
    const [groupRow, headerRow] = rows;

    expect(rows).toHaveLength(3); // group + header + the one response

    // Every lead column gets an empty group cell — eight of them, including the
    // one "Added by" added. Off by one and the label names the wrong block.
    expect(groupRow.slice(0, LEAD.length)).toEqual(LEAD.map(() => ''));

    // The label lands over the matrix's FIRST row column, and only that one.
    expect(groupRow[ADDED_BY + 1]).toBe('Rate each topic');
    expect(groupRow[ADDED_BY + 2]).toBe('');
    expect(groupRow).toHaveLength(LEAD.length + 2);

    // The sub-row names each matrix row, starting in the same column.
    expect(headerRow.slice(0, LEAD.length)).toEqual(LEAD);
    expect(headerRow[ADDED_BY + 1]).toBe('Recursion');
    expect(headerRow[ADDED_BY + 2]).toBe('Pointers');
  });

  test('the data cells line up under the sub-row they belong to', () => {
    const grid = matrix();
    const rows = cells(
      buildWideCsv(
        [grid],
        [
          response({
            added_by: 'user-grace',
            added_by_name: 'Grace Hopper',
            answers: { [grid.id]: { 'row-recursion': 'col-solid', 'row-pointers': 'col-shaky' } },
          }),
        ]
      )
    );
    const body = rows[2];

    // The whole point of the padding: the answer under "Recursion" is the
    // Recursion answer, with the lead columns still holding their own values.
    expect(body[ADDED_BY]).toBe('Grace Hopper');
    expect(body[ADDED_BY + 1]).toBe('Solid');
    expect(body[ADDED_BY + 2]).toBe('Shaky');
    expect(body).toHaveLength(LEAD.length + 2);
  });
});
