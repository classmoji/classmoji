import { describe, expect, it } from 'vitest';
import {
  excludedPathProblem,
  MAX_BRACE_CHOICES,
  MAX_EXCLUDED_PATH_CHARS,
  MAX_EXCLUDED_PATHS,
  MAX_GLOBSTARS,
  MAX_STARS_PER_PART,
  MAX_WILDCARDS,
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
    '**/*.{spec,test}.js',
    'a..b.js',
    'app/(auth)/**',
    '**/*.test.*',
    '*-solution*',
    'src/**/test/**/*.js',
    'src/[abc]*.js',
    'file?.txt',
  ])('accepts %s', pattern => {
    expect(excludedPathProblem(pattern)).toBeNull();
  });

  it('accepts the most wildcards the limits allow', () => {
    expect(MAX_WILDCARDS).toBe(4);
    expect(MAX_GLOBSTARS).toBe(2);
    expect(MAX_STARS_PER_PART).toBe(2);
    for (const p of [
      '**/*a*/**/b',
      '*a/**/*a*',
      '**/*a*b/**',
      '{*a,b}*c',
      `{${'a,'.repeat(9)}a}`,
    ]) {
      expect(excludedPathProblem(p)).toBeNull();
    }
  });

  it.each([
    ['@(a*)*(a*)*(a*)*(a*)b', '@('],
    ['src/!(keep)/**', '!('],
    ['src/+(a|b).js', '+('],
    ['tests/*(unit).js', '*('],
    ['file?(1).txt', '?('],
  ])('refuses the extended glob group in %s', (pattern, opener) => {
    expect(excludedPathProblem(pattern)).toBe(
      `"${pattern}" uses "${opener}…)", which isn't supported. Use *, ** and ? instead.`
    );
  });

  it('refuses more than two * between two slashes', () => {
    expect(excludedPathProblem('*a*a*b')).toBe(
      `"*a*a*b" uses more than ${MAX_STARS_PER_PART} * between two slashes. Use a simpler pattern, or split it over several lines.`
    );
    // A star inside a {…} list counts toward its part of the path.
    expect(excludedPathProblem('*{a*,b}*c')).toMatch(/more than 2 \* between two slashes/);
    // A "**" that is not a whole part of the path is a star in its part.
    expect(excludedPathProblem('a**b*c*d')).toMatch(/more than 2 \* between two slashes/);
    expect(excludedPathProblem('**/*a*a*a*a*a*a*a*a*a*a*a*a*b')).toMatch(
      /more than 2 \* between two slashes/
    );
  });

  it('refuses more than two **', () => {
    expect(excludedPathProblem('**/a/**/b/**')).toBe(
      `"**/a/**/b/**" uses ** more than ${MAX_GLOBSTARS} times. Use a simpler pattern, or split it over several lines.`
    );
  });

  it('refuses more than four wildcards in all', () => {
    expect(excludedPathProblem('*a*/*b*/*c')).toBe(
      `"*a*/*b*/*c" uses more than ${MAX_WILDCARDS} wildcards (* or **). Use a simpler pattern, or split it over several lines.`
    );
    expect(excludedPathProblem('**/*a*/**/*b')).toMatch(/more than 4 wildcards/);
  });

  it('refuses three or more * in a row', () => {
    expect(excludedPathProblem('***/x.js')).toBe(
      '"***/x.js" has "***". Use * for part of a name, or ** for any number of folders.'
    );
    expect(excludedPathProblem('src/a****')).toMatch(/has "\*\*\*\*"/);
  });

  it('refuses a {…} list that is nested, repeated, unmatched, a range or too long', () => {
    expect(excludedPathProblem('{a,{b,c}}/x')).toBe(
      '"{a,{b,c}}/x" puts one {…} list inside another. Use a simpler pattern, or split it over several lines.'
    );
    expect(excludedPathProblem('{a,b}/{c,d}')).toBe(
      '"{a,b}/{c,d}" uses more than one {…} list. Use a simpler pattern, or split it over several lines.'
    );
    expect(excludedPathProblem('src/{a,b')).toBe('"src/{a,b" has a "{" with no "}" after it.');
    expect(excludedPathProblem('src/a}b')).toBe('"src/a}b" has a "}" with no "{" before it.');
    expect(excludedPathProblem('test{1..1000}.js')).toBe(
      '"test{1..1000}.js" uses ".." inside {…}. List each choice instead, like {a,b}.'
    );
    expect(excludedPathProblem(`{${'a,'.repeat(MAX_BRACE_CHOICES)}a}`)).toMatch(
      new RegExp(`lists more than ${MAX_BRACE_CHOICES} choices in \\{…\\}`)
    );
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
