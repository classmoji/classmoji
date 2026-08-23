/**
 * Unit tests for repo_create (container create). The tool must:
 *   - write classroom_id from ctx, never from input;
 *   - refresh the content manifest but NEVER trigger repo provisioning
 *     (provisioning is repo_publish's job — a create must not touch GitHub repos);
 *   - validate a supplied tag belongs to the classroom (S1);
 *   - enforce the GROUP+INSTRUCTOR-needs-tag rule and map P2002 to invalid_params.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  repositoryCreate: vi.fn(),
  findByClassroomId: vi.fn(),
  saveManifest: vi.fn(),
  auditCreate: vi.fn(),
  createRepositoriesTrigger: vi.fn(),
  repositoryFindById: vi.fn(),
  setPublished: vi.fn(),
  findUsersByRole: vi.fn(),
  findTeamsByTag: vi.fn(),
  findGitReposByRepository: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: {
      create: (...a: unknown[]) => mocks.repositoryCreate(...a),
      findById: (...a: unknown[]) => mocks.repositoryFindById(...a),
      setPublished: (...a: unknown[]) => mocks.setPublished(...a),
    },
    organizationTag: {
      findByClassroomId: (...a: unknown[]) => mocks.findByClassroomId(...a),
      findTeamsByTag: (...a: unknown[]) => mocks.findTeamsByTag(...a),
    },
    classroomMembership: { findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a) },
    gitRepo: { findByRepository: (...a: unknown[]) => mocks.findGitReposByRepository(...a) },
    contentManifest: { saveManifest: (...a: unknown[]) => mocks.saveManifest(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

vi.mock('@classmoji/tasks', () => ({
  default: {
    createRepositoriesTask: {
      trigger: (...a: unknown[]) => mocks.createRepositoriesTrigger(...a),
    },
  },
}));

const { repoCreateTool, repoPublishTool } = await import('../repos.ts');

const CTX: ToolContext = {
  viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'OWNER',
    status: 'ACTIVE',
    slug: 'cs1-w26',
    membership: { id: 'm-1', role: 'OWNER' },
    classroom: { settings: {}, slug: 'cs1-w26' },
  },
} as unknown as ToolContext;

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.saveManifest.mockResolvedValue(undefined);
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.repositoryCreate.mockResolvedValue({
    id: 'repo-new',
    title: 'Lab 1',
    slug: 'lab-1',
    type: 'INDIVIDUAL',
    is_published: false,
    weight: 100,
  });
});

describe('repo_create', () => {
  const BASE = { classroom: 'org/cs1-w26', title: 'Lab 1', template: 'lab1-template' };

  it('creates an unpublished container from ctx classroom, refreshes manifest, NO provisioning', async () => {
    const payload = parse(await repoCreateTool.handler(BASE, CTX));

    expect(payload.repository.id).toBe('repo-new');
    expect(payload.repository.is_published).toBe(false);

    const data = mocks.repositoryCreate.mock.calls[0][0] as { classroom_id: string; type: string };
    expect(data.classroom_id).toBe('class-1'); // from ctx, not input
    expect(data.type).toBe('INDIVIDUAL');

    expect(mocks.saveManifest).toHaveBeenCalledWith('class-1');
    // The key isolation guarantee: creating a container must NOT provision repos.
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
    expect((mocks.auditCreate.mock.calls[0][0] as { action: string }).action).toBe('CREATE');
  });

  it('rejects a GROUP + instructor-assigned container with no tag_id', async () => {
    await expect(repoCreateTool.handler({ ...BASE, type: 'GROUP' }, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    expect(mocks.repositoryCreate).not.toHaveBeenCalled();
  });

  it('refuses a tag_id that belongs to another classroom (S1)', async () => {
    mocks.findByClassroomId.mockResolvedValue([{ id: 'tag-a' }, { id: 'tag-b' }]);
    await expect(
      repoCreateTool.handler(
        { ...BASE, type: 'GROUP', tag_id: '11111111-1111-1111-1111-111111111111' },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.repositoryCreate).not.toHaveBeenCalled();
  });

  it('creates a GROUP container when the tag_id belongs to the classroom', async () => {
    mocks.findByClassroomId.mockResolvedValue([{ id: 'tag-a' }]);
    mocks.repositoryCreate.mockResolvedValue({
      id: 'repo-g',
      title: 'Group Lab',
      slug: 'group-lab',
      type: 'GROUP',
      is_published: false,
      weight: 100,
    });

    await repoCreateTool.handler(
      { ...BASE, title: 'Group Lab', type: 'GROUP', tag_id: 'tag-a' },
      CTX
    );
    const data = mocks.repositoryCreate.mock.calls[0][0] as {
      type: string;
      tag_id: string;
      team_formation_mode: string;
    };
    expect(data.type).toBe('GROUP');
    expect(data.tag_id).toBe('tag-a');
    expect(data.team_formation_mode).toBe('INSTRUCTOR');
  });

  it('maps a duplicate-title P2002 to invalid_params', async () => {
    mocks.repositoryCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(repoCreateTool.handler(BASE, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    expect(mocks.saveManifest).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

/**
 * repo_publish must stay usable before a course starts. Publishing an INDIVIDUAL
 * repo used to throw `No students found.` on an empty roster, which blocked
 * pre-term staging entirely — the instructor could not mark anything published
 * until at least one student had enrolled. Publish now flips visibility and
 * defers provisioning: joiners are provisioned by activate_membership, and Sync
 * backfills anyone that missed. These specs pin route parity with
 * admin.$class.repos/helpers.ts.
 */
