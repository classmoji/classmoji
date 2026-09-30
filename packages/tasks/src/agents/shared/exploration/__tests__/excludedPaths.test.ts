/**
 * The quiz's "Paths to exclude" matcher: .gitignore-style patterns over
 * repository paths, dot files included.
 */
import { describe, expect, it } from 'vitest';
import { excludedPathProblem } from '@classmoji/utils/quiz-excluded-paths';
import { NO_EXCLUSION, normalizeRepoPath, pathExclusion } from '../excludedPaths.ts';

const excludes = (patterns: string[], path: string) => pathExclusion(patterns)(path);

describe('pathExclusion', () => {
  it('excludes nothing without patterns', () => {
    expect(pathExclusion([])).toBe(NO_EXCLUSION);
    expect(pathExclusion(null)).toBe(NO_EXCLUSION);
    expect(pathExclusion(undefined)('tests/a.js')).toBe(false);
  });

  it('tests/** covers everything under the root tests directory, and nothing else', () => {
    expect(excludes(['tests/**'], 'tests/e2e/landing.spec.js')).toBe(true);
    expect(excludes(['tests/**'], 'tests/unit.js')).toBe(true);
    expect(excludes(['tests/**'], 'src/tests/helper.js')).toBe(false);
    expect(excludes(['tests/**'], 'testsuite/a.js')).toBe(false);
    expect(excludes(['tests/**'], 'index.html')).toBe(false);
  });

  it('a directory name, with or without a trailing slash, covers what is under it', () => {
    expect(excludes(['tests'], 'tests/e2e/landing.spec.js')).toBe(true);
    expect(excludes(['tests'], 'src/tests/helper.js')).toBe(true);
    expect(excludes(['tests/'], 'tests/e2e/landing.spec.js')).toBe(true);
    // A trailing slash names a directory: a file called "tests" stays.
    expect(excludes(['tests/'], 'tests')).toBe(false);
    expect(excludes(['tests'], 'tests')).toBe(true);
  });

  it('**/*.spec.js matches at the root and at any depth', () => {
    expect(excludes(['**/*.spec.js'], 'landing.spec.js')).toBe(true);
    expect(excludes(['**/*.spec.js'], 'tests/e2e/landing.spec.js')).toBe(true);
    expect(excludes(['**/*.spec.js'], 'src/landing.js')).toBe(false);
    expect(excludes(['**/*.spec.js'], 'src/landing.spec.jsx')).toBe(false);
  });

  it('a pattern without a slash matches the name at any depth, as in .gitignore', () => {
    expect(excludes(['*.spec.js'], 'src/deep/a.spec.js')).toBe(true);
    expect(excludes(['playwright.config.*'], 'playwright.config.ts')).toBe(true);
    expect(excludes(['playwright.config.*'], 'app/playwright.config.js')).toBe(true);
    expect(excludes(['playwright.config.*'], 'playwright.setup.js')).toBe(false);
  });

  it('a pattern with a slash is relative to the repository root', () => {
    expect(excludes(['src/*.js'], 'src/a.js')).toBe(true);
    expect(excludes(['src/*.js'], 'src/lib/a.js')).toBe(false);
    expect(excludes(['src/*.js'], 'app/src/a.js')).toBe(false);
    expect(excludes(['src/**/*.test.js'], 'src/lib/a.test.js')).toBe(true);
  });

  it('matches dot files and dot directories', () => {
    expect(excludes(['.github/**'], '.github/workflows/ci.yml')).toBe(true);
    expect(excludes(['.gitignore'], '.gitignore')).toBe(true);
    expect(excludes(['*'], '.gitignore')).toBe(true);
    expect(excludes(['.env*'], 'config/.env.local')).toBe(true);
    expect(excludes(['**/*.yml'], '.github/workflows/ci.yml')).toBe(true);
  });

  it('ignores a leading ./ on the pattern or the path', () => {
    expect(excludes(['./tests/**'], 'tests/x.js')).toBe(true);
    expect(excludes(['tests/**'], './tests/x.js')).toBe(true);
    expect(excludes(['tests/**'], '/tests/x.js')).toBe(true);
  });

  it('excludes a path when any one of the patterns matches', () => {
    const excluded = pathExclusion(['tests/**', '**/*.spec.js', 'playwright.config.*']);
    expect(excluded('tests/e2e/landing.spec.js')).toBe(true);
    expect(excluded('src/app.spec.js')).toBe(true);
    expect(excluded('playwright.config.js')).toBe(true);
    expect(excluded('src/app.js')).toBe(false);
    expect(excluded('index.html')).toBe(false);
  });

  it('skips a negated, comment or blank pattern instead of matching nearly everything', () => {
    expect(pathExclusion(['!tests/**', '# tests', '   '])).toBe(NO_EXCLUSION);
    expect(excludes(['!tests/**', 'docs/**'], 'src/app.js')).toBe(false);
    expect(excludes(['!tests/**', 'docs/**'], 'docs/a.md')).toBe(true);
  });

  it('is case-sensitive, as repository paths are', () => {
    expect(excludes(['Tests/**'], 'tests/a.js')).toBe(false);
  });

  it('reads "." parts and repeated slashes in a path as the file they name', () => {
    expect(excludes(['tests/foo.spec.js'], 'tests/./foo.spec.js')).toBe(true);
    expect(excludes(['*.spec.js'], 'src/./a.spec.js')).toBe(true);
    expect(excludes(['src/*.js'], 'src//./a.js')).toBe(true);
    expect(excludes(['src/*.js'], './src/a.js/')).toBe(true);
    // A path that climbs out of its folder is never read, and counts as excluded.
    expect(excludes(['docs/**'], 'src/../tests/a.js')).toBe(true);
  });

  it('matches "(" and ")" as themselves, as in .gitignore', () => {
    expect(excludes(['app/(auth)/**'], 'app/(auth)/login/page.tsx')).toBe(true);
    expect(excludes(['app/(auth)/**'], 'app/auth/login/page.tsx')).toBe(false);
    expect(excludes(['(a+)+b'], 'aaab')).toBe(false);
    expect(excludes(['(a+)+b'], 'src/(a+)+b')).toBe(true);
  });

  it('skips a pattern the shared rules refuse instead of compiling it', () => {
    for (const refused of [
      '@(a*)*(a*)*(a*)*(a*)b',
      '**/*a*a*a*a*a*a*a*a*a*a*a*a*b',
      'src/!(keep)/**',
      '/tests/**',
      'tests\\e2e',
    ]) {
      expect(excludedPathProblem(refused)).not.toBeNull();
      expect(pathExclusion([refused])).toBe(NO_EXCLUSION);
    }
    expect(excludes(['src/!(keep)/**', 'docs/**'], 'docs/a.md')).toBe(true);
  });
});

