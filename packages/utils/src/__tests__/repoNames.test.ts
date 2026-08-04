import { describe, it, expect } from 'vitest';
import { classroomContentRepoName } from '../repoNames.ts';
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
