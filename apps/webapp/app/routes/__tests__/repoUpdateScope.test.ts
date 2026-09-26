/**
 * Unit tests for the two "Update repositories" routes
 * (admin.$class.repos.update and admin.$class.repos_.$title.update).
 *
 * The loader reads the repository named by `?id=` from the authorized
 * classroom only (404 otherwise). The action takes only the repository id from
 * the body, loads it from the classroom, and builds the task payload from the
 * STORED template — a template in the body is ignored; a bare stored name is a
 * repository in the classroom's organization. A refused id or a malformed body
 * triggers nothing and asks GitHub for nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  repositoryFindByIdInClassroom: vi.fn(),
  gitRepoFindByRepository: vi.fn(),
  octokitRequest: vi.fn(),
  getGitProvider: vi.fn(),
  batchTrigger: vi.fn(),
  createPublicToken: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: {
      findByIdInClassroom: (...a: unknown[]) => mocks.repositoryFindByIdInClassroom(...a),
    },
    gitRepo: { findByRepository: (...a: unknown[]) => mocks.gitRepoFindByRepository(...a) },
  },
  getGitProvider: (...a: unknown[]) => mocks.getGitProvider(...a),
  GitHubProvider: class {},
}));

vi.mock('@trigger.dev/sdk', () => ({
  auth: { createPublicToken: (...a: unknown[]) => mocks.createPublicToken(...a) },
  tasks: { batchTrigger: (...a: unknown[]) => mocks.batchTrigger(...a) },
}));

vi.mock('nanoid', () => ({ nanoid: () => 'session-1' }));
vi.mock('~/hooks', () => ({ useDisclosure: () => ({}), useGlobalFetcher: () => ({}) }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn(), useParams: () => ({}) }));

const flat = await import('../admin.$class.repos.update/route.tsx');
const nested = await import('../admin.$class.repos_.$title.update/route.tsx');

const CLASS_SLUG = 'cs52-26f';
const ORG = { login: 'acme', provider: 'GITHUB', github_installation_id: '42' };
const OWN_REPOSITORY = { id: 'repo-1', title: 'lab-1', template: 'acme/lab-1-template' };

type Args = { params: Record<string, string>; request: Request };
type Route = {
  loader: (args: Args) => Promise<unknown>;
  action: (args: Args) => Promise<unknown>;
};

const ROUTES: Array<[string, Route, Record<string, string>]> = [
  ['admin.$class.repos.update', flat as unknown as Route, { class: CLASS_SLUG }],
  [
    'admin.$class.repos_.$title.update',
    nested as unknown as Route,
    { class: CLASS_SLUG, title: 'lab-1' },
  ],
];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE', git_organization: ORG },
    membership: { role: 'OWNER' },
  });
  mocks.repositoryFindByIdInClassroom.mockImplementation((id, classroomId) =>
    Promise.resolve(id === 'repo-1' && classroomId === 'class-1' ? OWN_REPOSITORY : null)
  );
  mocks.gitRepoFindByRepository.mockResolvedValue([{ name: 'lab-1-alice' }, { name: 'lab-1-bob' }]);
  mocks.octokitRequest.mockResolvedValue({ data: { token: 'install-token' } });
  mocks.getGitProvider.mockReturnValue({
    getOctokit: async () => ({ request: mocks.octokitRequest }),
  });
  mocks.createPublicToken.mockResolvedValue('public-token');
  mocks.batchTrigger.mockResolvedValue(undefined);
});

describe.each(ROUTES)('%s', (_name, route, params) => {
  const load = (query: string) =>
    route.loader({
      params,
      request: new Request(`http://localhost/admin/${CLASS_SLUG}/repos/update${query}`),
    });

  const submit = (body: unknown) =>
    route.action({
      params,
      request: new Request(`http://localhost/admin/${CLASS_SLUG}/repos/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });

  it('loads a repository of this classroom', async () => {
    expect(await load('?id=repo-1')).toEqual({ repository: OWN_REPOSITORY });
    expect(mocks.repositoryFindByIdInClassroom).toHaveBeenCalledWith('repo-1', 'class-1');
  });

  it('answers 404 for a repository outside this classroom, or no id', async () => {
    for (const query of ['?id=repo-elsewhere', '']) {
      await expect(load(query)).rejects.toMatchObject({ status: 404 });
    }
  });

  it('updates from the stored template, ignoring a template in the body', async () => {
    const result = await submit({
      values: { title: 'Sync template', description: 'Pulls in fixes' },
      repository: { id: 'repo-1', template: 'someone/else' },
    });

    expect(result).toEqual({
      triggerSession: { accessToken: 'public-token', id: 'session-1', numReposToUpdate: 2 },
    });
    expect(mocks.gitRepoFindByRepository).toHaveBeenCalledWith(CLASS_SLUG, 'repo-1');
    expect(mocks.batchTrigger).toHaveBeenCalledWith('update_git_repo', [
      {
        payload: {
          gitOrganization: ORG,
          repoName: 'lab-1-alice',
          branchName: undefined,
          prTitle: 'Sync template',
          prDescription: 'Pulls in fixes',
          templateOwner: 'acme',
          templateRepo: 'lab-1-template',
          token: 'install-token',
        },
        options: { tags: ['session_session-1'] },
      },
      expect.objectContaining({
        payload: expect.objectContaining({ repoName: 'lab-1-bob', templateRepo: 'lab-1-template' }),
      }),
    ]);
  });

  it('refuses a repository outside this classroom with no GitHub call and no task', async () => {
    expect(
      await submit({
        values: { title: 't' },
        repository: { id: 'repo-elsewhere', template: 'a/x' },
      })
    ).toEqual({ error: 'Repository not found.' });
    expect(mocks.getGitProvider).not.toHaveBeenCalled();
    expect(mocks.octokitRequest).not.toHaveBeenCalled();
    expect(mocks.gitRepoFindByRepository).not.toHaveBeenCalled();
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
  });

  it('resolves a stored bare template name against the classroom organization', async () => {
    mocks.repositoryFindByIdInClassroom.mockResolvedValue({
      ...OWN_REPOSITORY,
      template: 'lab-1-template',
    });

    await submit({ values: { title: 't' }, repository: { id: 'repo-1' } });

    expect(mocks.batchTrigger).toHaveBeenCalledWith(
      'update_git_repo',
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            templateOwner: 'acme',
            templateRepo: 'lab-1-template',
          }),
        }),
      ])
    );
  });

  it('keeps the owner of a stored owner/repo template', async () => {
    mocks.repositoryFindByIdInClassroom.mockResolvedValue({
      ...OWN_REPOSITORY,
      template: 'course-templates/lab-1',
    });

    await submit({ values: { title: 't' }, repository: { id: 'repo-1' } });

    expect(mocks.batchTrigger).toHaveBeenCalledWith(
      'update_git_repo',
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            templateOwner: 'course-templates',
            templateRepo: 'lab-1',
          }),
        }),
      ])
    );
  });

  it('refuses a repository with no stored template', async () => {
    for (const template of [null, '', '  /  ']) {
      mocks.repositoryFindByIdInClassroom.mockResolvedValue({ ...OWN_REPOSITORY, template });
      expect(
        await submit({ values: { title: 't' }, repository: { id: 'repo-1', template: 'acme/x' } })
      ).toEqual({ error: 'This repository has no template repository to update from.' });
    }
    expect(mocks.octokitRequest).not.toHaveBeenCalled();
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
  });

  it('answers a malformed body with the error shape and no lookup', async () => {
    const malformed: unknown[] = [
      null,
      'text',
      [],
      { repository: { id: 'repo-1' } },
      { values: 'title', repository: { id: 'repo-1' } },
      { values: { title: 42 }, repository: { id: 'repo-1' } },
      { values: { title: 't', description: { x: 1 } }, repository: { id: 'repo-1' } },
      { values: { title: 't', branchName: 7 }, repository: { id: 'repo-1' } },
      { values: { title: 't' }, repository: { id: { not: '' } } },
      { values: { title: 't' }, repository: null },
    ];
    for (const body of malformed) {
      expect(await submit(body)).toEqual({ error: 'Invalid request.' });
    }

    const notJson = await route.action({
      params,
      request: new Request(`http://localhost/admin/${CLASS_SLUG}/repos/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      }),
    });
    expect(notJson).toEqual({ error: 'Invalid request.' });

    expect(mocks.repositoryFindByIdInClassroom).not.toHaveBeenCalled();
    expect(mocks.octokitRequest).not.toHaveBeenCalled();
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
  });
});
