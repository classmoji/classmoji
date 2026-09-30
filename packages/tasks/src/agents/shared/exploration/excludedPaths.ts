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

type Rule = { matches: (path: string) => boolean; directoryOnly: boolean };

/** Parentheses as picomatch reads them literally: they would otherwise form a regex group. */
const literalParentheses = (glob: string): string => glob.replace(/[()]/g, ch => `\\${ch}`);

function ruleFor(raw: string): Rule | null {
  if (typeof raw !== 'string' || excludedPathProblem(raw) !== null) return null;
  let pattern = raw.trim().replace(/^(\.\/)+/, '');
  const directoryOnly = pattern.endsWith('/');
  pattern = pattern.replace(/\/+$/, '');
  if (!pattern) return null;
  const glob = pattern.includes('/') ? pattern : `**/${pattern}`;
  return {
    matches: picomatch(literalParentheses(glob), { dot: true, noextglob: true }),
    directoryOnly,
  };
}

/**
 * The predicate for a quiz's patterns. No patterns (or none usable) excludes
 * nothing.
 */
export function pathExclusion(patterns: readonly string[] | null | undefined): PathExclusion {
  const rules = (patterns ?? []).map(ruleFor).filter((rule): rule is Rule => rule !== null);
  if (rules.length === 0) return NO_EXCLUSION;
  return (path: string) => {
    const normalized = normalizeRepoPath(path);
    // A path that climbs out of its folder is never read; treat it as excluded.
    if (normalized === null) return true;
    const parts = normalized.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const isDirectory = i < parts.length;
      for (const rule of rules) {
        if (rule.directoryOnly && !isDirectory) continue;
        if (rule.matches(prefix)) return true;
      }
    }
    return false;
  };
}
