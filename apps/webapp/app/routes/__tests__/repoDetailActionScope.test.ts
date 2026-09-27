/**
 * Unit tests for the repository page's actions (admin.$class.repos_.$title),
 * the repositories list's calculateContributions (admin.$class.repos) and the
 * assignment page's grader actions (admin.$class.assignments_.$id).
 *
 * Authorization binds to `params.class`; the body carries ids (and, from older
 * clients, names and logins). These tests pin that only the ids are used, each
 * looked up in the authorized classroom first, and that a normal call from the
 * page still works:
 *   - deleteRepo: the git repo is loaded from this classroom and this page's
 *     repository; the stored name is what is deleted, never the body's;
 *   - addGrader/removeGrader: only ids and the classroom reach the scoped
 *     helper; its refusals come back in the route's error shape;
 *   - calculateContributions/createProjects: the repository must be in this
 *     classroom before any task is triggered.
 *
 * That the stored repo name, issue number and login are what reach GitHub is
 * pinned in packages/services (helper/__tests__/classroomScopedWrites.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  requireClassroomTeachingTeam: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  repositoryFindByIdInClassroom: vi.fn(),
  repositoryFindByClassroomAndTitle: vi.fn(),
  gitRepoFindByIdInClassroom: vi.fn(),
  deleteRepository: vi.fn(),
  addGraderInClassroom: vi.fn(),
  removeGraderInClassroom: vi.fn(),
  tasksTrigger: vi.fn(),
  calculateContributions: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  requireClassroomTeachingTeam: (...a: unknown[]) => mocks.requireClassroomTeachingTeam(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: {
      findByIdInClassroom: (...a: unknown[]) => mocks.repositoryFindByIdInClassroom(...a),
      findByClassroomAndTitle: (...a: unknown[]) => mocks.repositoryFindByClassroomAndTitle(...a),
    },
    gitRepo: {
      findByIdInClassroom: (...a: unknown[]) => mocks.gitRepoFindByIdInClassroom(...a),
    },
  },
  HelperService: {
    deleteRepository: (...a: unknown[]) => mocks.deleteRepository(...a),
    addGraderInClassroom: (...a: unknown[]) => mocks.addGraderInClassroom(...a),
    removeGraderInClassroom: (...a: unknown[]) => mocks.removeGraderInClassroom(...a),
  },
}));

vi.mock('@trigger.dev/sdk/v3', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.tasksTrigger(...a) },
}));

// Both contribution helpers fan out Trigger runs; what matters here is whether
// they are reached, and with which repository id.
vi.mock('../admin.$class.repos_.$title/helpers', () => ({
  calculateContributions: (...a: unknown[]) => mocks.calculateContributions(...a),
}));
vi.mock('../admin.$class.repos/contributions', () => ({
  calculateContributions: (...a: unknown[]) => mocks.calculateContributions(...a),
}));
vi.mock('../admin.$class.repos/helpers', () => ({
  publishAssignment: vi.fn(),
  publishAssignmentAndRepository: vi.fn(),
  syncAssignment: vi.fn(),
}));

const detail = await import('../admin.$class.repos_.$title/action.ts');
const list = await import('../admin.$class.repos/action.ts');

const CLASS_SLUG = 'cs52-26f';
const TITLE = 'lab-1';
const ORG = { login: 'acme', provider: 'GITHUB' };
const PAGE_REPOSITORY = { id: 'repo-1', title: TITLE };
const OWN_GIT_REPO = { id: 'gr-1', name: 'lab-1-alice', classroom_id: 'class-1' };

type ActionArgs = { params: Record<string, string>; request: Request };

const post = (
  run: (args: ActionArgs) => Promise<unknown>,
  path: string,
  params: Record<string, string>,
  body: unknown
) =>
  run({
    params,
    request: new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });

const detailAction = (name: string, body: unknown) =>
  post(
    detail.action as unknown as (args: ActionArgs) => Promise<unknown>,
    `/admin/${CLASS_SLUG}/repos/${TITLE}?/${name}`,
    { class: CLASS_SLUG, title: TITLE },
    body
  );

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  const session = {
    userId: 'owner-1',
    classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE', git_organization: ORG },
    membership: { role: 'OWNER' },
  };
  mocks.requireClassroomAdmin.mockResolvedValue(session);
  mocks.requireClassroomTeachingTeam.mockResolvedValue(session);
  mocks.repositoryFindByClassroomAndTitle.mockImplementation((classroomId, title) =>
    Promise.resolve(classroomId === 'class-1' && title === TITLE ? PAGE_REPOSITORY : null)
  );
  mocks.repositoryFindByIdInClassroom.mockImplementation((id, classroomId) =>
    Promise.resolve(id === 'repo-1' && classroomId === 'class-1' ? PAGE_REPOSITORY : null)
  );
  mocks.gitRepoFindByIdInClassroom.mockImplementation((id, classroomId, options) =>
    Promise.resolve(
      id === 'gr-1' && classroomId === 'class-1' && options?.repositoryId === 'repo-1'
        ? OWN_GIT_REPO
        : null
    )
  );
  mocks.deleteRepository.mockResolvedValue({ id: 'gr-1' });
  mocks.addGraderInClassroom.mockResolvedValue({ status: 'added', graderLogin: 'ta-bob' });
  mocks.removeGraderInClassroom.mockResolvedValue({ status: 'removed', graderLogin: 'ta-bob' });
  mocks.tasksTrigger.mockResolvedValue({ id: 'run-1' });
  mocks.calculateContributions.mockResolvedValue({ triggerSession: { id: 's-1' } });
});

describe('repository page: deleteRepo', () => {
  it('deletes the stored repo of this classroom and page', async () => {
    const result = await detailAction('deleteRepo', {
      action: 'delete-repo',
      repo: { id: 'gr-1', name: 'lab-1-alice' },
    });

    expect(result).toEqual({ action: 'delete-repo', success: 'Repository deleted' });
    expect(mocks.repositoryFindByClassroomAndTitle).toHaveBeenCalledWith('class-1', TITLE);
    expect(mocks.gitRepoFindByIdInClassroom).toHaveBeenCalledWith('gr-1', 'class-1', {
      repositoryId: 'repo-1',
    });
    expect(mocks.deleteRepository).toHaveBeenCalledExactlyOnceWith({
      id: 'gr-1',
      name: 'lab-1-alice',
      gitOrganization: ORG,
      classroomId: 'class-1',
      deleteFromGithub: true,
    });
  });

  it('uses the stored name even when the body carries a different one', async () => {
    await detailAction('deleteRepo', {
      action: 'delete-repo',
      repo: { id: 'gr-1', name: 'some-other-repo' },
    });

    expect(mocks.deleteRepository).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gr-1', name: 'lab-1-alice' })
    );
  });

  it('refuses a git repo that is not in this classroom and page, with no delete', async () => {
    for (const repo of [
      { id: 'gr-elsewhere', name: 'lab-1-alice' },
      { name: 'lab-1-alice' },
      null,
    ]) {
      const result = await detailAction('deleteRepo', { action: 'delete-repo', repo });
      expect(result).toEqual({ action: 'delete-repo', error: 'Repository not found.' });
    }
    expect(mocks.deleteRepository).not.toHaveBeenCalled();
  });

  it('refuses when the page repository is not in this classroom', async () => {
    mocks.repositoryFindByClassroomAndTitle.mockResolvedValue(null);

    const result = await detailAction('deleteRepo', {
      action: 'delete-repo',
      repo: { id: 'gr-1', name: 'lab-1-alice' },
    });

    expect(result).toMatchObject({ error: 'Repository not found.' });
    expect(mocks.gitRepoFindByIdInClassroom).not.toHaveBeenCalled();
    expect(mocks.deleteRepository).not.toHaveBeenCalled();
  });
});

/** A grader body as the page's SubmissionsTable submits it. */
const GRADER_BODY = {
  repoName: 'lab-1-alice',
  githubIssueNumber: 7,
  repoAssignmentId: 'ra-1',
  graderId: 'u-bob',
  graderLogin: 'ta-bob',
};