describe('repo_publish — publishing before students enrol', () => {
  const PUBLISH_ARGS = { classroom: 'dev-org/cs1-w26', repository_id: 'repo-1' };

  const repositoryRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'repo-1',
    classroom_id: 'class-1',
    title: 'Lab 1',
    slug: 'lab-1',
    type: 'INDIVIDUAL',
    is_published: false,
    ...overrides,
  });

  beforeEach(() => {
    mocks.repositoryFindById.mockResolvedValue(repositoryRow());
    mocks.setPublished.mockResolvedValue(undefined);
    mocks.findUsersByRole.mockResolvedValue([]);
    mocks.findTeamsByTag.mockResolvedValue([]);
    mocks.findGitReposByRepository.mockResolvedValue([]);
    // Provisioning is fire-and-forget with a `.catch` attached, so the handle
    // has to be a real promise.
    mocks.createRepositoriesTrigger.mockResolvedValue({ id: 'run-1' });
  });

  it('publishes an INDIVIDUAL repo with an empty roster instead of erroring', async () => {
    const result = await repoPublishTool.handler(PUBLISH_ARGS, CTX);

    expect(mocks.setPublished).toHaveBeenCalledWith('repo-1', true, 'class-1');
    expect(parse(result as { content: Array<{ text: string }> })).toMatchObject({
      success: true,
      is_published: true,
      provisioning: { repos_to_create: 0 },
    });
  });

  it('triggers no provisioning when there is nobody to provision for', async () => {
    await repoPublishTool.handler(PUBLISH_ARGS, CTX);

    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });

  it('publishes when every enrolled student is still missing a GitHub login', async () => {
    // Roster is non-empty but nobody has accepted their org invite yet, so there
    // is no login to create a repo under. The old length check passed here and
    // then silently provisioned nothing.
    mocks.findUsersByRole.mockResolvedValue([{ id: 'u-1', login: null }]);

    await repoPublishTool.handler(PUBLISH_ARGS, CTX);

    expect(mocks.setPublished).toHaveBeenCalledWith('repo-1', true, 'class-1');
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });

  it('audits the empty-roster publish as a flip with no provisioning', async () => {
    await repoPublishTool.handler(PUBLISH_ARGS, CTX);

    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      resource_type: 'REPOSITORIES',
      resource_id: 'repo-1',
      action: 'UPDATE',
      data: { tool: 'repo_publish', is_published: true, provisioning_triggered: false },
    });
  });

  it('publishes an instructor-assigned GROUP repo that has no teams yet', async () => {
    mocks.repositoryFindById.mockResolvedValue(
      repositoryRow({ type: 'GROUP', team_formation_mode: 'INSTRUCTOR', tag_id: 'tag-1' })
    );

    await repoPublishTool.handler(PUBLISH_ARGS, CTX);

    expect(mocks.setPublished).toHaveBeenCalledWith('repo-1', true, 'class-1');
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });

  it('still fans out normally when students are enrolled (no regression)', async () => {
    mocks.findUsersByRole.mockResolvedValue([
      { id: 'u-1', login: 'student-a' },
      { id: 'u-2', login: 'student-b' },
    ]);

    const result = await repoPublishTool.handler(PUBLISH_ARGS, CTX);

    expect(mocks.createRepositoriesTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.createRepositoriesTrigger.mock.calls[0][0]).toMatchObject({
      logins: ['student-a', 'student-b'],
      assignmentTitle: 'Lab 1',
      org: 'cs1-w26',
    });
    expect(parse(result as { content: Array<{ text: string }> })).toMatchObject({
      provisioning: { repos_to_create: 2 },
    });
  });

  it('re-publish with existing repos still flips without provisioning', async () => {
    mocks.findGitReposByRepository.mockResolvedValue([{ id: 'gitrepo-1' }]);

    await repoPublishTool.handler(PUBLISH_ARGS, CTX);

    expect(mocks.setPublished).toHaveBeenCalledWith('repo-1', true, 'class-1');
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
  });

  it('refuses a repository belonging to another classroom (S1)', async () => {
    mocks.repositoryFindById.mockResolvedValue(repositoryRow({ classroom_id: 'other-class' }));

    await expect(repoPublishTool.handler(PUBLISH_ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.setPublished).not.toHaveBeenCalled();
  });
});
