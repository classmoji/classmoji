/**
 * The coursework structure the web changes is recorded by the services that
 * change it. Each intent below hands its service the actor built from its own
 * gate (the gate's user and role, the admin viewing as them read from this
 * request, and the intent's tool name), writes no audit row of its own, and
 * answers as before: the team pages' delete, member, tag and rename intents,
 * the inline tag pickers of the assignment and repository forms, a student's
 * own team page (create, join, leave, and the repository's tag it makes) and
 * the contributor link. (The Modules page is in admin.$class.modules'
 * quizVisibility.test.ts; the repository form and pages in repoFormScope,
 * repoDetailActionScope and repoUpdateScope.)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomAccess: vi.fn(),
  requestImpersonator: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  auditRecord: vi.fn(),
  deleteTeam: vi.fn(),
  removeTeamMember: vi.fn(),
  addTeamTags: vi.fn(),
  renameTeam: vi.fn(),
  tagFindOrCreate: vi.fn(),
  tagsByClassroom: vi.fn(),
  repositoryBySlugs: vi.fn(),
  repositoryByTitle: vi.fn(),
  repositoryCreate: vi.fn(),
  assignmentCreate: vi.fn(),
  classroomFindById: vi.fn(),
  teamBySlug: vi.fn(),
  userTeamByTag: vi.fn(),
  teamFindById: vi.fn(),
  createWithMembershipAndTag: vi.fn(),
  addMemberToTeam: vi.fn(),
  removeMemberFromTeam: vi.fn(),
  userFindUnique: vi.fn(),
  gitRepoFindUnique: vi.fn(),
  linkContributor: vi.fn(),
  provider: {
    createTeam: vi.fn(),
    addTeamMember: vi.fn(),
    removeTeamMember: vi.fn(),
  },
  tasksTrigger: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));
vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));
vi.mock('@classmoji/auth/request-impersonator', () => ({
  requestImpersonator: (...a: unknown[]) => mocks.requestImpersonator(...a),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    audit: { record: (...a: unknown[]) => mocks.auditRecord(...a) },
    teamAdmin: {
      deleteTeam: (...a: unknown[]) => mocks.deleteTeam(...a),
      removeTeamMember: (...a: unknown[]) => mocks.removeTeamMember(...a),
      addTeamTags: (...a: unknown[]) => mocks.addTeamTags(...a),
      renameTeam: (...a: unknown[]) => mocks.renameTeam(...a),
    },
    organizationTag: {
      findOrCreate: (...a: unknown[]) => mocks.tagFindOrCreate(...a),
      findByClassroomId: (...a: unknown[]) => mocks.tagsByClassroom(...a),
    },
    repository: {
      findByClassroomSlugAndModuleSlug: (...a: unknown[]) => mocks.repositoryBySlugs(...a),
      findByClassroomAndTitle: (...a: unknown[]) => mocks.repositoryByTitle(...a),
      create: (...a: unknown[]) => mocks.repositoryCreate(...a),
    },
    assignment: { createInClassroom: (...a: unknown[]) => mocks.assignmentCreate(...a) },
    classroom: { findById: (...a: unknown[]) => mocks.classroomFindById(...a) },
    team: {
      findBySlugAndClassroomId: (...a: unknown[]) => mocks.teamBySlug(...a),
      findUserTeamByTag: (...a: unknown[]) => mocks.userTeamByTag(...a),
      findById: (...a: unknown[]) => mocks.teamFindById(...a),
      createWithMembershipAndTag: (...a: unknown[]) => mocks.createWithMembershipAndTag(...a),
    },
    teamMembership: {
      addMemberToTeam: (...a: unknown[]) => mocks.addMemberToTeam(...a),
      removeMemberFromTeam: (...a: unknown[]) => mocks.removeMemberFromTeam(...a),
    },
    repoAnalytics: { linkContributor: (...a: unknown[]) => mocks.linkContributor(...a) },
  },
  getGitProvider: () => mocks.provider,
  isReservedSlug: (slug: string) => slug.endsWith('-students'),
  TeamServiceError: class TeamServiceError extends Error {},
  describeTeamFailureReason: (reason: string) => reason,
}));
vi.mock('@classmoji/database', () => ({
  default: () => ({
    user: { findUnique: (...a: unknown[]) => mocks.userFindUnique(...a) },
    gitRepo: { findUnique: (...a: unknown[]) => mocks.gitRepoFindUnique(...a) },
  }),
  GIT_IDENTITY: { accounts: true },
}));
vi.mock('@trigger.dev/sdk/v3', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.tasksTrigger(...a) },
}));
vi.mock('@trigger.dev/sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@trigger.dev/sdk')>()),
  auth: { createPublicToken: async () => 'public-token' },
  tasks: { trigger: (...a: unknown[]) => mocks.tasksTrigger(...a) },
}));
vi.mock('nanoid', () => ({ nanoid: () => 'session-1' }));
// The pages' views only need to import.
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({}), useDisclosure: () => ({}) }));
vi.mock('~/hooks/useGitWeb', () => ({ useGitWeb: () => ({ terms: {} }) }));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({}) }));
vi.mock('~/utils/classroomStatusModals', () => ({ useClassroomStatusModals: () => ({}) }));

const teams = await import('../admin.$class.teams/route.tsx');
const editTeam = await import('../admin.$class.teams.$slug.edit/action.ts');
const assignments = await import('../admin.$class.assignments/route.tsx');
const repoForm = await import('../admin.$class.repos_.form/route.tsx');
const studentTeam = await import('../student.$class.repos_.$repo.team/route.tsx');
const contributorLink = await import('../api.repos.$id.contributor-link/route.ts');

const CLASSROOM = {
  id: 'class-1',
  slug: 'cs1',
  status: 'ACTIVE',
  git_organization: { login: 'acme', provider: 'GITHUB' },
};
const AUDIT = { written: 1, missed: 0 };

/** What the gate resolved: this user, as this role. */
let gateUser = { userId: 'owner-1', role: 'OWNER' };
const gateResult = () => ({
  userId: gateUser.userId,
  classroom: CLASSROOM,
  membership: { role: gateUser.role },
});
const actorFor = (tool: string, admin: string | null = null) => ({
  userId: gateUser.userId,
  role: gateUser.role,
  tool,
  impersonatedBy: admin,
});