describe('repository page: addGrader / removeGrader', () => {
  it('hands only the ids, the classroom and the page repository to the scoped helper', async () => {
    const result = await detailAction('addGrader', {
      ...GRADER_BODY,
      repoName: 'some-other-repo',
      githubIssueNumber: 999,
      graderLogin: 'someone-else',
    });

    expect(result).toEqual({ action: 'add-grader', success: 'Grader added' });
    expect(mocks.addGraderInClassroom).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      gitOrganization: ORG,
      gitRepoAssignmentId: 'ra-1',
      graderId: 'u-bob',
      repositoryId: 'repo-1',
    });
  });

  it('reports a grader already on the submission as a success', async () => {
    mocks.addGraderInClassroom.mockResolvedValue({
      status: 'already_assigned',
      graderLogin: 'ta-bob',
    });

    expect(await detailAction('addGrader', GRADER_BODY)).toEqual({
      action: 'add-grader',
      success: 'Already assigned',
    });
  });

  it('removes the same way', async () => {
    const result = await detailAction('removeGrader', GRADER_BODY);

    expect(result).toEqual({ action: 'remove-grader', success: 'Grader removed' });
    expect(mocks.removeGraderInClassroom).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      gitOrganization: ORG,
      gitRepoAssignmentId: 'ra-1',
      graderId: 'u-bob',
      repositoryId: 'repo-1',
    });
  });

  it('returns the error shape for a submission outside this classroom', async () => {
    mocks.addGraderInClassroom.mockResolvedValue({ status: 'submission_not_found' });
    mocks.removeGraderInClassroom.mockResolvedValue({ status: 'submission_not_found' });

    expect(await detailAction('addGrader', GRADER_BODY)).toEqual({
      action: 'add-grader',
      error: 'Submission not found.',
    });
    expect(await detailAction('removeGrader', GRADER_BODY)).toEqual({
      action: 'remove-grader',
      error: 'Submission not found.',
    });
  });

  it('returns the error shape for a grader not on the teaching team', async () => {
    mocks.addGraderInClassroom.mockResolvedValue({ status: 'grader_not_eligible' });

    expect(await detailAction('addGrader', { ...GRADER_BODY, graderId: 'u-student' })).toEqual({
      action: 'add-grader',
      error: 'That person is not a grader in this classroom.',
    });
  });

  it('returns the error shape for removing a grader who is not assigned', async () => {
    mocks.removeGraderInClassroom.mockResolvedValue({ status: 'grader_not_assigned' });

    expect(await detailAction('removeGrader', GRADER_BODY)).toEqual({
      action: 'remove-grader',
      error: 'That grader is not assigned to this submission.',
    });
  });

  it('refuses without reaching the helper when the page repository is not in this classroom', async () => {
    mocks.repositoryFindByClassroomAndTitle.mockResolvedValue(null);

    expect(await detailAction('addGrader', GRADER_BODY)).toMatchObject({
      error: 'Submission not found.',
    });
    expect(await detailAction('removeGrader', GRADER_BODY)).toMatchObject({
      error: 'Submission not found.',
    });
    expect(mocks.addGraderInClassroom).not.toHaveBeenCalled();
    expect(mocks.removeGraderInClassroom).not.toHaveBeenCalled();
  });
});

