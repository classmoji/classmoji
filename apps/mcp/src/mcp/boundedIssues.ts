/**
 * Tool input validation messages of a bounded size.
 *
 * The MCP SDK answers a tools/call whose arguments fail the tool's zod schema
 * with one line per zod issue (`getParseErrorMessage` in its zod-compat), and
 * zod 3 reports an issue for every failing element. `withBoundedIssues` makes
 * a schema report at most MAX_REPORTED_ISSUES of them, each cut to
 * MAX_ISSUE_MESSAGE_CHARS, within MAX_ISSUES_TEXT_CHARS in all, plus one line
 * saying how many were left out. It bounds the text the caller gets back, not
 * what zod allocates while parsing: the element limits in inputLimits.ts do
 * that.
 *
 * How: the SDK turns a raw-shape inputSchema into a zod object at
 * registration and calls `safeParseAsync` on that object for every call, so
 * registering a pre-built object whose `safeParseAsync` trims the issues is
 * enough. The object is the same `z.object(shape)` the SDK would have built,
 * so tools/list (its JSON schema) does not change.
 */

import { z } from 'zod';

export const MAX_REPORTED_ISSUES = 20;
export const MAX_ISSUE_MESSAGE_CHARS = 200;
/** The SDK adds "MCP error -32602: Input validation error: Invalid arguments for tool <name>: ". */
export const MAX_ISSUES_TEXT_CHARS = 3_600;
const MAX_PATH_SEGMENTS = 12;

/** The SDK's rendering of one issue (zod-compat `getDotPath`), for sizing. */
function rendered(issue: z.ZodIssue): string {
  if (issue.path.length === 0) return issue.message;
  const path = issue.path.reduce<string>((acc, seg, index) => {
    if (index === 0) return String(seg);
    return typeof seg === 'number' ? `${acc}[${seg}]` : `${acc}.${seg}`;
  }, '');
  return `${issue.message} at ${path}`;
}

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The first issues that fit, then one saying how many more there were. */
export function boundIssues(issues: readonly z.ZodIssue[]): z.ZodIssue[] {
  const kept: z.ZodIssue[] = [];
  let size = 0;
  for (const issue of issues) {
    if (kept.length >= MAX_REPORTED_ISSUES) break;
    const trimmed = {
      ...issue,
      message: cut(issue.message, MAX_ISSUE_MESSAGE_CHARS),
      path: issue.path.slice(0, MAX_PATH_SEGMENTS),
    } as z.ZodIssue;
    const length = rendered(trimmed).length + 1;
    if (size + length > MAX_ISSUES_TEXT_CHARS) break;
    kept.push(trimmed);
    size += length;
  }
  const more = issues.length - kept.length;
  if (more > 0) {
    kept.push({
      code: z.ZodIssueCode.custom,
      path: [],
      message: `…and ${more} more validation issue${more === 1 ? '' : 's'} not shown`,
    });
  }
  return kept;
}

/** `schema`, reporting at most a bounded set of issues from `safeParseAsync`. */
export function withBoundedIssues<T extends z.ZodTypeAny>(schema: T): T {
  const parseAsync = schema.safeParseAsync.bind(schema);
  const bounded: T['safeParseAsync'] = async (data, params) => {
    const result = await parseAsync(data, params);
    if (result.success || result.error.issues.length === 0) return result;
    return { success: false, error: new z.ZodError(boundIssues(result.error.issues)) };
  };
  Object.defineProperty(schema, 'safeParseAsync', { value: bounded, configurable: true });
  return schema;
}