type Action = (args: never) => Promise<unknown>;
const postJson = (action: Action, path: string, params: Record<string, string>, body: unknown) =>
  action({
    params,
    request: new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never) as Promise<Record<string, unknown>>;
const postForm = (action: Action, path: string, params: Record<string, string>, body: object) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) form.append(key, String(value));
  return action({
    params,
    request: new Request(`http://localhost${path}`, { method: 'POST', body: form }),
  } as never) as Promise<Record<string, unknown>>;
};

beforeEach(() => {
  vi.clearAllMocks();
  gateUser = { userId: 'owner-1', role: 'OWNER' };
  mocks.requireClassroomAdmin.mockImplementation(async () => gateResult());
  mocks.assertClassroomAccess.mockImplementation(async () => gateResult());
  mocks.requestImpersonator.mockResolvedValue(null);
  mocks.tagFindOrCreate.mockResolvedValue({
    tag: { id: 'tag-1', name: 'Projects' },
    created: true,
    audit: AUDIT,
  });
});

describe('team pages', () => {
  const EDIT = { class: 'cs1', slug: 'red' };
  const edit = (intent: string, body: unknown) =>
    postJson(editTeam.action as Action, `/admin/cs1/teams/red/edit?/${intent}`, EDIT, body);

  it('delete: the team service records it, for the gate’s owner', async () => {
    mocks.deleteTeam.mockResolvedValue({ id: 't-1', audit: AUDIT });
    const result = await postJson(
      teams.action as Action,
      '/admin/cs1/teams',
      { class: 'cs1' },
      {
        team: { slug: 'red' },
        deleteOnGitHub: false,
      }
    );
    expect(result).toEqual({ success: 'Team deleted successfully', action: 'delete-team' });
    expect(mocks.deleteTeam).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      slugOrId: 'red',
      deleteOnProvider: false,
      actor: actorFor('web:teams.delete'),
    });
  });

  it('remove member, add tags, rename: each hands its actor to the team service', async () => {
    mocks.removeTeamMember.mockResolvedValue({ removed: true, audit: AUDIT });
    mocks.addTeamTags.mockResolvedValue({ added: ['tag-1'], failed: [], audit: AUDIT });
    mocks.renameTeam.mockResolvedValue({
      teamId: 't-1',
      newSlug: 'blue',
      renamedRepos: [],
      failed: [],
      audit: AUDIT,
    });

    expect(await edit('removeMemberFromTeam', { login: 'ada' })).toEqual({
      success: 'Removed ada from @red.',
      action: expect.any(String),
    });
    expect(mocks.removeTeamMember.mock.calls[0][0]).toEqual({
      classroomId: 'class-1',
      slugOrId: 'red',
      login: 'ada',
      actor: actorFor('web:teams.remove_member'),
    });

    await edit('addTeamTags', { tags: ['tag-1'] });
    expect(mocks.addTeamTags.mock.calls[0][0].actor).toEqual(actorFor('web:teams.add_tags'));

    mocks.requestImpersonator.mockResolvedValue('admin-9');
    await edit('renameTeam', { newName: 'Blue' });
    expect(mocks.renameTeam.mock.calls[0][0]).toEqual({
      classroomId: 'class-1',
      slugOrId: 'red',
      newName: 'Blue',
      actor: actorFor('web:teams.rename', 'admin-9'),
    });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});

