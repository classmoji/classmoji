/**
 * CSV serialization, shared by every export in the platform.
 *
 * PURE MODULE — no Node built-ins, no DOM. It runs in a server action that
 * answers with `text/csv`, in a browser that builds a Blob, and in vitest.
 *
 * ── Why this lives here rather than beside one exporter ────────────────────
 * Exports are written once per feature and read forever by whoever opens the
 * file in Excel, Numbers, or Sheets. Those three agree on the RFC 4180 quoting
 * rules and on one more convention that is easy to miss: a cell whose text
 * begins with `=`, `+`, `-`, `@`, a tab, or a carriage return is treated as the
 * start of a FORMULA rather than as text. A student named `-Anne` or a note
 * reading `+1 on this` therefore arrives in the spreadsheet as something other
 * than what was typed. Prefixing such a cell with an apostrophe is the
 * long-standing convention for "this is literal text" and is stripped by the
 * spreadsheet on display.
 *
 * Applying that consistently is the whole reason for a shared helper: each
 * exporter re-deriving the rule gets a different answer, and the ones that skip
 * it silently mangle a fraction of the rows.
 */

/** The leading characters a spreadsheet reads as "this cell is a formula". */
const TEXT_CELL_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Mark a string cell as literal text when it would otherwise be interpreted as
 * a formula.
 *
 * STRINGS ONLY, by design. Numbers must reach this function already as numbers
 * (see `csvCell`) so that `-5` stays a negative number and does not become the
 * text `'-5` in every numeric column of every export.
 */
export function csvTextCell(value: string): string {
  if (value.length === 0) return value;
  return TEXT_CELL_PREFIXES.includes(value[0]) ? `'${value}` : value;
}

/**
 * One cell, normalized.
 *
 * `null`/`undefined` become the empty string (a spreadsheet has no other
 * representation of "nothing"), numbers and booleans stringify as themselves,
 * and everything else is treated as text and gets the text-cell handling above.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return csvTextCell(String(value));
}

/** RFC 4180 quoting: wrap when the cell carries a delimiter, quote, or newline. */
function quote(cell: string): string {
  if (/[",\r\n]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

/**
 * A full CSV document from a row-major array.
 *
 * CRLF line endings, per RFC 4180 — the one form every spreadsheet on every
 * platform opens without a prompt.
 */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return rows.map(row => row.map(cell => quote(csvCell(cell))).join(',')).join('\r\n');
}
