/**
 * Unit tests for staff.addStaff / updateStaff / removeStaff — the teaching-staff
 * logic shared by the web admin.$class.assistants action (ASSISTANT only) and
 * the MCP staff tools (ASSISTANT / TEACHER / OWNER). Prisma, the git provider,
 * the sibling services and Trigger.dev are mocked; the tests pin the per-role
 * idempotency short-circuit (no GitHub writes when a membership at the
 * REQUESTED role already exists), the server-side login → profile resolution,
 * that every mutation is scoped to the requested role so a multi-role user
 * keeps their other rows, and that removing the last owner is refused BEFORE
 * anything is queued.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const userFindFirst = vi.fn();
const userUpsert = vi.fn();
const accountUpsert = vi.fn();
const membershipCreate = vi.fn();
const membershipCount = vi.fn();
vi.mock('@classmoji/database', () => ({
  default: () => ({
    user: {
      findFirst: (...a: unknown[]) => userFindFirst(...a),
      upsert: (...a: unknown[]) => userUpsert(...a),
    },
    account: { upsert: (...a: unknown[]) => accountUpsert(...a) },
    classroomMembership: {
      create: (...a: unknown[]) => membershipCreate(...a),
      count: (...a: unknown[]) => membershipCount(...a),
    },
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

const triggerTask = vi.fn();
vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => triggerTask(...a) },
}));

const staff = await import('../staff.service.ts');

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
  membershipCount.mockResolvedValue(2);
});

describe('staff.addStaff', () => {
  it('resolves the git profile server-side, invites, and creates the membership', async () => {
    const result = await staff.addStaff({
      classroomId: 'class-1',
      login: '@ada',
      role: 'ASSISTANT',
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
    expect(result).toMatchObject({
      created: true,
      alreadyExists: false,
      userId: 'u-1',
      role: 'ASSISTANT',
    });
  });

  it.each(['ASSISTANT', 'TEACHER', 'OWNER'] as const)(
    'creates the membership at the requested role (%s) in the shared staff team',
    async role => {
      const result = await staff.addStaff({ classroomId: 'class-1', login: 'ada', role });

      expect(membershipCreate).toHaveBeenCalledWith({
        data: { classroom_id: 'class-1', user_id: 'u-1', role },
      });
      // Every non-student role shares ONE GitHub staff team: the role is passed
      // straight through to ensureClassroomTeam, which maps all of them to the
      // single `{slug}-assistants` team the invite/team-add then targets.
      expect(ensureClassroomTeam).toHaveBeenCalledWith(
        expect.anything(),
        'cs1-org',
        CLASSROOM,
        role
      );
      expect(inviteToOrganization).toHaveBeenCalledWith('cs1-org', '999', [42]);
      expect(result).toMatchObject({ created: true, role });
    }
  );

  it('grants an ADDITIONAL role to someone who already holds a different one', async () => {
    // Ada is already an ASSISTANT here. The role-scoped pre-check asks only
    // about TEACHER, finds nothing, and the add proceeds.
    userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada', name: 'Ada L' });
    findByClassroomAndUser.mockResolvedValue(null);

    const result = await staff.addStaff({ classroomId: 'class-1', login: 'ada', role: 'TEACHER' });

    // Only TEACHER was ever looked up — the existing ASSISTANT row is never
    // read, updated or deleted; a NEW row is created beside it.
    for (const call of findByClassroomAndUser.mock.calls) {
      expect(call[2]).toBe('TEACHER');
    }
    expect(membershipCreate).toHaveBeenCalledWith({
      data: { classroom_id: 'class-1', user_id: 'u-1', role: 'TEACHER' },
    });
    expect(updateById).not.toHaveBeenCalled();
    // The user record itself is left alone too.
    expect(userUpsert.mock.calls[0][0].update).toEqual({});
    expect(result).toMatchObject({ created: true, alreadyExists: false, role: 'TEACHER' });
  });

  it('adds already-org-members to the team and activates them instead of inviting', async () => {
    isUserMemberOfOrganization.mockResolvedValue(true);

    const result = await staff.addStaff({
      classroomId: 'class-1',
      login: 'ada',
      role: 'ASSISTANT',
    });

    expect(addTeamMember).toHaveBeenCalledWith('cs1-org', 'cs1-25f-assistants', 'ada');
    expect(inviteToOrganization).not.toHaveBeenCalled();
    expect(triggerTask).toHaveBeenCalledWith('activate_membership', {
      login: 'ada',
      gitOrganizationId: 'org-1',
    });
    expect(result.alreadyOrgMember).toBe(true);
  });

  it.each(['ASSISTANT', 'TEACHER', 'OWNER'] as const)(
    'is idempotent per role: an existing %s membership short-circuits before any GitHub write',
    async role => {
      userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada', name: 'Ada L' });
      findByClassroomAndUser.mockResolvedValue({ id: 'm-1', role });

      const result = await staff.addStaff({ classroomId: 'class-1', login: 'ada', role });

      expect(findByClassroomAndUser).toHaveBeenCalledWith('class-1', 'u-1', role);
      expect(result).toMatchObject({ created: false, alreadyExists: true, userId: 'u-1', role });
      expect(getUserByLogin).not.toHaveBeenCalled();
      expect(ensureClassroomTeam).not.toHaveBeenCalled();
      expect(inviteToOrganization).not.toHaveBeenCalled();
      expect(membershipCreate).not.toHaveBeenCalled();
    }
  );

  it('matches the stored login case-insensitively', async () => {
    userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada', name: 'Ada L' });
    findByClassroomAndUser.mockResolvedValue({ id: 'm-1', role: 'ASSISTANT' });

    await staff.addStaff({ classroomId: 'class-1', login: 'Ada', role: 'ASSISTANT' });

    expect(userFindFirst.mock.calls[0][0].where).toEqual({
      login: { equals: 'Ada', mode: 'insensitive' },
    });
  });

  it('leaves an existing user record untouched: the upsert update branch is empty', async () => {
    await staff.addStaff({
      classroomId: 'class-1',
      login: 'ada',
      role: 'ASSISTANT',
      name: 'Ada Lovelace',
    });

    // Adding someone as staff must not rewrite any field of a user row that
    // already exists — every value the service supplies belongs to `create` only.
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

    const result = await staff.addStaff({
      classroomId: 'class-1',
      login: 'Ada',
      role: 'ASSISTANT',
    });

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
      staff.addStaff({ classroomId: 'class-1', login: 'ada', role: 'ASSISTANT' })
    ).rejects.toMatchObject({ code: 'login_conflict' });
    expect(ensureClassroomTeam).not.toHaveBeenCalled();
    expect(userUpsert).not.toHaveBeenCalled();
  });

  it('maps only a 404 to git_user_not_found and propagates everything else', async () => {
    const rateLimited = Object.assign(new Error('API rate limit exceeded'), { status: 403 });
    getUserByLogin.mockRejectedValue(rateLimited);

    await expect(
      staff.addStaff({ classroomId: 'class-1', login: 'ada', role: 'ASSISTANT' })
    ).rejects.toThrow('API rate limit exceeded');
    expect(ensureClassroomTeam).not.toHaveBeenCalled();

    getUserByLogin.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    await expect(
      staff.addStaff({ classroomId: 'class-1', login: 'ada', role: 'ASSISTANT' })
    ).rejects.toMatchObject({ code: 'git_user_not_found' });
  });

  it('reports already-exists when the membership row turns up on create', async () => {
    membershipCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    const result = await staff.addStaff({
      classroomId: 'class-1',
      login: 'ada',
      role: 'ASSISTANT',
    });

    expect(result).toMatchObject({ created: false, alreadyExists: true, userId: 'u-1' });
  });
});

describe('staff.updateStaff', () => {
  it.each(['ASSISTANT', 'TEACHER'] as const)(
    'updates the %s membership row specifically',
    async role => {
      userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada' });
      findByClassroomAndUser.mockResolvedValue({ id: 'm-1', role });

      await staff.updateStaff({ classroomId: 'class-1', login: 'ada', role, isGrader: true });

      // Role-scoped lookup — a multi-role user must not have another row updated.
      expect(findByClassroomAndUser).toHaveBeenCalledWith('class-1', 'u-1', role);
      expect(updateById).toHaveBeenCalledWith('m-1', { is_grader: true });
    }
  );

  it('refuses is_grader on an OWNER membership before touching anything', async () => {
    // is_grader is a grading-pool flag; the RANDOM pool draws from ASSISTANT +
    // TEACHER only, so setting it on an OWNER row would set a flag nothing reads.
    await expect(
      staff.updateStaff({
        classroomId: 'class-1',
        login: 'ada',
        role: 'OWNER',
        isGrader: true,
      })
    ).rejects.toMatchObject({ code: 'grader_flag_invalid' });
    expect(userFindFirst).not.toHaveBeenCalled();
    expect(updateById).not.toHaveBeenCalled();
  });

  it('throws staff_not_found when the user holds no membership at that role here', async () => {
    userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada' });
    findByClassroomAndUser.mockResolvedValue(null);

    await expect(
      staff.updateStaff({
        classroomId: 'class-1',
        login: 'ada',
        role: 'ASSISTANT',
        isGrader: true,
      })
    ).rejects.toMatchObject({ code: 'staff_not_found' });
    expect(updateById).not.toHaveBeenCalled();
  });

  it('resolves the login the way addStaff stored it: case-insensitively', async () => {
    // addStaff stores the canonical casing the provider returns, which is often
    // not what the caller typed, so 'ada' has to find the row stored as 'Ada'.
    userFindFirst.mockResolvedValue({ id: 'u-1', login: 'Ada' });
    findByClassroomAndUser.mockResolvedValue({ id: 'm-1', role: 'ASSISTANT' });

    await staff.updateStaff({
      classroomId: 'class-1',
      login: '@ada',
      role: 'ASSISTANT',
      isGrader: true,
    });

    expect(userFindFirst.mock.calls[0][0].where).toEqual({
      login: { equals: 'ada', mode: 'insensitive' },
    });
    expect(updateById).toHaveBeenCalledWith('m-1', { is_grader: true });
  });
});

describe('staff.removeStaff', () => {
  it.each(['ASSISTANT', 'TEACHER'] as const)(
    'builds the %s task payload from DB records and returns the run handle',
    async role => {
      userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada' });
      findByClassroomAndUser.mockResolvedValue({ id: 'm-1', has_accepted_invite: true });

      const result = await staff.removeStaff({ classroomId: 'class-1', login: 'ada', role });

      expect(triggerTask).toHaveBeenCalledWith('remove_user_from_organization', {
        payload: {
          // has_accepted_invite comes from the MEMBERSHIP, not the user record.
          user: { id: 'u-1', login: 'ada', has_accepted_invite: true },
          // Field by field: the classroom id and slug the task needs for the
          // team name and the membership delete, and the git-org fields the
          // provider factory resolves — not the loaded records themselves.
          gitOrganization: {
            id: 'org-1',
            login: 'cs1-org',
            provider: 'GITHUB',
            github_installation_id: null,
            base_url: null,
          },
          classroom: { id: 'class-1', slug: 'cs1-25f' },
          role,
        },
      });
      expect(result).toEqual({ userId: 'u-1', login: 'ada', role, runId: 'run-1' });
      // Only OWNER removals need the owner-count guard.
      expect(membershipCount).not.toHaveBeenCalled();
    }
  );

  it.each(['ASSISTANT', 'TEACHER', 'OWNER'] as const)(
    'looks the %s membership up at that role specifically',
    async role => {
      userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada' });
      findByClassroomAndUser.mockResolvedValue({ id: 'm-1', has_accepted_invite: true });

      const result = await staff.removeStaff({ classroomId: 'class-1', login: 'ada', role });

      // Role-scoped: the other roles this user holds here are never the target.
      expect(findByClassroomAndUser).toHaveBeenCalledWith('class-1', 'u-1', role);
      // The role travels through to the task and back to the caller unchanged.
      const { payload } = triggerTask.mock.calls[0][1] as { payload: { role: string } };
      expect(payload.role).toBe(role);
      expect(result.role).toBe(role);
    }
  );

  it('refuses to remove a user who does not hold that role in this classroom', async () => {
    userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada' });
    findByClassroomAndUser.mockResolvedValue(null);

    await expect(
      staff.removeStaff({ classroomId: 'class-1', login: 'ada', role: 'ASSISTANT' })
    ).rejects.toMatchObject({ code: 'staff_not_found' });
    expect(triggerTask).not.toHaveBeenCalled();
  });

  it('resolves the login the way addStaff stored it: case-insensitively', async () => {
    userFindFirst.mockResolvedValue({ id: 'u-1', login: 'Ada' });
    findByClassroomAndUser.mockResolvedValue({ id: 'm-1', has_accepted_invite: true });

    await staff.removeStaff({ classroomId: 'class-1', login: '@ada', role: 'ASSISTANT' });

    expect(userFindFirst.mock.calls[0][0].where).toEqual({
      login: { equals: 'ada', mode: 'insensitive' },
    });
  });

  it('refuses to remove the LAST owner before anything is queued', async () => {
    userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada' });
    findByClassroomAndUser.mockResolvedValue({ id: 'm-1', has_accepted_invite: true });
    membershipCount.mockResolvedValue(1);

    await expect(
      staff.removeStaff({ classroomId: 'class-1', login: 'ada', role: 'OWNER' })
    ).rejects.toMatchObject({ code: 'last_owner' });

    expect(membershipCount).toHaveBeenCalledWith({
      where: { classroom_id: 'class-1', role: 'OWNER' },
    });
    // The removal is fire-and-forget, so the guard MUST run before the trigger —
    // otherwise the failure would surface inside the task and the caller would
    // have been told the removal succeeded.
    expect(triggerTask).not.toHaveBeenCalled();
  });

  it('sends the task only the fields it reads', async () => {
    // classroom.findById returns the classroom WITH its settings row and its
    // git organization. The task reads the classroom id/slug and the git-org
    // fields the provider factory resolves; run payloads are stored and
    // rendered by the task runner, so nothing else travels with them.
    classroomFindById.mockResolvedValue({
      ...CLASSROOM,
      git_organization: { ...CLASSROOM.git_organization, access_token: 'glpat-secret' },
      settings: {
        openai_api_key: 'sk-secret',
        anthropic_api_key: 'sk-ant-secret',
        llm_model: 'claude',
      },
      tags: [],
    });
    userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada' });
    findByClassroomAndUser.mockResolvedValue({ id: 'm-1', has_accepted_invite: true });

    await staff.removeStaff({ classroomId: 'class-1', login: 'ada', role: 'ASSISTANT' });

    const { payload } = triggerTask.mock.calls[0][1] as { payload: Record<string, unknown> };
    expect(Object.keys(payload).sort()).toEqual(['classroom', 'gitOrganization', 'role', 'user']);
    expect(Object.keys(payload.classroom as object)).toEqual(['id', 'slug']);
    expect(Object.keys(payload.gitOrganization as object).sort()).toEqual([
      'base_url',
      'github_installation_id',
      'id',
      'login',
      'provider',
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/secret/);
  });

  it('removes a non-last owner normally', async () => {
    userFindFirst.mockResolvedValue({ id: 'u-1', login: 'ada' });
    findByClassroomAndUser.mockResolvedValue({ id: 'm-1', has_accepted_invite: true });
    membershipCount.mockResolvedValue(2);

    const result = await staff.removeStaff({
      classroomId: 'class-1',
      login: 'ada',
      role: 'OWNER',
    });

    expect(triggerTask).toHaveBeenCalledWith(
      'remove_user_from_organization',
      expect.objectContaining({ payload: expect.objectContaining({ role: 'OWNER' }) })
    );
    expect(result).toEqual({ userId: 'u-1', login: 'ada', role: 'OWNER', runId: 'run-1' });
  });
});

describe('the staff role is checked at runtime', () => {
  // StaffRole is a TYPE and is gone at runtime, so a caller that is not the MCP
  // schema — a script, a future route — can hand these functions any string.
  // STUDENT memberships belong to the roster service and must not be creatable,
  // flaggable or deletable through this path.
  const notStaff = ['STUDENT', 'owner', ''] as const;

  it.each(notStaff)('addStaff refuses %s before doing anything', async role => {
    await expect(
      staff.addStaff({ classroomId: 'class-1', login: 'ada', role: role as never })
    ).rejects.toMatchObject({ code: 'invalid_role' });
    expect(classroomFindById).not.toHaveBeenCalled();
    expect(membershipCreate).not.toHaveBeenCalled();
  });

  it.each(notStaff)('updateStaff refuses %s before doing anything', async role => {
    await expect(
      staff.updateStaff({
        classroomId: 'class-1',
        login: 'ada',
        role: role as never,
        isGrader: true,
      })
    ).rejects.toMatchObject({ code: 'invalid_role' });
    expect(updateById).not.toHaveBeenCalled();
  });

  it.each(notStaff)('removeStaff refuses %s before anything is queued', async role => {
    await expect(
      staff.removeStaff({ classroomId: 'class-1', login: 'ada', role: role as never })
    ).rejects.toMatchObject({ code: 'invalid_role' });
    expect(triggerTask).not.toHaveBeenCalled();
  });
});
