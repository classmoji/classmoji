import { describe, it, expect } from 'vitest';
import {
  classroomContentRepoName,
  maxContentNamespaceLength,
  suggestContentNamespace,
  GITHUB_REPO_NAME_MAX,
} from '../repoNames.ts';
import { getContentRepoName } from '../content.ts';

describe('classroomContentRepoName', () => {
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
