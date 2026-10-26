import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The git half of joining a class, shared by the picker and the invite link.
 * Pins the outcome per case, that only a fresh Github invitation sends the
 * student to Github's invitation page, and one audit row per attempt.
 */

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  auditCreate: vi.fn(),
  taskTrigger: vi.fn(),
  getTeam: vi.fn(),
  isMember: vi.fn(),
  addTeamMember: vi.fn(),
  getUserByLogin: vi.fn(),
  inviteToOrganization: vi.fn(),
}));

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () => ({ user: { findUnique: (...a: unknown[]) => mocks.userFindUnique(...a) } }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: { audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) } },
  getGitProvider: () => ({
    isUserMemberOfOrganization: (...a: unknown[]) => mocks.isMember(...a),
    addTeamMember: (...a: unknown[]) => mocks.addTeamMember(...a),
    getUserByLogin: (...a: unknown[]) => mocks.getUserByLogin(...a),
    inviteToOrganization: (...a: unknown[]) => mocks.inviteToOrganization(...a),
  }),
  ensureClassroomTeam: (...a: unknown[]) => mocks.getTeam(...a),
}));

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.taskTrigger(...a) },
}));

const { joinGitOrganization } = await import('../joinGitOrganization.server');

const githubIdentity = {
  accounts: [{ provider_id: 'github', account_id: '42', username: 'ada', gitlab_instance_id: '' }],
};

const classroom = (provider: 'GITHUB' | 'GITLAB') => ({
  id: 'class-x',
  slug: 'cs10',
  name: 'CS 10',
  git_organization: { id: 'org-1', provider, login: 'cs10-org' } as never,
});

const run = (provider: 'GITHUB' | 'GITLAB' = 'GITHUB') =>
  joinGitOrganization({
    userId: 'user-a',
    membership: { id: 'mem-a', role: 'STUDENT' },
    classroom: classroom(provider),
    tool: 'web:roster.join_link',
  });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.getTeam.mockResolvedValue({ id: 7, slug: 'cs10-students' });
  mocks.getUserByLogin.mockResolvedValue({ id: 42 });
});

describe('joinGitOrganization', () => {
  it('invites to the Github org and points at the invitation page', async () => {
    mocks.userFindUnique.mockResolvedValue(githubIdentity);
    mocks.isMember.mockResolvedValue(false);

    const result = await run();

    expect(mocks.inviteToOrganization).toHaveBeenCalledWith('cs10-org', '42', [7]);
    expect(result).toMatchObject({
      ok: true,
      outcome: 'invited',
      invitationUrl: 'https://github.com/orgs/cs10-org/invitation',
    });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      user_id: 'user-a',
      classroom_id: 'class-x',
      resource_id: 'mem-a',
      data: { tool: 'web:roster.join_link', outcome: 'invited', login: 'ada' },
    });
  });

  it('adds an existing org member to the team and activates, with no invitation page', async () => {
    mocks.userFindUnique.mockResolvedValue(githubIdentity);
    mocks.isMember.mockResolvedValue(true);

    const result = await run();

    expect(mocks.inviteToOrganization).not.toHaveBeenCalled();
    expect(mocks.addTeamMember).toHaveBeenCalledWith('cs10-org', 'cs10-students', 'ada');
    expect(mocks.taskTrigger).toHaveBeenCalledWith(
      'activate_membership',
      expect.objectContaining({ login: 'ada', gitOrganizationId: 'org-1' })
    );
    expect(result).toMatchObject({ ok: true, outcome: 'added_to_team' });
    expect(result.ok && result.invitationUrl).toBeUndefined();
  });

  it('asks a student with no account on the course provider to connect one', async () => {
    mocks.userFindUnique.mockResolvedValue(githubIdentity);
    const result = await run('GITLAB');
    expect(result).toMatchObject({ ok: false, reason: 'needs_connect', provider: 'GITLAB' });
    expect(mocks.taskTrigger).not.toHaveBeenCalled();
  });

  it('turns a Github error into a failure the student can read, and audits it', async () => {
    mocks.userFindUnique.mockResolvedValue(githubIdentity);
    mocks.isMember.mockResolvedValue(false);
    mocks.inviteToOrganization.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { status: 403 })
    );

    const result = await run();

    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    expect(mocks.auditCreate.mock.calls[0][0].data).toMatchObject({
      outcome: 'failed',
      status: 403,
    });
  });
});
