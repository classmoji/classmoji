import { describe, it, expect } from 'vitest';
import { classroomGitHubArtifactPlan } from '../classroom.service.ts';

const base = {
  orgLogin: 'dartmouth-cs52',
  slug: 'dartmouth-cs52-26f',
  contentRepo: 'cs52-content',
  gitRepoNames: [] as string[],
  teamSlugs: [] as string[],
};

describe('classroomGitHubArtifactPlan', () => {
  it('names the content repo from the STORED name (never re-derived) and the two conventional teams', () => {
    const plan = classroomGitHubArtifactPlan(base);
    expect(plan).toEqual([
      {
        kind: 'repo',
        org: 'dartmouth-cs52',
        name: 'cs52-content',
        label: 'content repo',
      },
      { kind: 'team', org: 'dartmouth-cs52', name: 'dartmouth-cs52-26f-students', label: 'classroom team' },
      { kind: 'team', org: 'dartmouth-cs52', name: 'dartmouth-cs52-26f-assistants', label: 'classroom team' },
    ]);
  });

  it('uses the stored name verbatim even when it looks nothing like the legacy pattern', () => {
    const plan = classroomGitHubArtifactPlan({ ...base, contentRepo: 'My.Course_Notes-26F' });
    expect(plan.filter(a => a.label === 'content repo').map(a => a.name)).toEqual([
      'My.Course_Notes-26F',
    ]);
  });

  it('omits the content repo when the stored name is null', () => {
    const plan = classroomGitHubArtifactPlan({ ...base, contentRepo: null });
    expect(plan.filter(a => a.label === 'content repo')).toHaveLength(0);
    expect(plan.filter(a => a.kind === 'team')).toHaveLength(2);
  });

  it('includes assignment repos and project teams by their exact recorded names, de-duplicated', () => {
    const plan = classroomGitHubArtifactPlan({
      ...base,
      gitRepoNames: ['hw1-alice', 'hw1-alice', 'hw1-bob'],
      teamSlugs: ['team-rocket', 'team-rocket'],
    });
    expect(plan.filter(a => a.label === 'assignment repo').map(a => a.name)).toEqual([
      'hw1-alice',
      'hw1-bob',
    ]);
    expect(plan.filter(a => a.label === 'project team').map(a => a.name)).toEqual(['team-rocket']);
  });

  it('never invents artifacts: empty inputs yield only the stored content repo + conventional teams', () => {
    const plan = classroomGitHubArtifactPlan(base);
    expect(plan).toHaveLength(3);
  });
});
