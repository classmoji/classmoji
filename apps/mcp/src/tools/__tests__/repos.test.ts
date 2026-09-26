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
  moduleFindById: vi.fn(),
  repositoryUpdate: vi.fn(),
  findDependents: vi.fn(),
  deleteIfUnprovisioned: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: {
      create: (...a: unknown[]) => mocks.repositoryCreate(...a),
      findById: (...a: unknown[]) => mocks.repositoryFindById(...a),
      setPublished: (...a: unknown[]) => mocks.setPublished(...a),
      update: (...a: unknown[]) => mocks.repositoryUpdate(...a),
      findDependents: (...a: unknown[]) => mocks.findDependents(...a),
      deleteIfUnprovisioned: (...a: unknown[]) => mocks.deleteIfUnprovisioned(...a),
    },
    organizationTag: {
      findByClassroomId: (...a: unknown[]) => mocks.findByClassroomId(...a),
      findTeamsByTag: (...a: unknown[]) => mocks.findTeamsByTag(...a),
    },
    classroomMembership: { findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a) },
    gitRepo: { findByRepository: (...a: unknown[]) => mocks.findGitReposByRepository(...a) },
    module: { findById: (...a: unknown[]) => mocks.moduleFindById(...a) },
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

const { repoCreateTool, repoPublishTool, repoUpdateTool, repoDeleteTool } =
  await import('../repos.ts');

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
  mocks.moduleFindById.mockResolvedValue({ id: MODULE_ID, classroom_id: 'class-1' });
  mocks.repositoryCreate.mockResolvedValue({
    id: 'repo-new',
    title: 'Lab 1',
    slug: 'lab-1',
    type: 'INDIVIDUAL',
    is_published: false,
  });
});

const MODULE_ID = '22222222-2222-4222-8222-222222222222';

