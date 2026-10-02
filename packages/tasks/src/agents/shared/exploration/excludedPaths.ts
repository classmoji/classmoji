/**
 * A code-aware quiz's "Paths to exclude" (`quizzes.excluded_paths`), as a
 * predicate over repository paths.
 *
 * Patterns read like .gitignore lines, matched with picomatch (dot files
 * included):
 *   - A pattern with no "/" (other than a trailing one) matches at any depth:
 *     `*.spec.js` is `src/a.spec.js` too, and `playwright.config.*` is found
 *     wherever it sits.
 *   - A pattern with a "/" is relative to the repository root: `tests/**`.
 *   - A trailing "/" matches directories only: `tests/`.
 *   - A path is excluded when it, or any directory above it, matches: `tests`,
 *     `tests/` and `tests/**` all exclude `tests/e2e/landing.spec.js`.
 *   - A path deeper than `MAX_PATH_DEPTH` parts is excluded.
 *   - "(" and ")" match themselves, as in .gitignore; extended glob groups
 *     are off (`noextglob`).
 * A leading "./" is ignored. Only a pattern the shared rules accept
 * (`excludedPathProblem` in `@classmoji/utils/quiz-excluded-paths`, which the
 * quiz form, the MCP tools and the quiz service apply when a list is saved)
 * is compiled. Any other that still reaches here (blank, "!" or "#", syntax
 * those rules refuse, too many wildcards) is skipped rather than trusted: a
 * bare "!" pattern would match nearly every path, and those rules keep every
 * accepted pattern quick to match against any path.
 *
 * Paths are compared in one canonical form (`normalizeRepoPath`), the same
 * one a code quote and a file read use, so "tests/./a.spec.js" is
 * "tests/a.spec.js" here too.
 */
import picomatch from 'picomatch/posix';
import { excludedPathProblem } from '@classmoji/utils/quiz-excluded-paths';

/** Whether a repository path is excluded; paths are repo-relative with "/". */
export type PathExclusion = (path: string) => boolean;

/** Nothing is excluded. */
export const NO_EXCLUSION: PathExclusion = () => false;

/**
 * A repository path in one canonical form: "/" separators, no empty or "."
 * parts (so no leading "./" or "/", no repeated or trailing "/"). Null when a
 * part is "..", which would leave the folder it is in. Code quotes, file reads
 * and the exclusion all use this form, so what is checked is what is read.
 */
export function normalizeRepoPath(path: string): string | null {
  const parts = path
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part !== '' && part !== '.');
  if (parts.includes('..')) return null;
  return parts.join('/');
}

/**
 * One pattern, compiled. `matches(path, name)` takes a canonical path and its
 * last part; it answers for the path itself, and relies on `pathExclusion`
 * to have asked about each directory above it first (see `ruleFor`).
 */
type Rule = { matches: (path: string, name: string) => boolean; directoryOnly: boolean };

const GLOB_OPTIONS = { dot: true, noextglob: true } as const;

/** Parentheses as picomatch reads them literally: they would otherwise form a regex group. */
const literalParentheses = (glob: string): string => glob.replace(/[()]/g, ch => `\\${ch}`);

const compile = (glob: string) => picomatch(literalParentheses(glob), GLOB_OPTIONS);

/** The index of the glob's last "/" outside a {…} list or a […] class; -1 when there is none. */
function lastTopLevelSlash(glob: string): number {
  let braces = 0;
  let brackets = 0;
  let at = -1;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '{') braces += 1;
    else if (ch === '}') braces = Math.max(0, braces - 1);
    else if (ch === '[') brackets += 1;
    else if (ch === ']') brackets = Math.max(0, brackets - 1);
    else if (ch === '/' && braces === 0 && brackets === 0) at = i;
  }
  return at;
}

/**
 * A pattern as a rule. The glob it stands for (`**\/<pattern>` without a "/",
 * the pattern itself with one) is matched in an equivalent form that costs
 * little on any path, however deep:
 * - With no "/", the glob matches exactly the paths whose last part matches
 *   the pattern, so only that part is matched.
 * - A glob ending in "/**" matches a path when the path, or a directory above
 *   it, matches the glob without that ending; the directories above are
 *   asked first, so the path itself is matched against the shorter glob.
 * - A path matches only if its last part matches the glob's last part, which
 *   is checked first; the whole glob runs only on a path that passes.
 */
function ruleFor(raw: string): Rule | null {
  if (typeof raw !== 'string' || excludedPathProblem(raw) !== null) return null;
  let pattern = raw.trim().replace(/^(\.\/)+/, '');
  const directoryOnly = pattern.endsWith('/');
  pattern = pattern.replace(/\/+$/, '');
  if (!pattern) return null;
  if (!pattern.includes('/')) {
    const name = compile(pattern);
    return { matches: (_path, last) => name(last), directoryOnly };
  }
  let glob = pattern;
  while (glob.endsWith('/**') && lastTopLevelSlash(glob) === glob.length - 3) {
    glob = glob.slice(0, -3);
  }
  const whole = compile(glob);
  const at = lastTopLevelSlash(glob);
  const lastPart = at === -1 ? null : glob.slice(at + 1);
  // A leading "!" would read as a negation on its own; such a last part is not split off.
  if (
    lastPart === null ||
    lastPart === '**' ||
    lastPart.includes('/') ||
    lastPart.startsWith('!')
  ) {
    return { matches: path => whole(path), directoryOnly };
  }
  const name = compile(lastPart);
  return { matches: (path, last) => name(last) && whole(path), directoryOnly };
}

/**
 * The deepest path matched, in parts. A deeper path is treated as excluded
 * (never listed, picked or read), so no path costs more than this many
 * directory checks.
 */
export const MAX_PATH_DEPTH = 64;

/**
 * The predicate for a quiz's patterns. No patterns (or none usable) excludes
 * nothing.
 *
 * Each directory is decided once per predicate and remembered: it is
 * excluded when the directory above it is, or when a rule matches it. A path
 * then costs one lookup for its folder and one match per rule for itself,
 * however many other paths share that folder.
 */
export function pathExclusion(patterns: readonly string[] | null | undefined): PathExclusion {
  const rules = (patterns ?? []).map(ruleFor).filter((rule): rule is Rule => rule !== null);
  if (rules.length === 0) return NO_EXCLUSION;
  const directories = new Map<string, boolean>();
  const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  const directoryExcluded = (directory: string): boolean => {
    const known = directories.get(directory);
    if (known !== undefined) return known;
    const slash = directory.lastIndexOf('/');
    const name = nameOf(directory);
    const excluded =
      (slash > 0 && directoryExcluded(directory.slice(0, slash))) ||
      rules.some(rule => rule.matches(directory, name));
    directories.set(directory, excluded);
    return excluded;
  };
  return (path: string) => {
    const normalized = normalizeRepoPath(path);
    // A path that climbs out of its folder is never read; treat it as excluded.
    if (normalized === null) return true;
    if (normalized === '') return false;
    if (normalized.split('/').length > MAX_PATH_DEPTH) return true;
    const slash = normalized.lastIndexOf('/');
    if (slash > 0 && directoryExcluded(normalized.slice(0, slash))) return true;
    const name = nameOf(normalized);
    return rules.some(rule => !rule.directoryOnly && rule.matches(normalized, name));
  };
}
