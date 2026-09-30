/**
 * quizExcludedPaths.ts — which "Paths to exclude" a code-aware quiz accepts.
 *
 * A pattern is a glob relative to the root of the student's repository, read
 * like a .gitignore line (`tests/`, a spec-file pattern, `playwright.config.*`).
 * The quiz agent never lists, reads or quotes a matching file; the matching
 * runs in the agent (packages/tasks, agents/shared/exploration/excludedPaths.ts).
 * This module only says which patterns may be saved, and is shared by the
 * quiz form (in the browser and in its action), the MCP quiz tools and the quiz
 * service. It has no imports, so the form's client bundle pulls in nothing else.
 */

/** The most patterns one quiz may list. */
export const MAX_EXCLUDED_PATHS = 50;

/** The longest one pattern may be, in characters. */
export const MAX_EXCLUDED_PATH_CHARS = 200;

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
