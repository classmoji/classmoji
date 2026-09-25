/**
 * Class-zone renderings on every classroom-bound read (tools AND resources).
 *
 * A model reading `"student_deadline": "2026-09-21T03:59:00.000Z"` reports the
 * UTC wall-clock — "due Sep 21 at 3:59 AM" for what is really Sun Sep 20, 11:59
 * PM in New York — and works weekdays out for itself, badly. Ask Moji and the
 * Claude.ai connector both read these payloads, so the conversion is done ONCE,
 * here, for every tool, instead of per handler:
 *
 *   - every student-meaningful timestamp field (LOCALIZED_KEYS below) gains a
 *     `<field>_local` sibling in the classroom's zone (`Sun Sep 20, 2026, 11:59 PM EDT`). Nothing is removed or renamed;
 *     the ISO value stays the machine-readable truth.
 *   - a payload that carried any timestamp also gains top-level `timezone` and
 *     `now_local` (when those keys are free), so the reader can tell "tonight"
 *     from "tomorrow" without trusting its own clock or zone.
 *
 * Applied in the registry, after the handler, to the tool result text and to
 * the resource payload alike — so a mirror tool and its resource still agree.
 */

import { addLocalTimes, formatNowContext, resolveTimeZone } from '@classmoji/utils';
import type { ToolResult } from './registry.ts';

/**
 * The dates a reader actually QUOTES — deadlines, when something opens,
 * closes, starts or ends, and when a student's own work was submitted, closed
 * or graded. Only these get a `_local` twin.
 *
 * Record-keeping stamps (`created_at`, `updated_at`, `last_activity`,
 * `verified_at`, `oldest_commit_at`, token expiries, …) are left alone: nobody
 * asks Ask Moji when a row was last updated, and on a 500-row submissions list
 * those twins were most of the growth (Tim, decision 3, 2026-09-25).
 * An allowlist rather than a denylist, so a new bookkeeping column added
 * anywhere does not silently start growing every payload.
 */
const LOCALIZED_KEYS: ReadonlySet<string> = new Set([
  'due_date',
  'due_at',
  'release_at',
  'opens_at',
  'closes_at',
  'start_time',
  'end_time',
  'submitted_at',
  'closed_at',
  'last_graded_at',
  // The calendar's `range: { start, end }`: which local window was searched.
  'start',
  'end',
]);

/** True for a key whose timestamp gets a `_local` rendering. */
export function isLocalizedDateKey(key: string): boolean {
  // Every `*_deadline` (student_deadline, grader_deadline, team_formation_deadline…).
  return LOCALIZED_KEYS.has(key) || key.endsWith('_deadline');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `payload` with class-zone renderings added (see file header). */
export function localizePayload<T>(
  payload: T,
  zone: string | null | undefined,
  now: Date = new Date()
): T {
  const { value, count } = addLocalTimes(payload, zone, { include: isLocalizedDateKey });
  // No timestamps: hand back the ORIGINAL, so callers can tell nothing changed
  // and leave the serialized text byte-for-byte alone.
  if (count === 0) return payload;
  if (!isPlainObject(value)) return value;

  const extra: Record<string, unknown> = {};
  if (!('timezone' in value)) extra.timezone = resolveTimeZone(zone).timeZone;
  if (!('now_local' in value)) extra.now_local = formatNowContext(now, zone);
  return { ...value, ...extra } as T;
}

/**
 * A tool result with class-zone renderings added to each JSON text block.
 * Error results and non-JSON text pass through untouched.
 */
export function localizeToolResult(
  result: ToolResult,
  zone: string | null | undefined,
  now: Date = new Date()
): ToolResult {
  if (result.isError || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: result.content.map(block => {
      if (block.type !== 'text' || typeof block.text !== 'string') return block;
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.text);
      } catch {
        return block;
      }
      if (parsed === null || typeof parsed !== 'object') return block;
      const localized = localizePayload(parsed, zone, now);
      if (localized === parsed) return block;
      // Same serialization as tools/shared.ts ok() and the resource read.
      return { ...block, text: JSON.stringify(localized, null, 2) };
    }),
  };
}

/**
 * The zone argument the renderers take for a resolved classroom: the effective
 * zone, or null on the UTC default so every label says the course has none.
 */
export function renderZone(effective: { timeZone: string; source: string }): string | null {
  return effective.source === 'default' ? null : effective.timeZone;
}
