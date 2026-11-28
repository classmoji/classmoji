/**
 * The staff detail loader's VIEW row through the REAL audit funnel
 * (`~/utils/helpers`): it names its surface (`web:staff.view`) and, while a
 * platform admin is viewing as the owner, the admin (`impersonated_by`). The
 * session, the gate and the database are faked; the funnel is not.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  auditCreate: vi.fn(),
  impersonatedBy: null as string | null,
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  mayViewAs: () => false,
}));
vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: async () => ({
    userId: 'owner-1',
    session: { session: mocks.impersonatedBy ? { impersonatedBy: mocks.impersonatedBy } : {} },
  }),
  // The staff member's grading role (the route) and the viewer's (the funnel).
  resolveHighestMembership: async (_classroomId: string, userId: string) =>
    userId === 'owner-1'
      ? { role: 'OWNER' }
      : { role: 'ASSISTANT', is_grader: true, has_accepted_invite: true },
  // Re-exported by ~/utils/helpers; unused here.
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  formMutationBlocked: vi.fn(),
  requireStudentAccess: vi.fn(),
  assertProTier: vi.fn(),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { findBySlug: async () => ({ id: 'class-1', slug: 'cs52-26f' }) },
    user: {
      findByGitUsername: async () => ({ id: 'user-1', name: 'Ada', login: 'ada', image: null }),
    },
    gitRepoAssignmentGrader: {
      findAssignedByGrader: async () => [],
      findGradersProgress: async () => [],
    },
    audit: {
      create: (...a: unknown[]) => mocks.auditCreate(...a),
      logAuditMiss: vi.fn(),
      record: (row: unknown) =>
        import('../../../__tests__/support/auditRecord.ts').then(m =>
          m.recordThrough(r => mocks.auditCreate(r))(row)
        ),
    },
  },
}));
vi.mock('@trigger.dev/sdk', () => ({ runs: { retrieve: vi.fn(), subscribeToRun: vi.fn() } }));

// The loader is what is under test; the view layer only needs to be importable.
vi.mock('~/hooks', () => ({
  useRouteDrawer: () => ({ close: () => {}, opened: true, width: 600 }),
  useDarkMode: () => ({ isDarkMode: false }),
}));
vi.mock('~/components', () => ({ StatsCard: () => null, Emoji: () => null }));
vi.mock('~/components/shared/UserAvatar', () => ({ default: () => null }));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: () => {} }) }));
vi.mock('@classmoji/auth/client', () => ({
  authClient: { admin: { impersonateUser: () => {} } },
}));
vi.mock('~/utils/impersonationReturn', () => ({ rememberImpersonationReturn: () => {} }));

const route = await import('../route.tsx');

const load = () =>
  route.loader({
    params: { class: 'cs52-26f', login: 'ada' },
    request: new Request('http://localhost/admin/cs52-26f/staff/ada'),
  } as unknown as Parameters<typeof route.loader>[0]);

beforeEach(() => {
  mocks.auditCreate.mockReset();
  mocks.auditCreate.mockResolvedValue({ id: 'row-1' });
  mocks.impersonatedBy = null;
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: { id: 'class-1', slug: 'cs52-26f', git_organization: { provider: 'GITHUB' } },
    membership: { id: 'm-1', role: 'OWNER' },
  });
});

describe('staff detail loader — its VIEW row through the audit funnel', () => {
  it('names the surface, and the admin viewing as the owner', async () => {
    mocks.impersonatedBy = 'admin-1';
    await load();

    expect(mocks.auditCreate).toHaveBeenCalledExactlyOnceWith({
      classroom_id: 'class-1',
      user_id: 'owner-1',
      role: 'OWNER',
      resource_type: 'TEACHING_STAFF_DETAILS',
      resource_id: 'user-1',
      action: 'VIEW',
      data: { tool: 'web:staff.view', impersonated_by: 'admin-1' },
    });
  });

  it('has no impersonated_by on the owner’s own session', async () => {
    await load();

    expect(mocks.auditCreate.mock.calls[0][0].data).toEqual({ tool: 'web:staff.view' });
  });
});
