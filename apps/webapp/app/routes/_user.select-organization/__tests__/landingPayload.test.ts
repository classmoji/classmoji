/**
 * What the classroom picker (/select-organization) returns.
 *
 * The page reads a membership's id, role, invite state and pin, and its
 * classroom's own fields with the git organization's id, provider, login and
 * avatar, so that is what each membership holds. The page takes the signed-in
 * user from the root.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const GIT_ORG = {
  id: 'org-1',
  provider: 'GITHUB',
  provider_id: '4242',
  login: 'test-org',
  base_url: null,
  github_installation_id: '999',
  access_token: null,
  avatar_url: 'https://avatars.githubusercontent.com/u/4242?v=4',
};

const OWNER_ROW = {
  id: 'mem-owner',
  classroom_id: 'class-1',
  user_id: 'owner-1',
  role: 'OWNER',
  comment: null,
  letter_grade: null,
};

const CLASSROOM = {
  id: 'class-1',
  slug: 'test-class',
  name: 'Test Class',
  status: 'ACTIVE',
  is_archived: false,
  is_example: false,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-02T00:00:00Z'),
  git_organization: GIT_ORG,
  memberships: [OWNER_ROW],
  _count: { repositories: 2 },
};

const OWN_ROW = {
  id: 'mem-1',
  classroom_id: 'class-1',
  user_id: 'user-1',
  role: 'STUDENT',
  is_grader: false,
  has_accepted_invite: true,
  comment: null,
  letter_grade: null,
  pin_order: 2,
  tour_completed_at: null,
};

const SERVICE_USER = {
  id: 'user-1',
  login: 'student-login',
  name: 'Student',
  email: 'student@example.edu',
  emailVerified: true,
  classroom_memberships: [{ ...OWN_ROW, classroom: CLASSROOM }],
  memberships: [
    {
      ...OWN_ROW,
      classroom: CLASSROOM,
      organization: {
        ...CLASSROOM,
        login: CLASSROOM.slug,
        assignments: { _count: 2 },
        memberships: [OWNER_ROW],
      },
    },
  ],
};

// A Github-connected account by default, so the picker lists classrooms.
const accountFindMany = vi.fn();
const findById = vi.fn();

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: vi.fn(async () => ({
    userId: 'user-1',
    token: 'ghu_token',
    session: { session: { id: 'sess-1' } },
  })),
  clearRevokedToken: vi.fn(),
}));
// The browser auth client: the page's buttons use it, the loader never does.
vi.mock('@classmoji/auth/client', () => ({ authClient: {} }));
vi.mock('@classmoji/auth/invite-token', () => ({ verifyInviteToken: vi.fn(() => null) }));
vi.mock('~/utils/helpers', () => ({ checkAuth: (fn: unknown) => fn }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findById: (...a: unknown[]) => findById(...a), findProviderUsernames: vi.fn() },
    // The Free plan's one-active-class rule has its own tests; here there is room.
    classroomLifecycle: {
      allowanceFor: vi.fn(async () => ({ limit: 1, active: [], canCreate: true })),
      assertCanCreateActive: vi.fn(async () => {}),
      isActiveClassroomLimitError: () => false,
    },
    classroomInvite: {
      claimPendingInvites: vi.fn(async () => ({ claimed: 0 })),
      claimInviteByToken: vi.fn(async () => ({ claimed: false })),
    },
    audit: { create: vi.fn(async () => null) },
  },
  GitHubProvider: { getUserOctokit: vi.fn() },
  getGitProvider: vi.fn(),
  ensureClassroomTeam: vi.fn(),
  notificationService: { getForBell: vi.fn(async () => ({ items: [], unreadCount: 0 })) },
  pendingSurveyQuestions: vi.fn(async () => []),
}));
vi.mock('@classmoji/database', () => ({
  default: () => ({
    account: { findMany: (...a: unknown[]) => accountFindMany(...a) },
    // No pending Gitlab course memberships to activate.
    classroomMembership: { findMany: vi.fn(async () => []) },
  }),
}));
vi.mock('@trigger.dev/sdk', () => ({ tasks: {} }));

// Only the loader is under test; the view layer only needs to import.
vi.mock('antd', () => ({ Modal: () => null, Button: () => null }));
vi.mock('@classmoji/ui-components', () => ({
  useCallout: vi.fn(),
  Button: () => null,
  IconGithub: () => null,
}));
vi.mock('~/hooks', () => ({ useUser: vi.fn(), useDisclosure: vi.fn(), useGlobalFetcher: vi.fn() }));
vi.mock('~/store', () => ({ default: vi.fn() }));
vi.mock('~/components/features/landing', () => ({ ClassroomsLandingScreen: () => null }));
vi.mock('~/components/features/survey', () => ({ SurveyPrompt: () => null }));

const { loader } = await import('../route.tsx');

beforeEach(() => {
  vi.clearAllMocks();
  accountFindMany.mockResolvedValue([{ provider_id: 'github', email: null }]);
  findById.mockResolvedValue(SERVICE_USER);
});

const runLoader = async () =>
  (await loader({
    request: new Request('http://localhost/select-organization'),
  } as unknown as Parameters<typeof loader>[0])) as Record<string, unknown>;

describe('select-organization payload', () => {
  it('returns the fields the picker reads', async () => {
    const data = (await loader({
      request: new Request('http://localhost/select-organization'),
    } as unknown as Parameters<typeof loader>[0])) as Record<string, unknown>;

    expect(Object.keys(data).sort()).toEqual(
      [
        // Classroom id -> Github's accept page, for this viewer's own invites.
        'acceptUrls',
        // The viewer's own Free-plan allowance (their classes only).
        'activeClassAllowance',
        'gitMode',
        'githubAppName',
        'inviteEmailMismatch',
        'linkError',
        'membershipRoles',
        'memberships',
        'notifications',
        'surveyQuestions',
        'unreadCount',
      ].sort()
    );

    const [membership] = data.memberships as Array<Record<string, unknown>>;
    expect(Object.keys(membership).sort()).toEqual(
      ['has_accepted_invite', 'id', 'organization', 'pin_order', 'role'].sort()
    );
    expect(membership).toMatchObject({
      id: 'mem-1',
      role: 'STUDENT',
      has_accepted_invite: true,
      pin_order: 2,
    });

    const organization = membership.organization as Record<string, unknown>;
    expect(Object.keys(organization).sort()).toEqual(
      [
        '_count',
        'assignments',
        'created_at',
        'git_organization',
        'id',
        'is_archived',
        'is_example',
        'login',
        'name',
        'slug',
        'status',
        'updated_at',
      ].sort()
    );
    expect(organization).toMatchObject({
      id: 'class-1',
      login: 'test-class',
      name: 'Test Class',
      status: 'ACTIVE',
      is_archived: false,
    });
    expect(organization.git_organization).toEqual({
      id: 'org-1',
      provider: 'GITHUB',
      provider_id: '4242',
      login: 'test-org',
      avatar_url: 'https://avatars.githubusercontent.com/u/4242?v=4',
      base_url: null,
    });
  });
});

describe('select-organization before a Github or Gitlab account is connected', () => {
  beforeEach(() => {
    accountFindMany.mockResolvedValue([]);
  });

  it('still lists the classrooms they were invited to', async () => {
    findById.mockResolvedValue({
      ...SERVICE_USER,
      memberships: SERVICE_USER.memberships.map(m => ({ ...m, has_accepted_invite: false })),
    });

    const data = await runLoader();

    expect(data).not.toHaveProperty('needsGithub');
    expect(data.memberships).toHaveLength(1);
    expect((data.memberships as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'mem-1',
      has_accepted_invite: false,
    });
  });

  it('claims email invites before deciding there is nothing to show', async () => {
    const { ClassmojiService } = await import('@classmoji/services');
    findById.mockResolvedValueOnce({ ...SERVICE_USER, memberships: [] }).mockResolvedValueOnce({
      ...SERVICE_USER,
      memberships: SERVICE_USER.memberships.map(m => ({ ...m, has_accepted_invite: false })),
    });
    vi.mocked(ClassmojiService.classroomInvite.claimPendingInvites).mockResolvedValueOnce({
      claimed: 1,
      classroomIds: ['class-1'],
    });

    const data = await runLoader();

    expect(ClassmojiService.classroomInvite.claimPendingInvites).toHaveBeenCalledWith('user-1');
    expect(data.memberships).toHaveLength(1);
  });

  it('asks them to connect when they belong to no classroom', async () => {
    findById.mockResolvedValue({ ...SERVICE_USER, memberships: [] });

    const data = await runLoader();

    expect(data).toEqual({ needsGithub: true, linkError: null });
  });
});

/**
 * #849: a student who registered first, with an address other than the
 * invited one, opens the invite link. The verified token claims that one
 * invite.
 */