describe('inline tag pickers', () => {
  it('the assignment and repository forms create a tag through the tag service', async () => {
    expect(
      await postJson(
        assignments.action as Action,
        '/admin/cs1/assignments?/createTag',
        { class: 'cs1' },
        { name: ' Projects ' }
      )
    ).toEqual({ tag: { id: 'tag-1', name: 'Projects' } });
    expect(mocks.tagFindOrCreate).toHaveBeenLastCalledWith(
      'class-1',
      'Projects',
      actorFor('web:assignments.create_tag')
    );

    expect(
      await postJson(
        repoForm.action as Action,
        '/admin/cs1/repos/form?/createTag',
        { class: 'cs1' },
        { name: 'Projects' }
      )
    ).toEqual({ tag: { id: 'tag-1', name: 'Projects' } });
    expect(mocks.tagFindOrCreate).toHaveBeenLastCalledWith(
      'class-1',
      'Projects',
      actorFor('web:repos.create_tag')
    );
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});

describe('the assignment form, making a repository for a new REPO assignment', () => {
  it('records the repository through the repository service and the assignment itself', async () => {
    mocks.repositoryByTitle.mockResolvedValue(null);
    mocks.repositoryCreate.mockResolvedValue({ repository: { id: 'repo-new' }, audit: AUDIT });
    mocks.assignmentCreate.mockResolvedValue({
      id: 'asg-1',
      title: 'Lab 2',
      type: 'REPO',
      is_published: false,
      repository_id: 'repo-new',
    });
    const result = await postJson(
      assignments.action as Action,
      '/admin/cs1/assignments?/create',
      { class: 'cs1' },
      { type: 'REPO', title: 'Lab 2', template: 'acme/lab-template', module_id: 'mod-1' }
    );
    expect(result).toEqual({ success: 'Assignment "Lab 2" created' });
    expect(mocks.repositoryCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: 'Lab 2', classroom_id: 'class-1', type: 'INDIVIDUAL' }),
      actorFor('web:assignments.create')
    );
    // The assignment's own row names the repository it was made with.
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        resourceType: 'ASSIGNMENT',
        resourceId: 'asg-1',
        metadata: expect.objectContaining({
          tool: 'web:assignments.create',
          repository_id: 'repo-new',
        }),
      })
    );
  });
});

