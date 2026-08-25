/**
 * Unit tests for teamAdmin — the team management logic extracted from the web
 * admin.$class.teams* actions so the MCP team tools can share it.
 *
 * Prisma, the git provider, the sibling services and the throttle are mocked.
 * The tests pin the two invariants the extraction exists to establish: every
 * mutation resolves its team through the classroom BEFORE anything reaches the
 * provider, and every bulk operation reports its per-item failures instead of
 * swallowing them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const teamFindFirst = vi.fn();
const tagFindMany = vi.fn();
const teamTagFindFirst = vi.fn();
const userFindFirst = vi.fn();
vi.mock('@classmoji/database', () => ({
  default: () => ({
    team: { findFirst: (...a: unknown[]) => teamFindFirst(...a) },
    tag: { findMany: (...a: unknown[]) => tagFindMany(...a) },
    teamTag: { findFirst: (...a: unknown[]) => teamTagFindFirst(...a) },
    user: { findFirst: (...a: unknown[]) => userFindFirst(...a) },
  }),
}));

const getTeam = vi.fn();
const createTeam = vi.fn();
const deleteTeam = vi.fn();
const updateTeam = vi.fn();
const updateRepo = vi.fn();
const addTeamMember = vi.fn();
const removeTeamMember = vi.fn();
vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({
    getTeam: (...a: unknown[]) => getTeam(...a),
    createTeam: (...a: unknown[]) => createTeam(...a),
    deleteTeam: (...a: unknown[]) => deleteTeam(...a),
    updateTeam: (...a: unknown[]) => updateTeam(...a),
    updateRepo: (...a: unknown[]) => updateRepo(...a),
    addTeamMember: (...a: unknown[]) => addTeamMember(...a),
    removeTeamMember: (...a: unknown[]) => removeTeamMember(...a),
  }),
}));

// Real timers would make every queued test wait 250ms per item.
vi.mock('../sleep.ts', () => ({ sleep: vi.fn(async () => {}) }));

const classroomFindById = vi.fn();
vi.mock('../classroom.service.ts', () => ({
  findById: (...a: unknown[]) => classroomFindById(...a),
}));

const teamCreate = vi.fn();
const teamDeleteBySlug = vi.fn();
const teamFindBySlug = vi.fn();
const teamFindByIdWithRepositories = vi.fn();
const teamRenameAndRepos = vi.fn();
vi.mock('../team.service.ts', () => ({
  create: (...a: unknown[]) => teamCreate(...a),
  deleteBySlug: (...a: unknown[]) => teamDeleteBySlug(...a),
  findBySlugAndClassroomId: (...a: unknown[]) => teamFindBySlug(...a),
  findByIdWithRepositories: (...a: unknown[]) => teamFindByIdWithRepositories(...a),
  renameAndRepos: (...a: unknown[]) => teamRenameAndRepos(...a),
}));

const addMemberToTeam = vi.fn();
const removeMemberFromTeam = vi.fn();
vi.mock('../teamMembership.service.ts', () => ({
  addMemberToTeam: (...a: unknown[]) => addMemberToTeam(...a),
  removeMemberFromTeam: (...a: unknown[]) => removeMemberFromTeam(...a),
}));

const teamTagCreate = vi.fn();
const teamTagDelete = vi.fn();
vi.mock('../teamTag.service.ts', () => ({
  create: (...a: unknown[]) => teamTagCreate(...a),
  delete: (...a: unknown[]) => teamTagDelete(...a),
}));

const teamAdmin = await import('../teamAdmin.service.ts');
const { TeamServiceError } = teamAdmin;

const CLASSROOM = {
  id: 'class-1',
  slug: 'cs1-25f',
  git_organization: { id: 'org-1', login: 'cs1-org', provider: 'GITHUB' },
};

const TEAM = {
  id: 'team-1',
  name: 'Blue Team',
  slug: 'blue-team',
  is_visible: false,
  classroom_id: 'class-1',
};

const notFound = (message = 'Not Found') => Object.assign(new Error(message), { status: 404 });

beforeEach(() => {
  vi.clearAllMocks();
  classroomFindById.mockResolvedValue(CLASSROOM);
  teamFindFirst.mockResolvedValue(TEAM);
  teamFindBySlug.mockResolvedValue(null);
  teamFindByIdWithRepositories.mockResolvedValue({ git_repos: [] });
  tagFindMany.mockResolvedValue([]);
  getTeam.mockRejectedValue(notFound());
  createTeam.mockResolvedValue({ id: 7, slug: 'blue-team', name: 'Blue Team' });
  teamCreate.mockResolvedValue(TEAM);
  removeMemberFromTeam.mockResolvedValue({ count: 1 });
});

describe('teamAdmin.createTeam', () => {
  it('creates on the provider then locally, wiring is_visible through honestly', async () => {
    const result = await teamAdmin.createTeam({
      classroomId: 'class-1',
      name: '  Blue Team  ',
      isVisible: true,
    });

    expect(createTeam).toHaveBeenCalledWith('cs1-org', 'Blue Team');
    expect(teamCreate).toHaveBeenCalledWith({
      providerId: 7,
      provider: 'GITHUB',
      name: 'Blue Team',
      slug: 'blue-team',
      classroomId: 'class-1',
      isVisible: true,
    });
    expect(result.team).toEqual({
      id: 'team-1',
      name: 'Blue Team',
      slug: 'blue-team',
      isVisible: false,
    });
  });

  it('defaults is_visible to false rather than always storing a visible team', async () => {
    await teamAdmin.createTeam({ classroomId: 'class-1', name: 'Blue Team' });

    expect(teamCreate.mock.calls[0][0]).toMatchObject({ isVisible: false });
  });

  it('refuses a name whose slug would collide with the classroom teams', async () => {
    for (const name of ['cs1 25f students', 'CS1-25F-Assistants']) {
      await expect(teamAdmin.createTeam({ classroomId: 'class-1', name })).rejects.toMatchObject({
        code: 'reserved_name',
      });
    }
    expect(getTeam).not.toHaveBeenCalled();
    expect(createTeam).not.toHaveBeenCalled();
  });

  it('rejects an empty name before anything else runs', async () => {
    await expect(
      teamAdmin.createTeam({ classroomId: 'class-1', name: '   ' })
    ).rejects.toMatchObject({ code: 'invalid_name' });
    expect(classroomFindById).not.toHaveBeenCalled();
  });

  it('refuses when the provider already has a team on the predicted slug', async () => {
    getTeam.mockResolvedValue({ id: 3, slug: 'blue-team', name: 'Blue Team' });

    await expect(
      teamAdmin.createTeam({ classroomId: 'class-1', name: 'Blue Team' })
    ).rejects.toMatchObject({ code: 'name_collision' });
    expect(createTeam).not.toHaveBeenCalled();
  });

  it('propagates a non-404 collision-check failure instead of reading it as "name taken"', async () => {
    getTeam.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 403 }));

    await expect(
      teamAdmin.createTeam({ classroomId: 'class-1', name: 'Blue Team' })
    ).rejects.toThrow('rate limited');
    expect(createTeam).not.toHaveBeenCalled();
  });

  it('validates tag ids against the classroom before the provider write and reports the rest', async () => {
    tagFindMany.mockResolvedValue([{ id: 'tag-ok' }]);

    const result = await teamAdmin.createTeam({
      classroomId: 'class-1',
      name: 'Blue Team',
      tagIds: ['tag-ok', 'tag-elsewhere'],
    });

    expect(tagFindMany.mock.calls[0][0].where).toEqual({
      id: { in: ['tag-ok', 'tag-elsewhere'] },
      classroom_id: 'class-1',
    });
    // The out-of-classroom id never reaches a write.
    expect(teamTagCreate).toHaveBeenCalledTimes(1);
    expect(teamTagCreate).toHaveBeenCalledWith('team-1', 'tag-ok');
    expect(result.tagsAdded).toEqual(['tag-ok']);
    expect(result.tagsFailed).toEqual([
      { tagId: 'tag-elsewhere', error: 'Tag does not belong to this classroom' },
    ]);
  });

  it('reports a failing tag without losing the tags after it', async () => {
    tagFindMany.mockResolvedValue([{ id: 'tag-a' }, { id: 'tag-b' }]);
    teamTagCreate.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ id: 'tt-2' });

    const result = await teamAdmin.createTeam({
      classroomId: 'class-1',
      name: 'Blue Team',
      tagIds: ['tag-a', 'tag-b'],
    });

    expect(result.tagsAdded).toEqual(['tag-b']);
    expect(result.tagsFailed).toEqual([{ tagId: 'tag-a', error: 'boom' }]);
  });

  it('throws no_org_configured when the classroom has no git organization', async () => {
    classroomFindById.mockResolvedValue({ ...CLASSROOM, git_organization: null });

    await expect(
      teamAdmin.createTeam({ classroomId: 'class-1', name: 'Blue Team' })
    ).rejects.toMatchObject({ code: 'no_org_configured' });
  });
});

describe('teamAdmin.deleteTeam', () => {
  it('deletes on the provider and locally once the local row resolves', async () => {
    const result = await teamAdmin.deleteTeam({ classroomId: 'class-1', slugOrId: 'blue-team' });

    expect(deleteTeam).toHaveBeenCalledWith('cs1-org', 'blue-team');
    expect(teamDeleteBySlug).toHaveBeenCalledWith('class-1', 'blue-team');
    expect(result).toEqual({
      id: 'team-1',
      name: 'Blue Team',
      slug: 'blue-team',
      removedFromProvider: true,
    });
  });

  it('resolves first: an unknown slug is rejected with ZERO provider calls', async () => {
    teamFindFirst.mockResolvedValue(null);

    await expect(
      teamAdmin.deleteTeam({ classroomId: 'class-1', slugOrId: 'cs1-25f-students' })
    ).rejects.toMatchObject({ code: 'team_not_found' });

    expect(deleteTeam).not.toHaveBeenCalled();
    expect(teamDeleteBySlug).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the classroom, by slug or id', async () => {
    await teamAdmin.deleteTeam({ classroomId: 'class-1', slugOrId: 'blue-team' });

    expect(teamFindFirst.mock.calls[0][0].where).toEqual({
      classroom_id: 'class-1',
      OR: [{ slug: 'blue-team' }, { id: 'blue-team' }],
    });
  });

  it('tolerates a provider 404 and still removes the local row', async () => {
    deleteTeam.mockRejectedValue(notFound());

    const result = await teamAdmin.deleteTeam({ classroomId: 'class-1', slugOrId: 'blue-team' });

    expect(teamDeleteBySlug).toHaveBeenCalledWith('class-1', 'blue-team');
    expect(result.removedFromProvider).toBe(false);
  });

  it('propagates a non-404 provider failure and leaves the local row alone', async () => {
    deleteTeam.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));

    await expect(
      teamAdmin.deleteTeam({ classroomId: 'class-1', slugOrId: 'blue-team' })
    ).rejects.toThrow('forbidden');
    expect(teamDeleteBySlug).not.toHaveBeenCalled();
  });
});

describe('teamAdmin.renameTeam', () => {
  beforeEach(() => {
    updateTeam.mockResolvedValue({ id: 7, slug: 'green-team', name: 'Green Team' });
  });

  it('runs the local collision check BEFORE the provider rename', async () => {
    teamFindBySlug.mockResolvedValue({ id: 'other-team', slug: 'green-team' });

    await expect(
      teamAdmin.renameTeam({ classroomId: 'class-1', slugOrId: 'blue-team', newName: 'Green Team' })
    ).rejects.toMatchObject({ code: 'name_collision' });

    // The predicted slug is what catches it — GitHub is never asked to rename.
    expect(teamFindBySlug).toHaveBeenCalledWith('green-team', 'class-1');
    expect(updateTeam).not.toHaveBeenCalled();
  });

  it('still checks the slug GitHub actually returns', async () => {
    // Predicted 'green-team' is free; GitHub hands back 'green-team-2', taken.
    updateTeam.mockResolvedValue({ id: 7, slug: 'green-team-2', name: 'Green Team' });
    teamFindBySlug.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'other-team' });

    await expect(
      teamAdmin.renameTeam({ classroomId: 'class-1', slugOrId: 'blue-team', newName: 'Green Team' })
    ).rejects.toMatchObject({ code: 'name_collision' });
    expect(teamRenameAndRepos).not.toHaveBeenCalled();
  });

  it('refuses a non-GitHub organization before resolving anything', async () => {
    classroomFindById.mockResolvedValue({
      ...CLASSROOM,
      git_organization: { ...CLASSROOM.git_organization, provider: 'GITLAB' },
    });

    await expect(
      teamAdmin.renameTeam({ classroomId: 'class-1', slugOrId: 'blue-team', newName: 'Green Team' })
    ).rejects.toMatchObject({ code: 'provider_unsupported' });
    expect(updateTeam).not.toHaveBeenCalled();
  });

  it('rejects an unknown team with no provider call', async () => {
    teamFindFirst.mockResolvedValue(null);

    await expect(
      teamAdmin.renameTeam({ classroomId: 'class-1', slugOrId: 'nope', newName: 'Green Team' })
    ).rejects.toMatchObject({ code: 'team_not_found' });
    expect(updateTeam).not.toHaveBeenCalled();
  });

  it('cascades the new slug onto matching repos and persists only the successes', async () => {
    teamFindByIdWithRepositories.mockResolvedValue({
      git_repos: [
        { id: 'r1', name: 'hw1-blue-team' },
        { id: 'r2', name: 'hw2-blue-team' },
        { id: 'r3', name: 'unrelated-repo' },
      ],
    });
    updateRepo.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('repo is archived'));

    const result = await teamAdmin.renameTeam({
      classroomId: 'class-1',
      slugOrId: 'blue-team',
      newName: 'Green Team',
    });

    // The unrelated repo is skipped, so only two provider calls happen.
    expect(updateRepo).toHaveBeenCalledTimes(2);
    expect(updateRepo).toHaveBeenNthCalledWith(1, 'cs1-org', 'hw1-blue-team', {
      name: 'hw1-green-team',
    });

    // A failed repo must not be written to the DB as if it had been renamed.
    expect(teamRenameAndRepos).toHaveBeenCalledWith({
      teamId: 'team-1',
      newName: 'Green Team',
      newSlug: 'green-team',
      repoRenames: [{ id: 'r1', name: 'hw1-green-team' }],
    });
    expect(result.renamedRepos).toEqual(['hw1-green-team']);
    expect(result.failed).toEqual([{ name: 'hw2-blue-team', error: 'repo is archived' }]);
  });

  it('rejects renaming onto a reserved classroom-team name', async () => {
    await expect(
      teamAdmin.renameTeam({
        classroomId: 'class-1',
        slugOrId: 'blue-team',
        newName: 'cs1 25f students',
      })
    ).rejects.toMatchObject({ code: 'reserved_name' });
    expect(updateTeam).not.toHaveBeenCalled();
  });

  it('rejects an empty new name', async () => {
    await expect(
      teamAdmin.renameTeam({ classroomId: 'class-1', slugOrId: 'blue-team', newName: '  ' })
    ).rejects.toMatchObject({ code: 'invalid_name' });
  });
});

describe('teamAdmin.addTeamMembers', () => {
  it('adds each login to the provider team and the local membership', async () => {
    userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada' });

    const result = await teamAdmin.addTeamMembers({
      classroomId: 'class-1',
      slugOrId: 'blue-team',
      logins: ['ada'],
    });

    expect(addTeamMember).toHaveBeenCalledWith('cs1-org', 'blue-team', 'ada');
    expect(addMemberToTeam).toHaveBeenCalledWith('team-1', 'u-1');
    expect(result).toEqual({ succeeded: [{ login: 'ada' }], failed: [] });
  });

  it('reports per-member failures instead of swallowing them, and keeps going', async () => {
    userFindFirst
      .mockResolvedValueOnce({ id: 'u-1', login: 'ada' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'u-3', login: 'grace' });
    addTeamMember.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('not in org'));

    const result = await teamAdmin.addTeamMembers({
      classroomId: 'class-1',
      slugOrId: 'blue-team',
      logins: ['ada', 'ghost', 'grace'],
    });

    expect(result.succeeded).toEqual([{ login: 'ada' }]);
    expect(result.failed).toEqual([
      { login: 'ghost', error: 'No user with that login' },
      { login: 'grace', error: 'not in org' },
    ]);
    // The membership row is only written when the provider call succeeded.
    expect(addMemberToTeam).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown team with no provider call', async () => {
    teamFindFirst.mockResolvedValue(null);

    await expect(
      teamAdmin.addTeamMembers({ classroomId: 'class-1', slugOrId: 'nope', logins: ['ada'] })
    ).rejects.toMatchObject({ code: 'team_not_found' });
    expect(addTeamMember).not.toHaveBeenCalled();
  });
});

describe('teamAdmin.removeTeamMember', () => {
  it('resolves the user BEFORE the provider removal', async () => {
    userFindFirst.mockResolvedValue(null);

    await expect(
      teamAdmin.removeTeamMember({ classroomId: 'class-1', slugOrId: 'blue-team', login: 'ghost' })
    ).rejects.toMatchObject({ code: 'user_not_found' });
    expect(removeTeamMember).not.toHaveBeenCalled();
  });

  it('is idempotent when the membership row is already gone', async () => {
    userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada' });
    removeMemberFromTeam.mockResolvedValue({ count: 0 });

    const result = await teamAdmin.removeTeamMember({
      classroomId: 'class-1',
      slugOrId: 'blue-team',
      login: 'ada',
    });

    expect(removeTeamMember).toHaveBeenCalledWith('cs1-org', 'blue-team', 'ada');
    expect(result).toEqual({ teamId: 'team-1', login: 'ada', removed: false });
  });

  it('uses the stored login casing for the provider call', async () => {
    userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada' });

    await teamAdmin.removeTeamMember({
      classroomId: 'class-1',
      slugOrId: 'blue-team',
      login: 'Ada',
    });

    expect(userFindFirst.mock.calls[0][0].where).toEqual({
      login: { equals: 'Ada', mode: 'insensitive' },
    });
    expect(removeTeamMember).toHaveBeenCalledWith('cs1-org', 'blue-team', 'ada');
  });
});

describe('teamAdmin.addTeamTags', () => {
  it('resolves the team through the classroom rather than trusting a caller id', async () => {
    tagFindMany.mockResolvedValue([{ id: 'tag-ok' }]);

    await teamAdmin.addTeamTags({
      classroomId: 'class-1',
      slugOrId: 'blue-team',
      tagIds: ['tag-ok'],
    });

    expect(teamFindFirst.mock.calls[0][0].where.classroom_id).toBe('class-1');
    expect(teamTagCreate).toHaveBeenCalledWith('team-1', 'tag-ok');
  });

  it('rejects a tag id from another classroom and still attaches the valid ones', async () => {
    tagFindMany.mockResolvedValue([{ id: 'tag-ok' }]);

    const result = await teamAdmin.addTeamTags({
      classroomId: 'class-1',
      slugOrId: 'blue-team',
      tagIds: ['tag-ok', 'tag-elsewhere'],
    });

    expect(teamTagCreate).toHaveBeenCalledTimes(1);
    expect(result.added).toEqual(['tag-ok']);
    expect(result.failed).toEqual([
      { tagId: 'tag-elsewhere', error: 'Tag does not belong to this classroom' },
    ]);
  });

  it('treats an already-attached tag as added', async () => {
    tagFindMany.mockResolvedValue([{ id: 'tag-ok' }]);
    teamTagCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    const result = await teamAdmin.addTeamTags({
      classroomId: 'class-1',
      slugOrId: 'blue-team',
      tagIds: ['tag-ok'],
    });

    expect(result).toEqual({ added: ['tag-ok'], failed: [] });
  });

  it('rejects an unknown team', async () => {
    teamFindFirst.mockResolvedValue(null);

    await expect(
      teamAdmin.addTeamTags({ classroomId: 'class-1', slugOrId: 'nope', tagIds: ['tag-ok'] })
    ).rejects.toMatchObject({ code: 'team_not_found' });
    expect(teamTagCreate).not.toHaveBeenCalled();
  });
});

describe('teamAdmin.removeTeamTag', () => {
  it('resolves the TeamTag row through its team classroom before deleting', async () => {
    teamTagFindFirst.mockResolvedValue({ id: 'tt-1', team_id: 'team-1', tag_id: 'tag-1' });

    const result = await teamAdmin.removeTeamTag({ classroomId: 'class-1', teamTagId: 'tt-1' });

    expect(teamTagFindFirst.mock.calls[0][0].where).toEqual({
      id: 'tt-1',
      team: { classroom_id: 'class-1' },
    });
    expect(teamTagDelete).toHaveBeenCalledWith('tt-1');
    expect(result).toEqual({ teamTagId: 'tt-1', teamId: 'team-1', tagId: 'tag-1' });
  });

  it('does not delete a TeamTag that lives in another classroom', async () => {
    teamTagFindFirst.mockResolvedValue(null);

    await expect(
      teamAdmin.removeTeamTag({ classroomId: 'class-1', teamTagId: 'tt-elsewhere' })
    ).rejects.toMatchObject({ code: 'tag_not_found' });
    expect(teamTagDelete).not.toHaveBeenCalled();
  });
});

describe('TeamServiceError', () => {
  it('carries a code callers can switch on', () => {
    const error = new TeamServiceError('team_not_found', 'nope');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TeamServiceError');
    expect(error.code).toBe('team_not_found');
  });
});
