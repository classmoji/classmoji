/**
 * Size caps that a schema checks before it parses the value they cap, and a
 * bounded rendering of validation issues.
 *
 * `capArray`, `capKeys` and `capElements` count a value first, in a
 * `z.preprocess` step that ends the parse with one issue when the value is
 * over its cap (an issue raised before a pipe stops it: the wrapped schema
 * never runs). Within the cap, the wrapped schema parses it as before.
 *
 * The wrapped schema is what a JSON Schema export (the MCP `tools/list`)
 * describes: a preprocess step is invisible there. `capArray` expects a
 * schema that carries the same `.max()`, so the published limit and the
 * checked one agree.
 *
 * No Node imports: these run in the browser bundles too (quiz submissions,
 * form answers).
 */

import { z } from 'zod';

/**
 * Array elements plus object members in `value`, recursively, counted
 * iteratively and stopping once the count passes `stopAfter`. The same
 * measure as the MCP server's `countJsonElements` (apps/mcp inputLimits.ts).
 */
export function countJsonElements(value: unknown, stopAfter = Infinity): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (++count > stopAfter) return count;
        if (child !== null && typeof child === 'object') stack.push(child);
      }
    } else {
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        if (++count > stopAfter) return count;
        const child = (node as Record<string, unknown>)[key];
        if (child !== null && typeof child === 'object') stack.push(child);
      }
    }
  }
  return count;
}

/** Whether a plain object has more than `max` own keys, counting no further. */
function hasMoreKeysThan(value: object, max: number): boolean {
  let count = 0;
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key) && ++count > max) return true;
  }
  return false;
}

/**
 * `schema`, refusing an array longer than `max` before its elements are
 * parsed. The issue is the one `.max(max, message)` raises (same code, data
 * and message, error maps included), so `schema` should carry that `.max()`.
 * Anything that is not an array goes to `schema` unchanged.
 */
export function capArray<T extends z.ZodTypeAny>(schema: T, max: number, message?: string) {
  return z.preprocess((value, ctx) => {
    if (Array.isArray(value) && value.length > max) {
      ctx.addIssue({
        code: 'too_big',
        origin: 'array',
        maximum: max,
        inclusive: true,
        input: value,
        ...(message === undefined ? {} : { message }),
      });
    }
    return value;
  }, schema);
}

/**
 * `schema`, refusing a plain object with more than `max` own keys before its
 * members are parsed. Arrays and anything that is not an object go to
 * `schema` unchanged.
 */
export function capKeys<T extends z.ZodTypeAny>(schema: T, max: number, message?: string) {
  return z.preprocess((value, ctx) => {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      hasMoreKeysThan(value, max)
    ) {
      ctx.addIssue({ code: 'custom', message: message ?? `Expected at most ${max} keys` });
    }
    return value;
  }, schema);
}

/**
 * `schema`, refusing a value that carries more than `max` array elements and
 * object members in all (`countJsonElements`) before any of it is parsed: a
 * limit on the value as a whole, beside the caps on its parts.
 */
export function capElements<T extends z.ZodTypeAny>(schema: T, max: number, message?: string) {
  return z.preprocess((value, ctx) => {
    if (value !== null && typeof value === 'object' && countJsonElements(value, max) > max) {
      ctx.addIssue({
        code: 'custom',
        message: message ?? `Too large: at most ${max} array elements and object members`,
      });
    }
    return value;
  }, schema);
}

/**
 * The most array elements and object members one block-op or deck-op save
 * may carry (`capElements`): the MCP server's per-call limit
 * (`MAX_TOOL_INPUT_ELEMENTS`, 25,000, apps/mcp inputLimits.ts) plus room for
 * what deck_apply adds to an op before it forwards the ops to the collab
 * server (a minted block id, a file's src and rev). The largest real page
 * measured holds about 13,700 (about 620 top-level blocks). An editor save
 * over it falls back to a whole-document save, as for any refused ops
 * payload.
 */
export const MAX_OPS_PAYLOAD_ELEMENTS = 26_000;

/** How many issues `issueText` and `boundIssues` keep. */
export const MAX_SHOWN_ISSUES = 20;
/** The longest message kept per issue; longer ones are cut. */
export const MAX_SHOWN_ISSUE_MESSAGE_CHARS = 200;
/** The most path segments kept per issue, and the longest segment. */
export const MAX_SHOWN_PATH_SEGMENTS = 8;
export const MAX_SHOWN_PATH_SEGMENT_CHARS = 64;
/** The most characters `issueText` returns before its "…and N more" tail. */
export const MAX_SHOWN_ISSUES_TEXT_CHARS = 4_000;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** An issue's path as `a.b.0`, with long or deep paths cut. */
export function issuePath(path: ReadonlyArray<PropertyKey>): string {
  const shown = path
    .slice(0, MAX_SHOWN_PATH_SEGMENTS)
    .map(segment => cut(String(segment), MAX_SHOWN_PATH_SEGMENT_CHARS));
  if (path.length > MAX_SHOWN_PATH_SEGMENTS) shown.push('…');
  return shown.join('.');
}

/**
 * The first `MAX_SHOWN_ISSUES` issues, each message and path cut, plus a last
 * entry saying how many more there were. What a caller returns or attaches
 * when it hands issues on.
 */
export function boundIssues(issues: ReadonlyArray<z.ZodIssue>): z.ZodIssue[] {
  const kept = issues.slice(0, MAX_SHOWN_ISSUES).map(issue => ({
    ...issue,
    path: issue.path
      .slice(0, MAX_SHOWN_PATH_SEGMENTS)
      .map(segment =>
        typeof segment === 'string' ? cut(segment, MAX_SHOWN_PATH_SEGMENT_CHARS) : segment
      ),
    message: cut(issue.message, MAX_SHOWN_ISSUE_MESSAGE_CHARS),
  })) as z.ZodIssue[];
  const more = issues.length - kept.length;
  if (more > 0) {
    kept.push({ code: z.ZodIssueCode.custom, path: [], message: `…and ${more} more` });
  }
  return kept;
}

/**
 * Issues as `path: message` joined by `; `: at most `MAX_SHOWN_ISSUES` of
 * them and `MAX_SHOWN_ISSUES_TEXT_CHARS` characters, each message and path
 * cut, then `; …and N more` when any were left out. A short list reads exactly
 * as `issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')`.
 */
export function issueText(issues: ReadonlyArray<z.ZodIssue>): string {
  const parts: string[] = [];
  let length = 0;
  for (const issue of issues.slice(0, MAX_SHOWN_ISSUES)) {
    const part = `${issuePath(issue.path)}: ${cut(issue.message, MAX_SHOWN_ISSUE_MESSAGE_CHARS)}`;
    if (parts.length > 0 && length + part.length > MAX_SHOWN_ISSUES_TEXT_CHARS) break;
    parts.push(part);
    length += part.length + 2;
  }
  const more = issues.length - parts.length;
  return more > 0 ? `${parts.join('; ')}; …and ${more} more` : parts.join('; ');
}