describe('a student’s own team page', () => {
  const PARAMS = { class: 'cs1', repo: 'lab-1' };
  const page = (intent: string, body: object) =>
    postForm(
      studentTeam.action as Action,
      `/student/cs1/repos/lab-1/team?/${intent}`,
      PARAMS,
      body
    );
  const TEAM = {
    id: 'team-9',
    slug: 'pairs',
    name: 'Pairs',
    classroom_id: 'class-1',
    tags: [{ tag_id: 'tag-1' }],
    memberships: [],
  };

  beforeEach(() => {
    gateUser = { userId: 'student-1', role: 'STUDENT' };
    mocks.repositoryBySlugs.mockResolvedValue({
      id: 'repo-1',
      slug: 'lab-1',
      title: 'Lab 1',
      type: 'GROUP',
      team_formation_mode: 'SELF_FORMED',
      team_formation_deadline: null,
      is_published: true,
      max_team_size: 3,
    });
    mocks.classroomFindById.mockResolvedValue(CLASSROOM);
    mocks.userFindUnique.mockResolvedValue({
      accounts: [{ provider_id: 'github', username: 'ada' }],
    });
    mocks.teamBySlug.mockResolvedValue(null);
    mocks.userTeamByTag.mockResolvedValue(null);
    mocks.teamFindById.mockResolvedValue(TEAM);
    mocks.provider.createTeam.mockResolvedValue({ id: 77, slug: 'pairs' });
    mocks.createWithMembershipAndTag.mockResolvedValue({ team: TEAM, audit: AUDIT });
    mocks.addMemberToTeam.mockResolvedValue({ added: true, audit: AUDIT });
    mocks.removeMemberFromTeam.mockResolvedValue({ count: 1, audit: AUDIT });
  });

  it('makes the repository’s tag through the tag service, as the student', async () => {
    await page('join', { teamId: 'team-9' });
    expect(mocks.tagFindOrCreate).toHaveBeenCalledExactlyOnceWith(
      'class-1',
      'lab-1',
      actorFor('web:team_formation.tag')
    );
  });

  it('create: the team service records the team and its first member', async () => {
    const result = await page('create', { teamName: 'Pairs' });
    expect(result).toMatchObject({ success: 'Team "Pairs" created.' });
    expect(mocks.createWithMembershipAndTag).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'Pairs', classroomId: 'class-1', userId: 'student-1' }),
      actorFor('web:team_formation.create')
    );
  });

  it('join and leave: the membership service records each, for the student', async () => {
    expect(await page('join', { teamId: 'team-9' })).toEqual({
      success: 'You have joined "Pairs"',
    });
    expect(mocks.addMemberToTeam).toHaveBeenCalledExactlyOnceWith(
      TEAM,
      'student-1',
      actorFor('web:team_formation.join')
    );

    mocks.userTeamByTag.mockResolvedValue(TEAM);
    expect(await page('leave', {})).toEqual({ success: 'You have left "Pairs"' });
    expect(mocks.removeMemberFromTeam).toHaveBeenCalledExactlyOnceWith(
      TEAM,
      'student-1',
      actorFor('web:team_formation.leave')
    );
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('a team of another classroom is not joined, and nothing is recorded', async () => {
    mocks.teamFindById.mockResolvedValue({ ...TEAM, classroom_id: 'class-2' });
    expect(await page('join', { teamId: 'team-9' })).toEqual({ error: 'Team not found' });
    expect(mocks.addMemberToTeam).not.toHaveBeenCalled();
  });
});

describe('the contributor link', () => {
  it('hands the analytics service its actor, with the repo’s own classroom gate', async () => {
    gateUser = { userId: 'ta-1', role: 'ASSISTANT' };
    mocks.gitRepoFindUnique.mockResolvedValue({ id: 'gr-1', classroom_id: 'class-1' });
    mocks.linkContributor.mockResolvedValue({ audit: AUDIT });
    const response = (await contributorLink.action({
      params: { id: 'gr-1' },
      request: new Request('http://localhost/api/repos/gr-1/contributor-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ github_login: 'octocat', user_id: 'student-1' }),
      }),
    } as never)) as Response;
    expect(await response.json()).toEqual({ linked: true });
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ classroomId: 'class-1' })
    );
    expect(mocks.linkContributor).toHaveBeenCalledExactlyOnceWith(
      'gr-1',
      'octocat',
      'student-1',
      actorFor('web:repos.link_contributor')
    );
  });
});
