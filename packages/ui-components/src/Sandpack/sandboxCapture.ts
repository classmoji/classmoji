/**
 * What a code sandbox ran, as a submission reports it: the student's files,
 * the console's lines and the error Sandpack shows, read from the running
 * sandbox (`useSandboxCapture`) and cleaned here. Pure functions, no React:
 * the rules are tested on their own (`__tests__/sandboxCapture.test.ts`).
 *
 * The cleaning follows what the quiz mockup proved against live Sandpack
 * (plans/2026-10-12-quiz-sandbox/mockup.html):
 * - a console line keeps its first line only, objects as JSON, every
 *   argument joined by a space;
 * - `clear` entries and Sandpack's own "Error in sandbox:" line (logged ahead
 *   of a runtime error) are not the student's output and are dropped;
 * - an error keeps its title, the first line of its message without the
 *   "/path: " prefix and "(line:col)" suffix the bundler adds (the code frame
 *   and stack below it are dropped), its path, line and column.
 *
 * The caps are the caller's (the quiz passes its submission schema's), with
 * defaults equal to them: this package depends on no other workspace.
 */

/** The console methods a submission reports. */
export type CapturedConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface CapturedConsoleLine {
  method: CapturedConsoleMethod;
  text: string;
}

export interface CapturedError {
  /** `compile`: the code did not build (syntax, a missing module); `runtime`: it threw. */
  kind: 'compile' | 'runtime';
  title: string;
  message: string;
  path: string | null;
  line: number | null;
  column: number | null;
}

/** One console entry as Sandpack's console hook holds it. */
export interface SandpackConsoleEntry {
  method: string;
  data?: ReadonlyArray<unknown> | undefined;
}

/** The error Sandpack holds (`sandpack.error`). */
export interface SandpackErrorLike {
  title?: string;
  message?: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface CaptureLimits {
  /** The most console lines kept. */
  maxConsoleLines: number;
  /** The longest console line, in characters. */
  maxConsoleLineChars: number;
  /** The most errors kept. */
  maxErrors: number;
  maxErrorTitleChars: number;
  maxErrorMessageChars: number;
  /** A longer path is reported as unknown (null). */
  maxErrorPathChars: number;
}

/** The quiz submission schema's caps (`CodeSubmissionInputSchema`, @classmoji/utils). */
export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  maxConsoleLines: 50,
  maxConsoleLineChars: 300,
  maxErrors: 3,
  maxErrorTitleChars: 100,
  maxErrorMessageChars: 500,
  maxErrorPathChars: 100,
};

/** The line Sandpack logs before a runtime error: its own, not the student's. */
export const SANDPACK_ERROR_PREFIX_LINE = 'Error in sandbox:';

const firstLine = (text: string) => text.split(/\r\n|\r|\n/)[0];

/** `text`, cut to `max` characters (the last one an ellipsis when cut). */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

/**
 * The method a console entry is reported as, or null for one that is not
 * output (`clear`). `assert` reports a failure, so it is an error; `table`,
 * `count`, `time` and the like print, so they are logs.
 */
export function consoleMethodOf(method: string): CapturedConsoleMethod | null {
  switch (method) {
    case 'log':
    case 'info':
    case 'warn':
    case 'error':
    case 'debug':
      return method;
    case 'warning':
      return 'warn';
    case 'assert':
      return 'error';
    case 'clear':
      return null;
    default:
      return 'log';
  }
}

/** One console entry's text: each argument's first line (objects as JSON), joined by a space. */
export function consoleTextOf(data: ReadonlyArray<unknown> | undefined): string {
  return (data ?? [])
    .map(d => {
      if (typeof d === 'string') return firstLine(d);
      let json: string | undefined;
      try {
        json = JSON.stringify(d);
      } catch {
        json = undefined;
      }
      return firstLine(json ?? String(d));
    })
    .join(' ');
}

/** The console as a submission reports it (see the header), capped. */
export function consoleLinesOf(
  entries: ReadonlyArray<SandpackConsoleEntry>,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS
): CapturedConsoleLine[] {
  const lines: CapturedConsoleLine[] = [];
  for (const entry of entries) {
    if (lines.length >= limits.maxConsoleLines) break;
    const method = consoleMethodOf(entry.method);
    if (!method) continue;
    const text = consoleTextOf(entry.data);
    if (text === SANDPACK_ERROR_PREFIX_LINE) continue;
    lines.push({ method, text: clip(text, limits.maxConsoleLineChars) });
  }
  return lines;
}

/** "/index.js: Cannot read … (13:3)\n\n> 13 | …" → "Cannot read …". */
export const cleanErrorMessage = (message: string | undefined): string =>
  firstLine(message ?? '')
    .replace(/^\/[^:]+:\s*/, '')
    .replace(/\s*\(\d+:\d+\)\s*$/, '');

/** A syntax error or a module that can't be found stops the build; anything else is thrown at run time. */
export const errorKindOf = (title: string | undefined): CapturedError['kind'] =>
  /SyntaxError|ModuleNotFound/i.test(title ?? '') ? 'compile' : 'runtime';

const wholeAtLeast = (n: unknown, min: number): number | null =>
  typeof n === 'number' && Number.isInteger(n) && n >= min ? n : null;

/** The error a submission reports for Sandpack's error, if it holds one. */
export function capturedErrorsOf(
  error: SandpackErrorLike | null | undefined,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS
): CapturedError[] {
  if (!error || limits.maxErrors < 1) return [];
  const title = error.title?.trim() || 'Error';
  const path =
    typeof error.path === 'string' && error.path && error.path.length <= limits.maxErrorPathChars
      ? error.path
      : null;
  return [
    {
      kind: errorKindOf(error.title),
      title: clip(title, limits.maxErrorTitleChars),
      message: clip(cleanErrorMessage(error.message), limits.maxErrorMessageChars),
      path,
      line: wholeAtLeast(error.line, 1),
      column: wholeAtLeast(error.column, 0),
    },
  ];
}

/** The code of each of `paths` in Sandpack's file map (path → `{ code }`), skipping any it lacks. */
export function filesAt(
  files: Readonly<Record<string, { code: string } | undefined>>,
  paths: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of paths) {
    const code = files[path]?.code;
    if (typeof code === 'string') out[path] = code;
  }
  return out;
}
