/**
 * Class-zone renderings on every classroom-bound read (tools AND resources).
 *
 * A model reading `"student_deadline": "2026-09-21T03:59:00.000Z"` reports the
 * UTC wall-clock — "due Sep 21 at 3:59 AM" for what is really Sun Sep 20, 11:59
 * PM in New York — and works weekdays out for itself, badly. Ask Moji and the
 * Claude.ai connector both read these payloads, so the conversion is done ONCE,
 * here, for every tool, instead of per handler:
 *
 *   - every timestamp field gains a `<field>_local` sibling in the classroom's
 *     zone (`Sun Sep 20, 2026, 11:59 PM EDT`). Nothing is removed or renamed;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `payload` with class-zone renderings added (see file header). */
export function localizePayload<T>(
  payload: T,
  zone: string | null | undefined,
  now: Date = new Date()
): T {
  const { value, count } = addLocalTimes(payload, zone);
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