describe('repo_create', () => {
  const BASE = {
    classroom: 'org/cs1-w26',
    title: 'Lab 1',
    template: 'lab1-template',
  };

  it('creates an unpublished container from ctx classroom, refreshes manifest, NO provisioning', async () => {
    const payload = parse(await repoCreateTool.handler(BASE, CTX));

    expect(payload.repository.id).toBe('repo-new');
    expect(payload.repository.is_published).toBe(false);

    const data = mocks.repositoryCreate.mock.calls[0][0] as {
      classroom_id: string;
      type: string;
    };
    expect(data.classroom_id).toBe('class-1'); // from ctx, not input
    expect(data.type).toBe('INDIVIDUAL');
    expect(data).not.toHaveProperty('module_id'); // repositories have no module

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

// ─── repo_update / repo_delete (issue #457) ─────────────────────────────────

const REPO_ID = '33333333-3333-4333-8333-333333333333';
const TAG_ID = '44444444-4444-4444-8444-444444444444';
const FOREIGN_TAG_ID = '55555555-5555-4555-8555-555555555555';

/** The row repository.findById returns (it includes assignments + tag). */
const storedRepo = (overrides: Record<string, unknown> = {}) => ({
  id: REPO_ID,
  classroom_id: 'class-1',
  title: 'workshop',
  slug: 'workshop',
  template: 'org/workshop-template',
  description: null,
  is_published: false,
  type: 'GROUP',
  tag_id: null,
  tag: null,
  team_formation_mode: 'SELF_FORMED',
  team_formation_deadline: null,
  max_team_size: 2,
  project_template_id: null,
  project_template_title: null,
  assignments: [],
  ...overrides,
});

interface AssignmentDependent {
  id: string;
  title: string;
  _count: { pages: number; slides: number; calendarEventLinks: number };
}

const assignmentDependent = (
  id: string,
  title: string,
  counts: Partial<AssignmentDependent['_count']> = {}
): AssignmentDependent => ({
  id,
  title,
  _count: { pages: 0, slides: 0, calendarEventLinks: 0, ...counts },
});

const dependents = (
  overrides: Record<string, number> = {},
  assignments: AssignmentDependent[] = []
) => ({
  id: REPO_ID,
  assignments,
  _count: {
    git_repos: 0,
    module_items: 0,
    pages: 0,
    slides: 0,
    quizzes: 0,
    autograding_tests: 0,
    ...overrides,
  },
});

/** repository.update echoes the merged row back, tag included. */
function echoUpdate(base: Record<string, unknown> = {}) {
  mocks.repositoryUpdate.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
    const merged = { ...storedRepo(base), ...patch };
    return { ...merged, tag: merged.tag_id ? { id: merged.tag_id, name: 'workshop-pairs' } : null };
  });
}

describe('repo_update', () => {
  const BASE = { classroom: 'org/cs1-w26', repository_id: REPO_ID };

  beforeEach(() => {
    mocks.repositoryFindById.mockResolvedValue(storedRepo());
    mocks.findByClassroomId.mockResolvedValue([{ id: TAG_ID, name: 'workshop-pairs' }]);
    mocks.findDependents.mockResolvedValue(dependents());
    echoUpdate();
  });

  it('switches SELF_FORMED → INSTRUCTOR with a tag, scoped write, audit, manifest', async () => {
    const payload = parse(
      await repoUpdateTool.handler(
        { ...BASE, team_formation_mode: 'INSTRUCTOR', tag_id: TAG_ID },
        CTX
      )
    );

    expect(mocks.repositoryUpdate).toHaveBeenCalledWith(
      REPO_ID,
      { team_formation_mode: 'INSTRUCTOR', tag_id: TAG_ID },
      'class-1'
    );
    expect(payload.repository).toMatchObject({
      id: REPO_ID,
      team_formation_mode: 'INSTRUCTOR',
      tag: { id: TAG_ID, name: 'workshop-pairs' },
      max_team_size: 2,
    });
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      resource_type: 'REPOSITORIES',
      resource_id: REPO_ID,
      action: 'UPDATE',
      data: {
        tool: 'repo_update',
        fields: ['tag_id', 'team_formation_mode'],
        values: { tag_id: TAG_ID, team_formation_mode: 'INSTRUCTOR' },
      },
    });
    expect(mocks.saveManifest).toHaveBeenCalledWith('class-1');
  });

  it('audits a scalar `value` that is exactly the serialized `values`', async () => {
    await repoUpdateTool.handler({ ...BASE, description: 'Pairs', max_team_size: 3 }, CTX);
    const data = (mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.value).toBe(JSON.stringify(data.values));
  });

  it('rejects an empty patch before touching the database', async () => {
    await expect(repoUpdateTool.handler(BASE, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    expect(mocks.repositoryFindById).not.toHaveBeenCalled();
    expect(mocks.repositoryUpdate).not.toHaveBeenCalled();
  });

  it('refuses a repository belonging to another classroom (S1)', async () => {
    mocks.repositoryFindById.mockResolvedValue(storedRepo({ classroom_id: 'other-class' }));
    await expect(repoUpdateTool.handler({ ...BASE, description: 'x' }, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.repositoryUpdate).not.toHaveBeenCalled();
  });

  it('refuses a tag_id from another classroom (S1)', async () => {
    await expect(
      repoUpdateTool.handler(
        { ...BASE, team_formation_mode: 'INSTRUCTOR', tag_id: FOREIGN_TAG_ID },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'not_found', message: 'Tag not found in this classroom' });
    expect(mocks.repositoryUpdate).not.toHaveBeenCalled();
  });

  it('freezes structural fields once git repos exist', async () => {
    mocks.repositoryFindById.mockResolvedValue(storedRepo({ tag_id: 'old-tag' }));
    mocks.findDependents.mockResolvedValue(dependents({ git_repos: 3 }));
    await expect(
      repoUpdateTool.handler({ ...BASE, team_formation_mode: 'INSTRUCTOR', tag_id: TAG_ID }, CTX)
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'REPOS_PROVISIONED',
      data: { fields: ['tag_id', 'team_formation_mode'] },
    });
    expect(mocks.findDependents).toHaveBeenCalledWith(REPO_ID, 'class-1');
    expect(mocks.repositoryUpdate).not.toHaveBeenCalled();
  });

  it('still edits description / deadline / max_team_size when git repos exist', async () => {
    mocks.findDependents.mockResolvedValue(dependents({ git_repos: 3 }));
    await repoUpdateTool.handler(
      {
        ...BASE,
        description: 'Pairs',
        team_formation_deadline: '2026-10-01T23:59:00-04:00',
        max_team_size: 3,
        // Re-sending the current value of a structural field is not a change.
        type: 'GROUP',
      },
      CTX
    );
    const patch = mocks.repositoryUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.description).toBe('Pairs');
    expect((patch.team_formation_deadline as Date).toISOString()).toBe('2026-10-02T03:59:00.000Z');
    expect(patch.max_team_size).toBe(3);
  });

  it.each<[string, Partial<Parameters<typeof repoUpdateTool.handler>[0]>]>([
    ['template', { template: 'org/other-template' }],
    ['type', { type: 'INDIVIDUAL' }],
    ['team_formation_mode', { team_formation_mode: 'INSTRUCTOR', tag_id: TAG_ID }],
    ['project_template_id', { project_template_id: 'PVT_1' }],
  ])(
    'refuses a %s change while published even with ZERO git repos (provisioning is async)',
    async (_label, change) => {
      mocks.repositoryFindById.mockResolvedValue(storedRepo({ is_published: true }));
      mocks.findDependents.mockResolvedValue(dependents({ git_repos: 0 }));
      await expect(repoUpdateTool.handler({ ...BASE, ...change }, CTX)).rejects.toMatchObject({
        kind: 'invalid_params',
        code: 'REPO_PUBLISHED',
        message: /unpublish.*update.*republish/,
      });
      expect(mocks.repositoryUpdate).not.toHaveBeenCalled();
    }
  );

  it('still takes a description edit on a published repo', async () => {
    mocks.repositoryFindById.mockResolvedValue(storedRepo({ is_published: true }));
    await repoUpdateTool.handler({ ...BASE, description: 'x' }, CTX);
    expect(mocks.repositoryUpdate.mock.calls[0][1]).toEqual({ description: 'x' });
  });

  it('rejects a merged GROUP + INSTRUCTOR row with no tag', async () => {
    await expect(
      repoUpdateTool.handler({ ...BASE, team_formation_mode: 'INSTRUCTOR' }, CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params', message: /requires tag_id/ });
    expect(mocks.repositoryUpdate).not.toHaveBeenCalled();
  });

  it('rejects clearing the tag of an instructor-assigned GROUP repo', async () => {
    mocks.repositoryFindById.mockResolvedValue(
      storedRepo({ team_formation_mode: 'INSTRUCTOR', tag_id: TAG_ID })
    );
    await expect(repoUpdateTool.handler({ ...BASE, tag_id: null }, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message: 'A GROUP repo with instructor-assigned teams requires tag_id (see list_tags)',
    });
    expect(mocks.repositoryUpdate).not.toHaveBeenCalled();
  });

  describe('a GROUP/INSTRUCTOR repo whose tag was deleted (FK SET NULL)', () => {
    beforeEach(() => {
      mocks.repositoryFindById.mockResolvedValue(
        storedRepo({ team_formation_mode: 'INSTRUCTOR', tag_id: null })
      );
      mocks.findDependents.mockResolvedValue(dependents({ git_repos: 4 }));
    });

    it('still takes a description-only edit', async () => {
      await repoUpdateTool.handler({ ...BASE, description: 'x' }, CTX);
      expect(mocks.repositoryUpdate.mock.calls[0][1]).toEqual({ description: 'x' });
    });

    it('can be given a tag again even though git repos exist (repair path)', async () => {
      await repoUpdateTool.handler({ ...BASE, tag_id: TAG_ID }, CTX);
      expect(mocks.repositoryUpdate.mock.calls[0][1]).toEqual({ tag_id: TAG_ID });
    });

    it('repair still checks the tag belongs to this classroom', async () => {
      await expect(
        repoUpdateTool.handler({ ...BASE, tag_id: FOREIGN_TAG_ID }, CTX)
      ).rejects.toMatchObject({ kind: 'not_found' });
      expect(mocks.repositoryUpdate).not.toHaveBeenCalled();
    });

    it('repair is still refused while published', async () => {
      mocks.repositoryFindById.mockResolvedValue(
        storedRepo({ team_formation_mode: 'INSTRUCTOR', tag_id: null, is_published: true })
      );
      await expect(repoUpdateTool.handler({ ...BASE, tag_id: TAG_ID }, CTX)).rejects.toMatchObject({
        code: 'REPO_PUBLISHED',
      });
    });

    it('changing an EXISTING tag stays locked once git repos exist', async () => {
      mocks.repositoryFindById.mockResolvedValue(
        storedRepo({ team_formation_mode: 'INSTRUCTOR', tag_id: 'old-tag' })
      );
      await expect(repoUpdateTool.handler({ ...BASE, tag_id: TAG_ID }, CTX)).rejects.toMatchObject({
        code: 'REPOS_PROVISIONED',
      });
    });
  });

  it('treats a stored null team_formation_mode like the web superRefine (not INSTRUCTOR)', async () => {
    mocks.repositoryFindById.mockResolvedValue(
      storedRepo({ type: 'INDIVIDUAL', team_formation_mode: null, max_team_size: null })
    );
    echoUpdate({ type: 'INDIVIDUAL', team_formation_mode: null, max_team_size: null });
    await repoUpdateTool.handler({ ...BASE, type: 'GROUP' }, CTX);
    expect(mocks.repositoryUpdate.mock.calls[0][1]).toEqual({ type: 'GROUP' });
  });

  it('GROUP → INDIVIDUAL clears the team fields and audits them', async () => {
    mocks.repositoryFindById.mockResolvedValue(
      storedRepo({
        team_formation_mode: 'INSTRUCTOR',
        tag_id: TAG_ID,
        team_formation_deadline: new Date('2026-10-01T00:00:00Z'),
      })
    );
    await repoUpdateTool.handler({ ...BASE, type: 'INDIVIDUAL' }, CTX);

    expect(mocks.repositoryUpdate.mock.calls[0][1]).toEqual({
      type: 'INDIVIDUAL',
      tag_id: null,
      team_formation_deadline: null,
      max_team_size: null,
    });
    const audit = mocks.auditCreate.mock.calls[0][0] as { data: { fields: string[] } };
    expect(audit.data.fields).toEqual([
      'type',
      'tag_id',
      'team_formation_deadline',
      'max_team_size',
    ]);
  });

  it('never clears stale team fields on an edit to an already-INDIVIDUAL row', async () => {
    mocks.repositoryFindById.mockResolvedValue(
      storedRepo({ type: 'INDIVIDUAL', tag_id: TAG_ID, max_team_size: 2 })
    );
    await repoUpdateTool.handler({ ...BASE, description: 'x' }, CTX);
    expect(mocks.repositoryUpdate.mock.calls[0][1]).toEqual({ description: 'x' });
    expect(mocks.findDependents).not.toHaveBeenCalled();
  });

  it('refuses team fields on an INDIVIDUAL result', async () => {
    mocks.repositoryFindById.mockResolvedValue(
      storedRepo({ type: 'INDIVIDUAL', team_formation_mode: 'INSTRUCTOR', max_team_size: null })
    );
    await expect(repoUpdateTool.handler({ ...BASE, max_team_size: 4 }, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message: /GROUP repos only/,
    });
  });

  it('lets an INDIVIDUAL repo re-send team fields at their current values', async () => {
    mocks.repositoryFindById.mockResolvedValue(
      storedRepo({ type: 'INDIVIDUAL', team_formation_mode: 'INSTRUCTOR', max_team_size: 2 })
    );
    await repoUpdateTool.handler(
      { ...BASE, description: 'x', team_formation_mode: 'INSTRUCTOR', max_team_size: 2 },
      CTX
    );
    expect(mocks.repositoryUpdate).toHaveBeenCalledTimes(1);
  });

  it('stores an empty project template as null (web parity)', async () => {
    mocks.repositoryFindById.mockResolvedValue(
      storedRepo({ project_template_id: 'PVT_1', project_template_title: 'Board' })
    );
    await repoUpdateTool.handler(
      { ...BASE, project_template_id: '', project_template_title: '' },
      CTX
    );
    expect(mocks.repositoryUpdate.mock.calls[0][1]).toEqual({
      project_template_id: null,
      project_template_title: null,
    });
  });

  it('holds max_team_size to the web minimum of 2', () => {
    expect(repoUpdateTool.inputSchema.max_team_size.safeParse(1).success).toBe(false);
    expect(repoUpdateTool.inputSchema.max_team_size.safeParse(2).success).toBe(true);
    expect(repoUpdateTool.inputSchema.max_team_size.safeParse(null).success).toBe(true);
    expect(repoCreateTool.inputSchema.max_team_size.safeParse(1).success).toBe(false);
    expect(repoCreateTool.inputSchema.max_team_size.safeParse(2).success).toBe(true);
  });

  it('maps a row deleted before the write to not_found, with no audit row', async () => {
    mocks.repositoryUpdate.mockRejectedValue(new Error('Repository not found in classroom'));
    await expect(repoUpdateTool.handler({ ...BASE, description: 'x' }, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Repo not found in this classroom',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps a row deleted between the write and its re-read to not_found', async () => {
    mocks.repositoryUpdate.mockResolvedValue(null);
    await expect(repoUpdateTool.handler({ ...BASE, description: 'x' }, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('survives a manifest refresh that throws (write + audit already done)', async () => {
    mocks.saveManifest.mockRejectedValue(new Error('db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const payload = parse(await repoUpdateTool.handler({ ...BASE, description: 'x' }, CTX));
    expect(payload.success).toBe(true);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('has no title or weight input', () => {
    expect(repoUpdateTool.inputSchema).not.toHaveProperty('title');
    expect(repoUpdateTool.inputSchema).not.toHaveProperty('weight');
  });
});

describe('repo_create manifest refresh', () => {
  it('runs after the audit row and never fails the call', async () => {
    const order: string[] = [];
    mocks.auditCreate.mockImplementation(async () => void order.push('audit'));
    mocks.saveManifest.mockImplementation(async () => {
      order.push('manifest');
      throw new Error('db down');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const payload = parse(
      await repoCreateTool.handler(
        { classroom: 'org/cs1-w26', title: 'Lab 2', template: 't', project_template_id: '' },
        CTX
      )
    );
    expect(payload.success).toBe(true);
    expect(order).toEqual(['audit', 'manifest']);
    expect(
      (mocks.repositoryCreate.mock.calls[0][0] as { project_template_id: unknown })
        .project_template_id
    ).toBeNull();
    errorSpy.mockRestore();
  });
});

describe('repo_delete', () => {
  const ARGS = { classroom: 'org/cs1-w26', repository_id: REPO_ID, confirm: true as const };

  beforeEach(() => {
    mocks.repositoryFindById.mockResolvedValue(storedRepo());
    mocks.findDependents.mockResolvedValue(
      dependents({ module_items: 1, pages: 2 }, [
        assignmentDependent('a-1', 'Checkpoint 1', { pages: 1, calendarEventLinks: 2 }),
        assignmentDependent('a-2', 'Final', { pages: 1, slides: 3 }),
      ])
    );
    mocks.deleteIfUnprovisioned.mockResolvedValue({ status: 'deleted' });
  });

  it('deletes an unpublished empty container and reports the cascade', async () => {
    const payload = parse(await repoDeleteTool.handler(ARGS, CTX));

    expect(mocks.deleteIfUnprovisioned).toHaveBeenCalledWith(REPO_ID, 'class-1');
    const cascade = {
      module_items_removed: 1,
      page_links_removed: 2,
      slide_links_removed: 0,
      assignment_page_links_removed: 2,
      assignment_slide_links_removed: 3,
      calendar_event_links_removed: 2,
      autograding_tests_deleted: 0,
      quizzes_unlinked: 0,
    };
    expect(payload).toEqual({
      success: true,
      deleted_repository_id: REPO_ID,
      title: 'workshop',
      assignments_deleted: [
        { id: 'a-1', title: 'Checkpoint 1' },
        { id: 'a-2', title: 'Final' },
      ],
      assignments_deleted_count: 2,
      ...cascade,
    });
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      resource_type: 'REPOSITORIES',
      resource_id: REPO_ID,
      action: 'DELETE',
      data: {
        tool: 'repo_delete',
        title: 'workshop',
        assignments_deleted: [
          { id: 'a-1', title: 'Checkpoint 1' },
          { id: 'a-2', title: 'Final' },
        ],
        ...cascade,
      },
    });
    expect(mocks.saveManifest).toHaveBeenCalledWith('class-1');
  });

  it('refuses a published repo', async () => {
    mocks.repositoryFindById.mockResolvedValue(storedRepo({ is_published: true }));
    await expect(repoDeleteTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'REPO_PUBLISHED',
    });
    expect(mocks.deleteIfUnprovisioned).not.toHaveBeenCalled();
  });

  it('refuses a repo whose student/team repos exist', async () => {
    mocks.findDependents.mockResolvedValue(dependents({ git_repos: 1 }));
    await expect(repoDeleteTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'REPOS_PROVISIONED',
      message: /web app/,
    });
    expect(mocks.deleteIfUnprovisioned).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'published' }, { kind: 'invalid_params', code: 'REPO_PUBLISHED' }],
    [
      { status: 'provisioned', gitRepos: 2 },
      { kind: 'invalid_params', code: 'REPOS_PROVISIONED' },
    ],
    [{ status: 'not_found' }, { kind: 'not_found' }],
  ])(
    'refuses when the conditional delete matched nothing (%o), with no audit row',
    async (outcome, error) => {
      mocks.deleteIfUnprovisioned.mockResolvedValue(outcome);
      await expect(repoDeleteTool.handler(ARGS, CTX)).rejects.toMatchObject(error);
      expect(mocks.auditCreate).not.toHaveBeenCalled();
      expect(mocks.saveManifest).not.toHaveBeenCalled();
    }
  );

  it('propagates a delete that throws, with no audit row', async () => {
    mocks.deleteIfUnprovisioned.mockRejectedValue(new Error('connection lost'));
    await expect(repoDeleteTool.handler(ARGS, CTX)).rejects.toThrow('connection lost');
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a repository belonging to another classroom (S1)', async () => {
    mocks.repositoryFindById.mockResolvedValue(storedRepo({ classroom_id: 'other-class' }));
    await expect(repoDeleteTool.handler(ARGS, CTX)).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.findDependents).not.toHaveBeenCalled();
    expect(mocks.deleteIfUnprovisioned).not.toHaveBeenCalled();
  });

  it('is destructive and confirm-gated', () => {
    expect(repoDeleteTool.annotations).toMatchObject({ destructive: true });
    expect(repoDeleteTool.inputSchema.confirm.safeParse(false).success).toBe(false);
    expect(repoDeleteTool.inputSchema.confirm.safeParse(true).success).toBe(true);
  });
});

describe('repo tool definitions', () => {
  it('pin repo_update and repo_delete to OWNER only', () => {
    expect(repoUpdateTool.roles).toEqual(['OWNER']);
    expect(repoDeleteTool.roles).toEqual(['OWNER']);
  });

  it('keep descriptions under the 1,500 bytes a client will keep', () => {
    for (const tool of [repoCreateTool, repoUpdateTool, repoDeleteTool, repoPublishTool]) {
      expect(new TextEncoder().encode(tool.description).length, tool.name).toBeLessThan(1500);
    }
  });

  it('point tag ids at list_tags', () => {
    expect(repoCreateTool.description).toContain('list_tags');
    expect(repoUpdateTool.description).toContain('list_tags');
  });
});