describe('normalizeRepoPath', () => {
  it.each([
    ['tests/foo.spec.js', 'tests/foo.spec.js'],
    ['./tests/./foo.spec.js', 'tests/foo.spec.js'],
    ['/src//a.js/', 'src/a.js'],
    ['src\\a.js', 'src/a.js'],
    ['.', ''],
  ])('%s → %s', (path, expected) => {
    expect(normalizeRepoPath(path)).toBe(expected);
  });

  it('refuses a ".." part', () => {
    expect(normalizeRepoPath('src/../tests/a.js')).toBeNull();
    expect(normalizeRepoPath('..')).toBeNull();
    expect(normalizeRepoPath('a..b.js')).toBe('a..b.js');
  });
});

describe('pathExclusion: every accepted pattern matches quickly', () => {
  // Patterns at the limits the shared rules allow, with nothing in the path to
  // end the match early (none of these paths contains "b" or "c").
  const worstAccepted = [
    '*a*b',
    '**/*a*b/**',
    '**/*a*/**/b',
    '*a/**/*a*b',
    '**/{*a,a}*b/**',
    '{a,aa,aaa,a*,*a}c',
    '{a,aa,aaa,aaaa,a*}*c',
    '[a]*[a]*b',
    'a?a?*a*b',
    '(a+)+b',
    '(a*)(a*)b',
  ];
  const paths = [
    'a'.repeat(200),
    `x/${'a'.repeat(198)}`,
    `${'aa/'.repeat(66)}aa`,
    `${`${'a'.repeat(9)}/`.repeat(19)}${'a'.repeat(10)}`,
  ];

  it('accepts each of the patterns', () => {
    for (const pattern of worstAccepted) expect(excludedPathProblem(pattern)).toBeNull();
    for (const path of paths) expect(path).toHaveLength(200);
  });

  it.each(worstAccepted)('%s matches a 200-character path in under 50 ms', pattern => {
    const excluded = pathExclusion([pattern]);
    for (const path of paths) {
      excluded(path); // warm up
      let fastest = Infinity;
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        expect(excluded(path)).toBe(false);
        fastest = Math.min(fastest, performance.now() - started);
      }
      expect(fastest).toBeLessThan(50);
    }
  });
});