describe('select-organization with an invite link for another address', () => {
  const TOKEN = { email: 'ada@school.edu', classroomId: 'class-x' };
  const runWithInvite = async () =>
    (await loader({
      request: new Request('http://localhost/select-organization?invite=tok'),
    } as unknown as Parameters<typeof loader>[0])) as Record<string, unknown>;

  beforeEach(async () => {
    const { verifyInviteToken } = await import('@classmoji/auth/invite-token');
    vi.mocked(verifyInviteToken).mockReturnValue(TOKEN);
  });

  it('claims the invite, audits it, and shows no mismatch', async () => {
    const { ClassmojiService } = await import('@classmoji/services');
    vi.mocked(ClassmojiService.classroomInvite.claimInviteByToken).mockResolvedValueOnce({
      claimed: true,
      classroomId: 'class-x',
      membershipId: 'mem-x',
    });
    findById.mockResolvedValueOnce(SERVICE_USER).mockResolvedValueOnce({
      ...SERVICE_USER,
      memberships: [
        ...SERVICE_USER.memberships,
        {
          ...SERVICE_USER.memberships[0],
          id: 'mem-x',
          classroom_id: 'class-x',
          has_accepted_invite: false,
          organization: { ...SERVICE_USER.memberships[0].organization, id: 'class-x' },
        },
      ],
    });

    const data = await runWithInvite();

    expect(ClassmojiService.classroomInvite.claimInviteByToken).toHaveBeenCalledWith(
      'user-1',
      TOKEN
    );
    expect(ClassmojiService.audit.create).toHaveBeenCalledWith(
      {
        user_id: 'user-1',
        classroom_id: 'class-x',
        role: 'STUDENT',
        action: 'CREATE',
        resource_type: 'CLASSROOM_MEMBERSHIP',
        resource_id: 'mem-x',
        data: { tool: 'web:roster.invite_token' },
      },
      { dedupe: false }
    );
    // No address in the audit row.
    expect(JSON.stringify(vi.mocked(ClassmojiService.audit.create).mock.calls)).not.toContain(
      'ada@school.edu'
    );
    expect(data.memberships).toHaveLength(2);
    expect(data.inviteEmailMismatch).toBeNull();
  });

  it('keeps the mismatch callout when the invite is gone, and audits nothing', async () => {
    const { ClassmojiService } = await import('@classmoji/services');

    const data = await runWithInvite();

    expect(ClassmojiService.audit.create).not.toHaveBeenCalled();
    expect(data.inviteEmailMismatch).toBe('ada@school.edu');
  });

  it('shows no callout to someone already in the invited classroom', async () => {
    findById.mockResolvedValue({
      ...SERVICE_USER,
      memberships: [
        {
          ...SERVICE_USER.memberships[0],
          classroom_id: 'class-x',
          organization: { ...SERVICE_USER.memberships[0].organization, id: 'class-x' },
        },
      ],
    });

    const data = await runWithInvite();

    expect(data.inviteEmailMismatch).toBeNull();
  });

  it('claims nothing for an expired or invalid token', async () => {
    const { verifyInviteToken } = await import('@classmoji/auth/invite-token');
    const { ClassmojiService } = await import('@classmoji/services');
    vi.mocked(verifyInviteToken).mockReturnValue(null);

    await runWithInvite();

    expect(ClassmojiService.classroomInvite.claimInviteByToken).not.toHaveBeenCalled();
  });

  it('claims nothing while viewing as someone', async () => {
    const { getAuthSession } = await import('@classmoji/auth/server');
    const { ClassmojiService } = await import('@classmoji/services');
    vi.mocked(getAuthSession).mockResolvedValueOnce({
      userId: 'user-1',
      token: 'ghu_token',
      session: { session: { id: 'sess-1', impersonatedBy: 'admin-1' } },
    } as never);

    await runWithInvite();

    expect(ClassmojiService.classroomInvite.claimInviteByToken).not.toHaveBeenCalled();
  });
});
