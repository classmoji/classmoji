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
  provider_email: null,
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

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: vi.fn(async () => ({
    userId: 'user-1',
    token: 'ghu_token',
    session: { session: { id: 'sess-1' } },
  })),
  clearRevokedToken: vi.fn(),
}));
vi.mock('@classmoji/auth/invite-token', () => ({ verifyInviteToken: vi.fn(() => null) }));
vi.mock('~/utils/helpers', () => ({ checkAuth: (fn: unknown) => fn }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findById: vi.fn(async () => SERVICE_USER), findByLogin: vi.fn() },
    classroomInvite: { claimPendingInvites: vi.fn(async () => ({ claimed: 0 })) },
  },
  GitHubProvider: { getUserOctokit: vi.fn() },
  getGitProvider: vi.fn(),
  ensureClassroomTeam: vi.fn(),
  notificationService: { getForBell: vi.fn(async () => ({ items: [], unreadCount: 0 })) },
  pendingSurveyQuestions: vi.fn(async () => []),
}));
vi.mock('@classmoji/database', () => ({ default: vi.fn() }));
vi.mock('@trigger.dev/sdk', () => ({ tasks: {} }));

// Only the loader is under test; the view layer only needs to import.
vi.mock('antd', () => ({ Modal: () => null, Button: () => null }));
vi.mock('@classmoji/ui-components', () => ({ useCallout: vi.fn() }));
vi.mock('~/hooks', () => ({ useUser: vi.fn(), useDisclosure: vi.fn(), useGlobalFetcher: vi.fn() }));
vi.mock('~/store', () => ({ default: vi.fn() }));
vi.mock('~/components/features/landing', () => ({ ClassroomsLandingScreen: () => null }));
vi.mock('~/components/features/survey', () => ({ SurveyPrompt: () => null }));

const { loader } = await import('../route.tsx');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('select-organization payload', () => {
  it('returns the fields the picker reads', async () => {
    const data = (await loader({
      request: new Request('http://localhost/select-organization'),
    } as unknown as Parameters<typeof loader>[0])) as Record<string, unknown>;

    expect(Object.keys(data).sort()).toEqual(
      [
        'githubAppName',
        'inviteEmailMismatch',
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
    });
  });
});
