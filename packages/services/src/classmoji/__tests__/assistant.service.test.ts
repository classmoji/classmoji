/**
 * Unit tests for assistant.addAssistant / updateAssistant / removeAssistant —
 * the extracted TA logic shared by the web admin.$class.assistants action and
 * the MCP assistant tools. Prisma, the git provider, the sibling services and
 * Trigger.dev are mocked; the tests pin the idempotency short-circuit (no
 * GitHub writes when the ASSISTANT membership already exists), the server-side
 * login → profile resolution, and that both role-scoped mutations refuse to
 * touch a user who holds a different role in the classroom.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const userFindFirst = vi.fn();
const userUpsert = vi.fn();
const accountUpsert = vi.fn();
const membershipCreate = vi.fn();
vi.mock('@classmoji/database', () => ({
  default: () => ({
    user: {
      findFirst: (...a: unknown[]) => userFindFirst(...a),
      upsert: (...a: unknown[]) => userUpsert(...a),
    },
    account: { upsert: (...a: unknown[]) => accountUpsert(...a) },
    classroomMembership: { create: (...a: unknown[]) => membershipCreate(...a) },
  }),
}));

const getUserByLogin = vi.fn();
const isUserMemberOfOrganization = vi.fn();
const addTeamMember = vi.fn();
const inviteToOrganization = vi.fn();
const ensureClassroomTeam = vi.fn();
vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({
    getUserByLogin: (...a: unknown[]) => getUserByLogin(...a),
    isUserMemberOfOrganization: (...a: unknown[]) => isUserMemberOfOrganization(...a),
    addTeamMember: (...a: unknown[]) => addTeamMember(...a),
    inviteToOrganization: (...a: unknown[]) => inviteToOrganization(...a),
  }),
  ensureClassroomTeam: (...a: unknown[]) => ensureClassroomTeam(...a),
}));

const classroomFindById = vi.fn();
vi.mock('../classroom.service.ts', () => ({
  findById: (...a: unknown[]) => classroomFindById(...a),
}));

const findByClassroomAndUser = vi.fn();
const updateById = vi.fn();
vi.mock('../classroomMembership.service.ts', () => ({
  findByClassroomAndUser: (...a: unknown[]) => findByClassroomAndUser(...a),
  updateById: (...a: unknown[]) => updateById(...a),
}));

const userFindByLogin = vi.fn();
vi.mock('../user.service.ts', () => ({
  findByLogin: (...a: unknown[]) => userFindByLogin(...a),
}));

const triggerTask = vi.fn();
vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => triggerTask(...a) },
}));

const assistant = await import('../assistant.service.ts');

const CLASSROOM = {
  id: 'class-1',
  slug: 'cs1-25f',
  git_organization: { id: 'org-1', login: 'cs1-org', provider: 'GITHUB' },
};

beforeEach(() => {
  vi.clearAllMocks();
  classroomFindById.mockResolvedValue(CLASSROOM);
  ensureClassroomTeam.mockResolvedValue({ id: 42, slug: 'cs1-25f-assistants' });
  getUserByLogin.mockResolvedValue({ id: 999, login: 'ada', name: 'Ada L', email: 'ada@gh.dev' });
  isUserMemberOfOrganization.mockResolvedValue(false);
  userFindFirst.mockResolvedValue(null);
  userUpsert.mockResolvedValue({ id: 'u-1', login: 'ada', name: 'Ada L' });
  triggerTask.mockResolvedValue({ id: 'run-1' });
});

describe('assistant.addAssistant', () => {
  it('resolves the git profile server-side, invites, and creates the membership', async () => {
    const result = await assistant.addAssistant({
      classroomId: 'class-1',
      login: '@ada',
      name: 'Ada Lovelace',
      email: 'ada@school.edu',
    });

    // The '@' is stripped and the profile comes from the provider, not the caller.
    expect(getUserByLogin).toHaveBeenCalledWith('ada');
    expect(inviteToOrganization).toHaveBeenCalledWith('cs1-org', '999', [42]);
    expect(addTeamMember).not.toHaveBeenCalled();

    // Instructor-supplied name/email win; the git profile fills provider_email.
    expect(userUpsert.mock.calls[0][0].create).toMatchObject({
      login: 'ada',
      name: 'Ada Lovelace',
      email: 'ada@school.edu',
      provider_email: 'ada@gh.dev',
      provider_id: '999',
    });
    expect(membershipCreate).toHaveBeenCalledWith({
      data: { classroom_id: 'class-1', user_id: 'u-1', role: 'ASSISTANT' },
    });

    // Not already in the org → no activate_membership (the webhook does it).
    expect(triggerTask).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: true, alreadyExists: false, userId: 'u-1' });
  });

  it('adds already-org-members to the team and activates them instead of inviting', async () => {
    isUserMemberOfOrganization.mockResolvedValue(true);

    const result = await assistant.addAssistant({ classroomId: 'class-1', login: 'ada' });

    expect(addTeamMember).toHaveBeenCalledWith('cs1-org', 'cs1-25f-assistants', 'ada');
    expect(inviteToOrganization).not.toHaveBeenCalled();
    expect(triggerTask).toHaveBeenCalledWith('activate_membership', {
      login: 'ada',
      gitOrganizationId: 'org-1',
    });
    expect(result.alreadyOrgMember).toBe(true);
  });

  it('is idempotent: an existing ASSISTANT membership short-circuits before any GitHub write', async () => {
    userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada', name: 'Ada L' });
    findByClassroomAndUser.mockResolvedValue({ id: 'm-1', role: 'ASSISTANT' });

    const result = await assistant.addAssistant({ classroomId: 'class-1', login: 'ada' });

    expect(result).toMatchObject({ created: false, alreadyExists: true, userId: 'u-1' });
    expect(getUserByLogin).not.toHaveBeenCalled();
    expect(ensureClassroomTeam).not.toHaveBeenCalled();
    expect(inviteToOrganization).not.toHaveBeenCalled();
    expect(membershipCreate).not.toHaveBeenCalled();
  });

  it('matches the stored login case-insensitively', async () => {
    userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada', name: 'Ada L' });
    findByClassroomAndUser.mockResolvedValue({ id: 'm-1', role: 'ASSISTANT' });

    await assistant.addAssistant({ classroomId: 'class-1', login: 'Ada' });

    expect(userFindFirst.mock.calls[0][0].where).toEqual({
      login: { equals: 'Ada', mode: 'insensitive' },
    });
  });

  it('leaves an existing user record untouched: the upsert update branch is empty', async () => {
    await assistant.addAssistant({ classroomId: 'class-1', login: 'ada', name: 'Ada Lovelace' });

    // Adding an assistant must not rewrite any field of a user row that already
    // exists — every value the service supplies belongs to `create` only.
    expect(userUpsert.mock.calls[0][0].update).toEqual({});
  });

  it('re-checks with the canonical casing after resolution and skips the GitHub writes', async () => {
    // The caller typed 'Ada'; nothing matches until the provider hands back the
    // canonical 'ada', which the second lookup finds with a live membership.
    getUserByLogin.mockResolvedValue({ id: 999, login: 'ada', name: 'Ada L' });
    userFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'u-1',
      login: 'ada',
      name: 'Ada L',
      provider_id: '999',
    });
    findByClassroomAndUser.mockResolvedValue({ id: 'm-1', role: 'ASSISTANT' });

    const result = await assistant.addAssistant({ classroomId: 'class-1', login: 'Ada' });

    expect(result).toMatchObject({ created: false, alreadyExists: true, userId: 'u-1' });
    // Resolution itself is required (it is what yields the canonical casing),
    // but nothing may be written to GitHub afterwards.
    expect(getUserByLogin).toHaveBeenCalledWith('Ada');
    expect(ensureClassroomTeam).not.toHaveBeenCalled();
    expect(addTeamMember).not.toHaveBeenCalled();
    expect(inviteToOrganization).not.toHaveBeenCalled();
    expect(membershipCreate).not.toHaveBeenCalled();
  });

  it('refuses when the stored row is keyed to a different provider account', async () => {
    userFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'u-1',
      login: 'ada',
      name: 'Ada L',
      provider_id: '111',
    });

    await expect(
      assistant.addAssistant({ classroomId: 'class-1', login: 'ada' })
    ).rejects.toMatchObject({ code: 'login_conflict' });
    expect(ensureClassroomTeam).not.toHaveBeenCalled();
    expect(userUpsert).not.toHaveBeenCalled();
  });

  it('maps only a 404 to git_user_not_found and propagates everything else', async () => {
    const rateLimited = Object.assign(new Error('API rate limit exceeded'), { status: 403 });
    getUserByLogin.mockRejectedValue(rateLimited);

    await expect(assistant.addAssistant({ classroomId: 'class-1', login: 'ada' })).rejects.toThrow(
      'API rate limit exceeded'
    );
    expect(ensureClassroomTeam).not.toHaveBeenCalled();

    getUserByLogin.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    await expect(
      assistant.addAssistant({ classroomId: 'class-1', login: 'ada' })
    ).rejects.toMatchObject({ code: 'git_user_not_found' });
  });

  it('reports already-exists when the membership row turns up on create', async () => {
    membershipCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    const result = await assistant.addAssistant({ classroomId: 'class-1', login: 'ada' });

    expect(result).toMatchObject({ created: false, alreadyExists: true, userId: 'u-1' });
  });
});

describe('assistant.updateAssistant', () => {
  it('updates the ASSISTANT membership row specifically', async () => {
    userFindByLogin.mockResolvedValue({ id: 'u-1', login: 'ada' });
    findByClassroomAndUser.mockResolvedValue({ id: 'm-1', role: 'ASSISTANT' });

    await assistant.updateAssistant({ classroomId: 'class-1', login: 'ada', isGrader: true });

    // Role-scoped lookup — a multi-role user must not have another row updated.
    expect(findByClassroomAndUser).toHaveBeenCalledWith('class-1', 'u-1', 'ASSISTANT');
    expect(updateById).toHaveBeenCalledWith('m-1', { is_grader: true });
  });

  it('throws when the user holds no ASSISTANT membership here', async () => {
    userFindByLogin.mockResolvedValue({ id: 'u-1', login: 'ada' });
    findByClassroomAndUser.mockResolvedValue(null);

    await expect(
      assistant.updateAssistant({ classroomId: 'class-1', login: 'ada', isGrader: true })
    ).rejects.toThrow(/not an assistant/);
    expect(updateById).not.toHaveBeenCalled();
  });
});

describe('assistant.removeAssistant', () => {
  it('builds the task payload from DB records and returns the run handle', async () => {
    userFindByLogin.mockResolvedValue({ id: 'u-1', login: 'ada' });
    findByClassroomAndUser.mockResolvedValue({ id: 'm-1', has_accepted_invite: true });

    const result = await assistant.removeAssistant({ classroomId: 'class-1', login: 'ada' });

    expect(triggerTask).toHaveBeenCalledWith('remove_user_from_organization', {
      payload: {
        // has_accepted_invite comes from the MEMBERSHIP, not the user record.
        user: { id: 'u-1', login: 'ada', has_accepted_invite: true },
        gitOrganization: CLASSROOM.git_organization,
        classroom: CLASSROOM,
        role: 'ASSISTANT',
      },
    });
    expect(result).toEqual({ userId: 'u-1', login: 'ada', runId: 'run-1' });
  });

  it('refuses to remove a user who is not an ASSISTANT in this classroom', async () => {
    userFindByLogin.mockResolvedValue({ id: 'u-1', login: 'ada' });
    findByClassroomAndUser.mockResolvedValue(null);

    await expect(
      assistant.removeAssistant({ classroomId: 'class-1', login: 'ada' })
    ).rejects.toThrow(/not an assistant/);
    expect(triggerTask).not.toHaveBeenCalled();
  });
});
