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
 * A leading "./" is ignored. The accepted patterns are checked where they are
 * saved (`@classmoji/utils/quiz-excluded-paths`); a pattern that still reaches
 * here blank or starting with "!" or "#" is skipped rather than trusted, since
 * a bare "!" pattern would match nearly every path.
 */
import picomatch from 'picomatch/posix';

/** Whether a repository path is excluded; paths are repo-relative with "/". */
export type PathExclusion = (path: string) => boolean;

/** Nothing is excluded. */
export const NO_EXCLUSION: PathExclusion = () => false;

/** A repository path as the patterns see it: "/" separators, no leading "./" or "/". */
function repoPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '')
    .replace(/\/+$/, '');
}

type Rule = { matches: (path: string) => boolean; directoryOnly: boolean };

function ruleFor(raw: string): Rule | null {
  let pattern = raw.trim().replace(/^(\.\/)+/, '');
  if (!pattern || pattern.startsWith('!') || pattern.startsWith('#')) return null;
  const directoryOnly = pattern.endsWith('/');
  pattern = pattern.replace(/\/+$/, '');
  if (!pattern) return null;
  const glob = pattern.includes('/') ? pattern : `**/${pattern}`;
  return { matches: picomatch(glob, { dot: true }), directoryOnly };
}

/**
 * The predicate for a quiz's patterns. No patterns (or none usable) excludes
 * nothing.
 */
export function pathExclusion(patterns: readonly string[] | null | undefined): PathExclusion {
  const rules = (patterns ?? []).map(ruleFor).filter((rule): rule is Rule => rule !== null);
  if (rules.length === 0) return NO_EXCLUSION;
  return (path: string) => {
    const parts = repoPath(path).split('/').filter(Boolean);
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
