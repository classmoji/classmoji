import { describe, it, expect } from 'vitest';
import {
  classroomContentRepoName,
  defaultContentRepoName,
  maxContentNamespaceLength,
  sanitizeRepoName,
  suggestContentNamespace,
  GITHUB_REPO_NAME_MAX,
} from '../repoNames.ts';
import { getContentRepoName } from '../content.ts';

// LEGACY pattern. classroomContentRepoName no longer names any live repo —
// Classroom.content_repo is stored and user-editable. These cases pin the
// string the migration backfilled existing rows with.
describe('classroomContentRepoName (legacy backfill pattern)', () => {
  it('builds the per-classroom content repo name', () => {
    expect(classroomContentRepoName({ login: 'dali', namespace: '26w' })).toBe('content-dali-26w');
  });

  it('composes login and namespace verbatim', () => {
    expect(classroomContentRepoName({ login: 'cs101', namespace: 'fall-2026' })).toBe(
      'content-cs101-fall-2026'
    );
  });

  it('is distinct from the legacy org-level helper (content-<login>), which stays untouched', () => {
    // The legacy helper names a DIFFERENT repo (org-level, settings-overridable);
    // classroomContentRepoName must never be unified with it.
    expect(getContentRepoName({ login: 'dali' })).toBe('content-dali');
    expect(
      getContentRepoName({ login: 'dali', settings: { content_repo_name: 'custom-repo' } })
    ).toBe('custom-repo');
    expect(classroomContentRepoName({ login: 'dali', namespace: '26w' })).not.toBe(
      getContentRepoName({ login: 'dali' })
    );
  });
});

describe('suggestContentNamespace', () => {
  it('strips the org login prefix from the slug', () => {
    expect(suggestContentNamespace({ orgLogin: 'dartmouth-cs52', slug: 'dartmouth-cs52-26f' })).toBe(
      '26f'
    );
  });

  it('matches the login case-insensitively (logins can be mixed-case, slugs are lowercase)', () => {
    expect(suggestContentNamespace({ orgLogin: 'LindblomMSA', slug: 'lindblommsa-26f' })).toBe(
      '26f'
    );
  });

  it('returns the full slug when it does not start with the login', () => {
    expect(
      suggestContentNamespace({ orgLogin: 'classmoji-development', slug: 'classmoji-dev-winter-2025' })
    ).toBe('classmoji-dev-winter-2025');
  });

  it('returns the full slug when stripping would leave nothing', () => {
    expect(suggestContentNamespace({ orgLogin: 'dartmouth-cs52', slug: 'dartmouth-cs52' })).toBe(
      'dartmouth-cs52'
    );
  });

  it('does not strip on partial word overlap (prefix must end at a hyphen boundary)', () => {
    expect(suggestContentNamespace({ orgLogin: 'dartmouth-cs5', slug: 'dartmouth-cs52-26f' })).toBe(
      'dartmouth-cs52-26f'
    );
  });
});

describe('sanitizeRepoName', () => {
  it('leaves an already-valid name untouched', () => {
    expect(sanitizeRepoName('content-cs52-26f')).toBe('content-cs52-26f');
  });

  it('keeps the full GitHub-legal character set (dots and underscores included)', () => {
    expect(sanitizeRepoName('my.course_notes-26f')).toBe('my.course_notes-26f');
  });

  it('lowercases', () => {
    expect(sanitizeRepoName('CS52-Fall')).toBe('cs52-fall');
  });

  it('collapses each run of illegal characters to a single dash', () => {
    expect(sanitizeRepoName('cs52   fall  2026')).toBe('cs52-fall-2026');
    expect(sanitizeRepoName('cs52/@#$fall')).toBe('cs52-fall');
  });

  it('trims leading and trailing dashes and dots', () => {
    expect(sanitizeRepoName('--cs52--')).toBe('cs52');
    expect(sanitizeRepoName('..cs52..')).toBe('cs52');
    expect(sanitizeRepoName('  cs52  ')).toBe('cs52');
  });

  it('truncates to GitHub’s cap and never leaves a trailing dash behind', () => {
    expect(sanitizeRepoName('x'.repeat(150))).toHaveLength(GITHUB_REPO_NAME_MAX);
    // Truncation lands mid-separator: the cut must not leave an edge dash.
    const cut = sanitizeRepoName(`${'x'.repeat(GITHUB_REPO_NAME_MAX - 1)} tail`);
    expect(cut).toHaveLength(GITHUB_REPO_NAME_MAX - 1);
    expect(cut.endsWith('-')).toBe(false);
  });

  it('returns empty when nothing usable survives — callers MUST fall back', () => {
    expect(sanitizeRepoName('///')).toBe('');
    expect(sanitizeRepoName('   ')).toBe('');
    expect(sanitizeRepoName('')).toBe('');
  });

  it('is idempotent', () => {
    const once = sanitizeRepoName('CS 52 // Fall!! 2026--');
    expect(sanitizeRepoName(once)).toBe(once);
  });
});

describe('defaultContentRepoName', () => {
  it('prefixes the namespace WITHOUT repeating the org login', () => {
    expect(defaultContentRepoName('26f')).toBe('content-26f');
    expect(defaultContentRepoName('dartmouth-cs52-26f')).toBe('content-dartmouth-cs52-26f');
  });

  it('sanitizes the namespace it is given', () => {
    expect(defaultContentRepoName('Fall 2026')).toBe('content-fall-2026');
  });

  it('stays within the GitHub repo-name cap', () => {
    expect(defaultContentRepoName('x'.repeat(200)).length).toBe(GITHUB_REPO_NAME_MAX);
  });
});

describe('maxContentNamespaceLength', () => {
  it('leaves room for content-{login}- within the GitHub repo-name cap', () => {
    const login = 'dartmouth-cs52';
    const max = maxContentNamespaceLength(login);
    expect(
      classroomContentRepoName({ login, namespace: 'x'.repeat(max) }).length
    ).toBe(GITHUB_REPO_NAME_MAX);
    expect(
      classroomContentRepoName({ login, namespace: 'x'.repeat(max + 1) }).length
    ).toBeGreaterThan(GITHUB_REPO_NAME_MAX);
  });
});
