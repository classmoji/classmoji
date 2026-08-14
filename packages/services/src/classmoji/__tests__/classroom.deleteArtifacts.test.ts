import { describe, it, expect } from 'vitest';
import {
  classroomGitHubArtifactPlan,
  exclusiveImportedTemplateNames,
  importedTemplateRepoNames,
  ownedTemplateRepoNames,
} from '../classroom.service.ts';

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
      {
        kind: 'team',
        org: 'dartmouth-cs52',
        name: 'dartmouth-cs52-26f-students',
        label: 'classroom team',
      },
      {
        kind: 'team',
        org: 'dartmouth-cs52',
        name: 'dartmouth-cs52-26f-assistants',
        label: 'classroom team',
      },
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

  it('lists import-created template repos after the assignment repos', () => {
    const plan = classroomGitHubArtifactPlan({
      ...base,
      gitRepoNames: ['hw1-alice'],
      templateRepoNames: ['lab1-template-26w', 'lab2-template-26w'],
    });
    expect(plan.filter(a => a.label === 'template repo')).toEqual([
      {
        kind: 'repo',
        org: 'dartmouth-cs52',
        name: 'lab1-template-26w',
        label: 'template repo',
      },
      {
        kind: 'repo',
        org: 'dartmouth-cs52',
        name: 'lab2-template-26w',
        label: 'template repo',
      },
    ]);
    expect(plan.filter(a => a.kind === 'repo').map(a => a.name)).toEqual([
      'cs52-content',
      'hw1-alice',
      'lab1-template-26w',
      'lab2-template-26w',
    ]);
  });

  it('yields no template artifacts when the classroom never imported any', () => {
    expect(classroomGitHubArtifactPlan(base).filter(a => a.label === 'template repo')).toEqual([]);
  });

  it('lists a repo once: a template name already claimed as content or assignment repo is dropped', () => {
    const plan = classroomGitHubArtifactPlan({
      ...base,
      gitRepoNames: ['hw1-alice'],
      // Case-variant spellings of names already in the plan — GitHub treats
      // these as the same repo, so a second DELETE would be pointless.
      templateRepoNames: ['CS52-Content', 'HW1-Alice', 'lab1-template-26w'],
    });
    expect(plan.filter(a => a.kind === 'repo').map(a => a.name)).toEqual([
      'cs52-content',
      'hw1-alice',
      'lab1-template-26w',
    ]);
  });
});

describe('importedTemplateRepoNames', () => {
  it('reads the created duplicate names out of id_maps.templates', () => {
    expect(
      importedTemplateRepoNames({
        id_maps: { templates: { 'old-org/lab1': 'lab1-26w', 'old-org/lab2': 'lab2-26w' } },
      })
    ).toEqual(['lab1-26w', 'lab2-26w']);
  });

  it('also accepts the flat template_map alias and de-duplicates across both', () => {
    expect(
      importedTemplateRepoNames({
        id_maps: { templates: { 'old-org/lab1': 'lab1-26w' } },
        template_map: { 'old-org/lab1': 'LAB1-26W', 'old-org/lab2': 'lab2-26w' },
      })
    ).toEqual(['lab1-26w', 'lab2-26w']);
  });

  it('yields nothing for a classroom with no import job, or an import that duplicated none', () => {
    expect(importedTemplateRepoNames(null)).toEqual([]);
    expect(importedTemplateRepoNames(undefined)).toEqual([]);
    expect(importedTemplateRepoNames({})).toEqual([]);
    expect(importedTemplateRepoNames({ id_maps: { templates: {} } })).toEqual([]);
  });

  it('degrades to nothing rather than throwing on a progress column of any other shape', () => {
    // A row written before this feature (or by a future shape) must never make
    // the danger-zone loader 500 — the delete path has to stay reachable.
    expect(importedTemplateRepoNames('not json')).toEqual([]);
    expect(importedTemplateRepoNames(42)).toEqual([]);
    expect(importedTemplateRepoNames({ id_maps: 'nope' })).toEqual([]);
    expect(importedTemplateRepoNames({ id_maps: { templates: { a: 5, b: '', c: '  ' } } })).toEqual(
      []
    );
  });
});

describe('ownedTemplateRepoNames', () => {
  it('keeps owner-qualified refs owned by the org, and bare refs (which resolve to it)', () => {
    expect(ownedTemplateRepoNames(['cs52-org/lab1', 'lab2'], 'cs52-org')).toEqual(['lab1', 'lab2']);
  });

  it('drops refs owned by a different account — cleanup never reaches outside the org', () => {
    expect(ownedTemplateRepoNames(['other-org/lab1', 'someuser/lab2'], 'cs52-org')).toEqual([]);
  });

  it('matches the owner case-insensitively and de-duplicates names the same way', () => {
    expect(ownedTemplateRepoNames(['CS52-Org/Lab1', 'cs52-org/lab1'], 'cs52-org')).toEqual([
      'Lab1',
    ]);
  });

  it('skips empty, null and over-segmented refs', () => {
    expect(ownedTemplateRepoNames([null, undefined, '', '   ', 'a/b/c'], 'cs52-org')).toEqual([]);
  });
});

describe('exclusiveImportedTemplateNames', () => {
  it('keeps duplicates no other classroom points at', () => {
    expect(
      exclusiveImportedTemplateNames({
        createdNames: ['lab1-26w', 'lab2-26w'],
        otherClassroomTemplateRefs: ['cs52-org/something-else'],
        orgLogin: 'cs52-org',
      })
    ).toEqual(['lab1-26w', 'lab2-26w']);
  });

  it('withholds one a DIFFERENT classroom was relinked to, in either ref spelling', () => {
    expect(
      exclusiveImportedTemplateNames({
        createdNames: ['lab1-26w', 'lab2-26w', 'lab3-26w'],
        otherClassroomTemplateRefs: ['cs52-org/LAB1-26W', 'lab2-26w'],
        orgLogin: 'cs52-org',
      })
    ).toEqual(['lab3-26w']);
  });

  it('ignores a same-named repo owned by another org — that is not this duplicate', () => {
    expect(
      exclusiveImportedTemplateNames({
        createdNames: ['lab1-26w'],
        otherClassroomTemplateRefs: ['other-org/lab1-26w'],
        orgLogin: 'cs52-org',
      })
    ).toEqual(['lab1-26w']);
  });
});
