/**
 * The two string formats our schemas share, each kept to the rule our ids
 * and dates were validated with before zod 4.
 *
 * - `uuidString()`: an id in uuid form, any 8-4-4-4-12 hex string. zod 4's
 *   `z.uuid()` also checks the RFC 9562 version and variant bits; ids a
 *   caller stored inside JSON (form definitions, team-set configs) may not
 *   carry them, and Postgres accepts them all. Published as `format: uuid`.
 * - `isoDateTime()`: an ISO 8601 date and time with `Z` or an offset, seconds
 *   and fraction optional (`2026-11-12T17:00-05:00`, `…T17:00Z`,
 *   `…T17:00:00-0500` all pass). zod 4's `datetime({ offset: true })`
 *   requires seconds and an `HH:MM` offset. Published as
 *   `format: date-time`, with no pattern.
 *
 * Functions, so each use is its own schema instance (a JSON Schema export can
 * publish a schema met twice in one tool as a `$ref`).
 *
 * No Node imports: form definitions run in the browser too.
 */

import { z } from 'zod';

/**
 * zod 3.25.76's `.datetime({ offset: true })` pattern (v3/types.js
 * `datetimeRegex`), as is: a real calendar date, `T`, `HH:MM`, optional
 * `:SS` and fraction, then `Z` or `[+-]HH:?MM`.
 */
const DATETIME_WITH_OFFSET =
  /^((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|([+-]\d{2}:?\d{2}))$/;

/** A uuid-form id: any 8-4-4-4-12 hex string (`z.guid()`), refused as "Invalid UUID". */
export function uuidString() {
  return z.guid({
    error: issue => (issue.code === 'invalid_format' ? 'Invalid UUID' : undefined),
  });
}

/**
 * An ISO 8601 date and time with `Z` or an offset (seconds optional). A
 * refusal is the `invalid_format` issue zod raises for a datetime ("Invalid
 * ISO datetime").
 */
export function isoDateTime() {
  return z.stringFormat('datetime', value => DATETIME_WITH_OFFSET.test(value));
}
