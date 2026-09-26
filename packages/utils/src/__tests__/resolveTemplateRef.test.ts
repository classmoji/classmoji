import { describe, it, expect } from 'vitest';
import { repoNamespace, resolveTemplateRef } from '../repoNames.ts';

const ORG = 'itmo-kotlin-android-tech-26-27';

describe('resolveTemplateRef', () => {
  it('qualifies a bare name with the classroom org', () => {
    // The ITMO case: the template existed, the owner was simply never typed,
    // and 15 students got github.com/kotlin-quiz-app-task-1/undefined.git.
    expect(resolveTemplateRef('kotlin-quiz-app-task-1', ORG)).toEqual({
      owner: ORG,
      repo: 'kotlin-quiz-app-task-1',
    });
  });

  it('leaves an already qualified reference alone', () => {
    expect(resolveTemplateRef('ichrak-cspp-test/TPX', ORG)).toEqual({
      owner: 'ichrak-cspp-test',
      repo: 'TPX',
    });
  });

  it('trims whitespace and stray slashes', () => {
    expect(resolveTemplateRef('  /starter/  ', ORG)).toEqual({ owner: ORG, repo: 'starter' });
    expect(resolveTemplateRef(' owner/repo ', ORG)).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('returns null when there is nothing usable, rather than a broken half', () => {
    expect(resolveTemplateRef('', ORG)).toBeNull();
    expect(resolveTemplateRef('   ', ORG)).toBeNull();
    expect(resolveTemplateRef(null, ORG)).toBeNull();
    expect(resolveTemplateRef(undefined, ORG)).toBeNull();
  });

  it('returns null for a bare name with no org to qualify it', () => {
    expect(resolveTemplateRef('starter', null)).toBeNull();
    expect(resolveTemplateRef('starter', '')).toBeNull();
  });

  it('keeps a nested Gitlab group as the owner', () => {
    expect(resolveTemplateRef('dept/cs10/starter', ORG)).toEqual({
      owner: 'dept/cs10',
      repo: 'starter',
    });
  });
});

describe('repoNamespace', () => {
  it('uses the classroom subgroup when there is one', () => {
    expect(
      repoNamespace({ git_namespace: 'dept/cs10-fall26', git_organization: { login: 'dept' } })
    ).toBe('dept/cs10-fall26');
  });

  it('falls back to the org for classrooms without one (Github)', () => {
    expect(repoNamespace({ git_namespace: null, git_organization: { login: 'org' } })).toBe('org');
  });
});
