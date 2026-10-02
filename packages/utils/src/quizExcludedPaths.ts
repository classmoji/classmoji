/**
 * quizExcludedPaths.ts — which "Paths to exclude" a code-aware quiz accepts.
 *
 * A pattern is a glob relative to the root of the student's repository, read
 * like a .gitignore line (`tests/`, a spec-file pattern, `playwright.config.*`).
 * The quiz agent never lists, reads or quotes a matching file; the matching
 * runs in the agent (packages/tasks, agents/shared/exploration/excludedPaths.ts),
 * which compiles only the patterns this module accepts. This module says which
 * patterns may be saved, and is shared by the quiz form (in the browser and in
 * its action), the MCP quiz tools, the quiz service and that matcher. It has no
 * imports, so the form's client bundle pulls in nothing else.
 *
 * The syntax is kept small, so that every accepted pattern matches quickly
 * against any path: `*`, `**`, `?`, `[...]` and one `{a,b}` list. Extended
 * glob groups (`@(...)`, `!(...)`, `+(...)`, `*(...)`, `?(...)`) are refused,
 * and so are patterns with many wildcards (`MAX_WILDCARDS`, `MAX_GLOBSTARS`,
 * `MAX_STARS_PER_PART`). Parentheses otherwise match themselves, as in
 * .gitignore.
 */

/** The most patterns one quiz may list. */
export const MAX_EXCLUDED_PATHS = 50;

/** The longest one pattern may be, in characters. */
export const MAX_EXCLUDED_PATH_CHARS = 200;

/** The most wildcards (`*` and `**` alike) one pattern may use. */
export const MAX_WILDCARDS = 4;

/** The most `**` (any number of folders) one pattern may use. */
export const MAX_GLOBSTARS = 2;

/** The most `*` one part of a path (between two "/") may use. */
export const MAX_STARS_PER_PART = 2;

/** The most choices one `{a,b}` list may give. */
export const MAX_BRACE_CHOICES = 10;

/** Extended glob groups, which the matcher does not support. */
const EXTGLOB_OPENERS = ['@(', '!(', '+(', '*(', '?('] as const;

/** A pattern as an error message quotes it: shortened when long. */
function quoted(pattern: string): string {
  return `"${pattern.length > 40 ? `${pattern.slice(0, 40)}…` : pattern}"`;
}

/**
 * Why one pattern cannot be saved, as the form and the tools say it; null
 * when it can. The pattern is judged as given (trimmed first).
 */
export function excludedPathProblem(pattern: string): string | null {
  const p = pattern.trim();
  if (!p) return 'A path to exclude cannot be empty.';
  if (p.length > MAX_EXCLUDED_PATH_CHARS) {
    return `${quoted(p)} is longer than ${MAX_EXCLUDED_PATH_CHARS} characters.`;
  }
  if (/[\r\n]/.test(p)) return `${quoted(p)} must be on one line.`;
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) {
    return `${quoted(p)} is an absolute path. Write it relative to the repository root, like tests/e2e/.`;
  }
  if (p.includes('\\')) {
    return `${quoted(p)} uses a backslash. Use forward slashes, like tests/e2e/.`;
  }
  if (p.split('/').includes('..')) {
    return `${quoted(p)} uses "..". Paths to exclude stay inside the repository.`;
  }
  if (p.startsWith('!')) {
    return `${quoted(p)} starts with "!". List only the paths to exclude.`;
  }
  if (p.startsWith('#')) {
    return `${quoted(p)} starts with "#". Comments aren't supported; remove the line.`;
  }
  const opener = EXTGLOB_OPENERS.find(o => p.includes(o));
  if (opener) {
    return `${quoted(p)} uses "${opener}…)", which isn't supported. Use *, ** and ? instead.`;
  }
  return braceProblem(p) ?? wildcardProblem(p);
}

const SIMPLER = 'Use a simpler pattern, or split it over several lines.';

/** Why a pattern's `{a,b}` list cannot be saved; null when it can (or has none). */
function braceProblem(p: string): string | null {
  let depth = 0;
  let lists = 0;
  let choices = 0;
  let body = '';
  for (const ch of p) {
    if (ch === '{') {
      depth += 1;
      if (depth > 1) return `${quoted(p)} puts one {…} list inside another. ${SIMPLER}`;
      lists += 1;
      if (lists > 1) return `${quoted(p)} uses more than one {…} list. ${SIMPLER}`;
      choices = 1;
      body = '';
    } else if (ch === '}') {
      depth -= 1;
      if (depth < 0) return `${quoted(p)} has a "}" with no "{" before it.`;
      if (body.includes('..')) {
        return `${quoted(p)} uses ".." inside {…}. List each choice instead, like {a,b}.`;
      }
    } else if (depth === 1) {
      body += ch;
      if (ch === ',') {
        choices += 1;
        if (choices > MAX_BRACE_CHOICES) {
          return `${quoted(p)} lists more than ${MAX_BRACE_CHOICES} choices in {…}. ${SIMPLER}`;
        }
      }
    }
  }
  if (depth !== 0) return `${quoted(p)} has a "{" with no "}" after it.`;
  return null;
}

/**
 * Why a pattern uses too many wildcards; null when it does not. A run of
 * `**` that is a whole part of the path is one globstar; any other run of `*`
 * is one star in its part, and a run of three or more is refused.
 */
function wildcardProblem(p: string): string | null {
  let wildcards = 0;
  let globstars = 0;
  for (const part of p.split('/')) {
    let stars = 0;
    for (const run of part.match(/\*+/g) ?? []) {
      if (run.length > 2) {
        return `${quoted(p)} has "${run}". Use * for part of a name, or ** for any number of folders.`;
      }
      wildcards += 1;
      if (run.length === 2 && part === '**') globstars += 1;
      else stars += 1;
    }
    if (stars > MAX_STARS_PER_PART) {
      return `${quoted(p)} uses more than ${MAX_STARS_PER_PART} * between two slashes. ${SIMPLER}`;
    }
  }
  if (globstars > MAX_GLOBSTARS) {
    return `${quoted(p)} uses ** more than ${MAX_GLOBSTARS} times. ${SIMPLER}`;
  }
  if (wildcards > MAX_WILDCARDS) {
    return `${quoted(p)} uses more than ${MAX_WILDCARDS} wildcards (* or **). ${SIMPLER}`;
  }
  return null;
}

/** The textarea's text as patterns: one per line, trimmed, blank lines dropped. */
export function parseExcludedPathsText(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '');
}

export type ExcludedPathsResult = { ok: true; value: string[] } | { ok: false; error: string };

/**
 * A list of patterns checked and tidied for saving: each trimmed, a repeat
 * dropped, at most `MAX_EXCLUDED_PATHS`. The first problem found is the error.
 */
export function normalizeExcludedPaths(input: unknown): ExcludedPathsResult {
  if (!Array.isArray(input)) return { ok: false, error: 'Paths to exclude must be a list.' };
  const value: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') {
      return { ok: false, error: 'Each path to exclude must be text.' };
    }
    const problem = excludedPathProblem(item);
    if (problem) return { ok: false, error: problem };
    const pattern = item.trim();
    if (!value.includes(pattern)) value.push(pattern);
  }
  if (value.length > MAX_EXCLUDED_PATHS) {
    return {
      ok: false,
      error: `At most ${MAX_EXCLUDED_PATHS} paths to exclude; this lists ${value.length}.`,
    };
  }
  return { ok: true, value };
}
