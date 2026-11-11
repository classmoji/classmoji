/**
 * Tool input validation messages of a bounded size.
 *
 * The MCP SDK answers a tools/call whose arguments fail the tool's input
 * schema with every issue the schema's Standard Schema `validate` returned,
 * each rendered as `a.0.b: message` and joined with ", " after "Input
 * validation error: Invalid arguments for tool <name>: ". zod reports an issue
 * for every failing element, and one issue's message or path can be as long
 * as the input (an object's unknown keys, a record key).
 *
 * `boundedValidate` validates with a zod schema so the SDK gets back at most
 * MAX_REPORTED_ISSUES issues, each cut (`boundIssue` from
 * @classmoji/utils/input-caps: message, path segments and their length),
 * within MAX_ISSUES_TEXT_CHARS in all, plus one saying how many were left
 * out. A parse that throws is answered with one fixed issue, never with the
 * error's own text. This bounds the text the caller gets back, not what zod
 * allocates while parsing: the element limits in inputLimits.ts do that.
 */

import { boundIssue, MAX_SHOWN_ISSUES, MAX_SHOWN_PATH_SEGMENTS } from '@classmoji/utils/input-caps';
import type { StandardSchemaV1 } from '@modelcontextprotocol/server';
import { z } from 'zod';

type Issue = StandardSchemaV1.Issue;
type Result<T> = StandardSchemaV1.Result<T>;

export const MAX_REPORTED_ISSUES = MAX_SHOWN_ISSUES;
/** The SDK adds "Input validation error: Invalid arguments for tool <name>: ". */
export const MAX_ISSUES_TEXT_CHARS = 3_600;

/** What the caller reads when the arguments could not be checked at all. */
export const UNCHECKED_ARGUMENTS_MESSAGE =
  'The arguments could not be checked: they are too large or too deeply nested.';

/** The SDK's rendering of one issue (its `formatIssue`), for sizing. */
function rendered(issue: Issue): string {
  if (!issue.path?.length) return issue.message;
  const path = issue.path.map(p => String(typeof p === 'object' ? p.key : p)).join('.');
  return `${path}: ${issue.message}`;
}

/** The first issues that fit, then one saying how many more there were. */
export function boundIssues(issues: ReadonlyArray<Issue>): Issue[] {
  const kept: Issue[] = [];
  let size = 0;
  for (const issue of issues.slice(0, MAX_REPORTED_ISSUES)) {
    const path = (issue.path ?? []).map(segment =>
      typeof segment === 'object' && segment !== null ? segment.key : segment
    );
    const bounded = boundIssue({
      code: 'custom',
      message: String(issue.message),
      path,
    } as z.ZodIssue);
    const trimmed: Issue = {
      message: bounded.message,
      path: path.length > MAX_SHOWN_PATH_SEGMENTS ? [...bounded.path, '…'] : bounded.path,
    };
    // The SDK joins issues with ", ".
    const length = rendered(trimmed).length + 2;
    if (size + length > MAX_ISSUES_TEXT_CHARS) break;
    kept.push(trimmed);
    size += length;
  }
  const more = issues.length - kept.length;
  if (more > 0) {
    kept.push({
      message: `…and ${more} more validation issue${more === 1 ? '' : 's'} not shown`,
    });
  }
  return kept;
}

function unchecked(error: unknown): Result<never> {
  console.warn(
    '[mcp] tool input validation threw:',
    error instanceof Error ? error.name : typeof error
  );
  return { issues: [{ message: UNCHECKED_ARGUMENTS_MESSAGE }] };
}

function bounded<T>(parsed: z.ZodSafeParseResult<T>): Result<T> {
  return parsed.success ? { value: parsed.data } : { issues: boundIssues(parsed.error.issues) };
}

/**
 * A Standard Schema `validate` for `schema`: a bounded set of issues
 * (`boundIssues`), and one fixed issue if the parse throws. It parses
 * synchronously, once; only a schema with an asynchronous check (zod throws
 * its async error) is parsed again asynchronously, and those issues are
 * bounded too. (zod's own `validate` retries any throw asynchronously, so a
 * check that throws would run twice.)
 */
export function boundedValidate<T>(
  schema: z.ZodType<T>
): (value: unknown) => Result<T> | Promise<Result<T>> {
  return value => {
    try {
      return bounded(schema.safeParse(value));
    } catch (error) {
      if (!(error instanceof z.core.$ZodAsyncError)) return unchecked(error);
    }
    return schema.safeParseAsync(value).then(bounded, unchecked);
  };
}
