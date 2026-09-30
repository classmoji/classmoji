import { describe, expect, it } from 'vitest';
import {
  excludedPathProblem,
  MAX_EXCLUDED_PATH_CHARS,
  MAX_EXCLUDED_PATHS,
  normalizeExcludedPaths,
  parseExcludedPathsText,
} from '../quizExcludedPaths.ts';

describe('parseExcludedPathsText', () => {
  it('takes one pattern per line, trimmed, blank lines dropped', () => {
    expect(
      parseExcludedPathsText('  tests/**\n\n**/*.spec.js  \r\n\t\nplaywright.config.*\n')
    ).toEqual(['tests/**', '**/*.spec.js', 'playwright.config.*']);
  });

  it('is empty for no text', () => {
    expect(parseExcludedPathsText('')).toEqual([]);
    expect(parseExcludedPathsText('   \n  ')).toEqual([]);
    expect(parseExcludedPathsText(undefined)).toEqual([]);
    expect(parseExcludedPathsText(null)).toEqual([]);
  });
});

describe('excludedPathProblem', () => {
  it.each([
    'tests/**',
    '**/*.spec.js',
    'playwright.config.*',
    'tests/',
    'tests',
    '.github/**',
    './tests/**',
    'src/{a,b}/*.js',
    'a..b.js',
  ])('accepts %s', pattern => {
    expect(excludedPathProblem(pattern)).toBeNull();
  });

  it('refuses an empty pattern', () => {
    expect(excludedPathProblem('')).toBe('A path to exclude cannot be empty.');
    expect(excludedPathProblem('   ')).toBe('A path to exclude cannot be empty.');
  });

  it('refuses an absolute path', () => {
    for (const p of ['/tests/**', '/etc/passwd', '~/secrets', 'C:\\repo', 'c:/repo']) {
      expect(excludedPathProblem(p)).toMatch(/is an absolute path/);
    }
  });

  it('refuses ".." as a path segment', () => {
    expect(excludedPathProblem('../other/**')).toBe(
      '"../other/**" uses "..". Paths to exclude stay inside the repository.'
    );
    expect(excludedPathProblem('tests/../../x')).toMatch(/uses "\.\."/);
    expect(excludedPathProblem('..')).toMatch(/uses "\.\."/);
  });

  it('refuses a backslash, a negation, a comment and a second line', () => {
    expect(excludedPathProblem('tests\\e2e')).toMatch(/uses a backslash/);
    expect(excludedPathProblem('!tests/**')).toBe(
      '"!tests/**" starts with "!". List only the paths to exclude.'
    );
    expect(excludedPathProblem('# e2e tests')).toMatch(/Comments aren't supported/);
    expect(excludedPathProblem('tests/**\nsrc/**')).toMatch(/must be on one line/);
  });

  it('refuses a pattern over the length cap, quoting it shortened', () => {
    const long = `${'a'.repeat(MAX_EXCLUDED_PATH_CHARS)}/**`;
    expect(excludedPathProblem(long)).toBe(
      `"${'a'.repeat(40)}…" is longer than ${MAX_EXCLUDED_PATH_CHARS} characters.`
    );
    expect(excludedPathProblem('a'.repeat(MAX_EXCLUDED_PATH_CHARS))).toBeNull();
  });
});

describe('normalizeExcludedPaths', () => {
  it('trims each pattern and drops a repeat, keeping the order', () => {
    expect(normalizeExcludedPaths([' tests/** ', '**/*.spec.js', 'tests/**'])).toEqual({
      ok: true,
      value: ['tests/**', '**/*.spec.js'],
    });
    expect(normalizeExcludedPaths([])).toEqual({ ok: true, value: [] });
  });

  it('refuses a list with an empty entry (the form drops blank lines before this)', () => {
    expect(normalizeExcludedPaths(['tests/**', ''])).toEqual({
      ok: false,
      error: 'A path to exclude cannot be empty.',
    });
  });

  it('refuses what is not a list of text', () => {
    expect(normalizeExcludedPaths('tests/**')).toEqual({
      ok: false,
      error: 'Paths to exclude must be a list.',
    });
    expect(normalizeExcludedPaths(null)).toMatchObject({ ok: false });
    expect(normalizeExcludedPaths(['tests/**', 3])).toEqual({
      ok: false,
      error: 'Each path to exclude must be text.',
    });
  });

  it('says the first problem', () => {
    expect(normalizeExcludedPaths(['tests/**', '/abs', '../x'])).toEqual({
      ok: false,
      error:
        '"/abs" is an absolute path. Write it relative to the repository root, like tests/e2e/.',
    });
  });

  it(`takes at most ${MAX_EXCLUDED_PATHS} patterns`, () => {
    const many = Array.from({ length: MAX_EXCLUDED_PATHS }, (_, i) => `dir${i}/**`);
    expect(normalizeExcludedPaths(many)).toMatchObject({ ok: true });
    expect(normalizeExcludedPaths([...many, 'one-more/**'])).toEqual({
      ok: false,
      error: `At most ${MAX_EXCLUDED_PATHS} paths to exclude; this lists ${MAX_EXCLUDED_PATHS + 1}.`,
    });
    // Repeats do not count against the cap.
    expect(normalizeExcludedPaths([...many, many[0]])).toMatchObject({ ok: true });
  });
});
