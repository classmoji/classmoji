import { describe, it, expect } from 'vitest';
import { resolveTemplateRef } from '../repoNames.ts';

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
});
