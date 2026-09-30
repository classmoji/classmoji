/**
 * The quiz's "Paths to exclude" matcher: .gitignore-style patterns over
 * repository paths, dot files included.
 */
import { describe, expect, it } from 'vitest';
import { NO_EXCLUSION, pathExclusion } from '../excludedPaths.ts';

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
});
