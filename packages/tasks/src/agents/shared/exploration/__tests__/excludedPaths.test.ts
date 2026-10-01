/**
 * The quiz's "Paths to exclude" matcher: .gitignore-style patterns over
 * repository paths, dot files included.
 */
import { describe, expect, it } from 'vitest';
import picomatch from 'picomatch/posix';
import { excludedPathProblem } from '@classmoji/utils/quiz-excluded-paths';
import {
  MAX_PATH_DEPTH,
  NO_EXCLUSION,
  normalizeRepoPath,
  pathExclusion,
} from '../excludedPaths.ts';

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
    `${'aaa/'.repeat(49)}aaaa`,
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

describe('pathExclusion: the depth cap', () => {
  it(`excludes a path deeper than ${MAX_PATH_DEPTH} parts, and only then`, () => {
    expect(MAX_PATH_DEPTH).toBe(64);
    const excluded = pathExclusion(['docs/**']);
    const deep = (parts: number) => Array.from({ length: parts }, (_, k) => `d${k}`).join('/');
    expect(excluded(deep(MAX_PATH_DEPTH))).toBe(false);
    expect(excluded(deep(MAX_PATH_DEPTH + 1))).toBe(true);
    // "." parts and repeated slashes are not parts.
    expect(excluded(`./${deep(MAX_PATH_DEPTH).replace(/\//g, '//./')}`)).toBe(false);
  });
});

/**
 * The matcher as first written, kept as the reference: every directory above
 * the path and the path itself, each against every rule's whole glob (plus the
 * depth cap, which the reference shares).
 */
function referenceExclusion(patterns: string[]): (path: string) => boolean {
  const rules = patterns
    .filter(raw => excludedPathProblem(raw) === null)
    .map(raw => {
      let pattern = raw.trim().replace(/^(\.\/)+/, '');
      const directoryOnly = pattern.endsWith('/');
      pattern = pattern.replace(/\/+$/, '');
      const glob = pattern.includes('/') ? pattern : `**/${pattern}`;
      return {
        matches: picomatch(
          glob.replace(/[()]/g, ch => `\\${ch}`),
          { dot: true, noextglob: true }
        ),
        directoryOnly,
      };
    });
  return path => {
    const normalized = normalizeRepoPath(path);
    if (normalized === null) return true;
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length > MAX_PATH_DEPTH) return true;
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

describe('pathExclusion: the same answers as matching every directory with the whole glob', () => {
  const patterns = [
    'tests/**',
    'tests',
    'tests/',
    '**/*.spec.js',
    '*.spec.js',
    'playwright.config.*',
    'src/*.js',
    'src/**/*.test.js',
    '.github/**',
    '.env*',
    '*',
    '?',
    '**',
    '**/**',
    'a/**/**',
    'src/**/',
    '**/x/**',
    'x/**/y/**',
    'a*b/**',
    'a/**/b',
    'app/(auth)/**',
    '(a+)+b',
    'src/!x',
    'src/!*',
    'a/{b,c/d}',
    '{a/b,c}',
    '{a/b,c}/**',
    '{a/b,c}/x',
    '**/*.{js,ts}',
    'src/{a,b}*/x',
    'a[/b',
    'a[x]/**',
    '[ab]/c',
    'a**',
    '**x',
    '*a*b',
    '**/*a*b/**',
    '**/*a*/**/b',
    '*a/**/*a*b',
    '**/{*a,a}*b/**',
    '{a,aa,aaa,a*,*a}c',
  ];
  const names = [
    'a',
    'b',
    'c',
    'd',
    'x',
    'y',
    'aa',
    'ab',
    'axb',
    'aab',
    'abc',
    'ac',
    'src',
    'tests',
    'app',
    '(auth)',
    'login',
    'page.tsx',
    '!x',
    '!abc',
    '.env',
    '.env.local',
    '.github',
    'a.spec.js',
    'a.test.js',
    'a.js',
    'a.ts',
    'playwright.config.ts',
    'a[',
    'a[x]',
    'e2e',
    'ax',
    'bx',
  ];
  // A fixed pseudo-random walk, so every run checks the same paths.
  let seed = 7;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const paths = [
    'src/!abc',
    'src/!x',
    'src/x',
    'src/ab/x',
    'a/b',
    'a/c/d',
    'a/b/x',
    'c',
    'b/c',
    'axb',
    'axb/c',
    'x/y',
    'q/x/r/y/s',
    'a/b/x',
    'c/x',
    'a/b/y',
    'app/(auth)/login/page.tsx',
    '(a+)+b',
    'src/(a+)+b',
    'tests',
    'tests/e2e/a.spec.js',
    '.github/workflows/ci.yml',
    'a[/b',
    'a[x]/c',
    ...Array.from({ length: 3_000 }, () =>
      Array.from({ length: 1 + next(6) }, () => names[next(names.length)]).join('/')
    ),
  ];

  it.each(patterns)('%s', pattern => {
    const actual = pathExclusion([pattern]);
    const expected = referenceExclusion([pattern]);
    const differ = paths.filter(path => actual(path) !== expected(path));
    expect(differ).toEqual([]);
  });

  it('all the patterns together', () => {
    const actual = pathExclusion(patterns.slice(0, 20));
    const expected = referenceExclusion(patterns.slice(0, 20));
    expect(paths.filter(path => actual(path) !== expected(path))).toEqual([]);
  });
});

describe('pathExclusion: a large, deep tree', () => {
  it('checks 10,000 paths up to the depth cap against 50 accepted worst-case patterns in under 1 s', () => {
    // The patterns the shared rules allow that cost the most, each made unique,
    // none matching any path below, so every pattern runs on every path.
    const shapes = [
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
    const patterns: string[] = [];
    for (let i = 0; patterns.length < 50; i++) {
      const suffix = 'q'.repeat(1 + Math.floor(i / shapes.length));
      patterns.push(shapes[i % shapes.length].replace(/b|c/, ch => `${ch}${suffix}`));
    }
    for (const pattern of patterns) expect(excludedPathProblem(pattern)).toBeNull();
    // Paths of "a"s only, one to MAX_PATH_DEPTH parts deep, each file distinct.
    const paths = Array.from({ length: 10_000 }, (_, i) => {
      const folders = Array.from({ length: i % MAX_PATH_DEPTH }, (_, k) => 'a'.repeat(3 + (k % 5)));
      return [...folders, `${'a'.repeat(40 + (i % 60))}${i}`].join('/');
    });

    const excluded = pathExclusion(patterns);
    const started = performance.now();
    const matched = paths.filter(path => excluded(path));
    const elapsed = performance.now() - started;
    expect(matched).toEqual([]);
    expect(elapsed).toBeLessThan(1_000);
  });
});