describe('repository page: calculateContributions / createProjects', () => {
  it('runs for a repository of this classroom', async () => {
    const contributions = await detailAction('calculateContributions', {
      repository: { id: 'repo-1', type: 'GROUP' },
    });
    const projects = await detailAction('createProjects', { repositoryId: 'repo-1' });

    expect(contributions).toEqual({ triggerSession: { id: 's-1' } });
    expect(mocks.calculateContributions).toHaveBeenCalledWith({ id: 'repo-1' }, CLASS_SLUG);
    expect(projects).toMatchObject({ success: 'Project creation started', taskId: 'run-1' });
    expect(mocks.tasksTrigger).toHaveBeenCalledWith('gh-create_projects_for_repository', {
      repositoryId: 'repo-1',
      classroomSlug: CLASS_SLUG,
    });
  });

  it('refuses a repository outside this classroom and triggers nothing', async () => {
    for (const repository of [{ id: 'repo-elsewhere' }, { id: { not: '' } }, undefined]) {
      expect(await detailAction('calculateContributions', { repository })).toEqual({
        action: 'CALCULATE_REPO_CONTRIBUTIONS',
        error: 'Repository not found.',
      });
    }
    for (const repositoryId of ['repo-elsewhere', undefined]) {
      expect(await detailAction('createProjects', { repositoryId })).toEqual({
        action: 'CREATE_PROJECTS',
        error: 'Repository not found.',
      });
    }
    expect(mocks.calculateContributions).not.toHaveBeenCalled();
    expect(mocks.tasksTrigger).not.toHaveBeenCalled();
  });
});

describe('repositories list: calculateContributions', () => {
  const listAction = (body: unknown) =>
    post(
      list.action as unknown as (args: ActionArgs) => Promise<unknown>,
      `/admin/${CLASS_SLUG}/repos?/calculateContributions`,
      { class: CLASS_SLUG },
      body
    );

  it('runs for a repository of this classroom', async () => {
    await listAction({ assignment_id: 'repo-1' });

    expect(mocks.repositoryFindByIdInClassroom).toHaveBeenCalledWith('repo-1', 'class-1');
    expect(mocks.calculateContributions).toHaveBeenCalledWith({ id: 'repo-1' }, CLASS_SLUG);
  });

  it('refuses a repository outside this classroom', async () => {
    expect(await listAction({ assignment_id: 'repo-elsewhere' })).toEqual({
      action: 'CALCULATE_REPO_CONTRIBUTIONS',
      error: 'Repository not found.',
    });
    expect(mocks.calculateContributions).not.toHaveBeenCalled();
  });

  it('answers a malformed body with the error shape', async () => {
    for (const body of [null, 'text', {}, { assignment_id: 42 }, { assignment_id: '' }]) {
      expect(await listAction(body)).toEqual({ error: 'Invalid request.' });
    }
    const notJson = await (list.action as unknown as (args: ActionArgs) => Promise<unknown>)({
      params: { class: CLASS_SLUG },
      request: new Request(`http://localhost/admin/${CLASS_SLUG}/repos?/calculateContributions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      }),
    });
    expect(notJson).toEqual({ error: 'Invalid request.' });
    expect(mocks.repositoryFindByIdInClassroom).not.toHaveBeenCalled();
    expect(mocks.calculateContributions).not.toHaveBeenCalled();
  });
});
