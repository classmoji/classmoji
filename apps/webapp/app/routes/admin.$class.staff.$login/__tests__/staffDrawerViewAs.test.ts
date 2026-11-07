/**
 * The staff detail drawer offers "View as" only to platform admins: its loader
 * hands the page `canViewAs` from the server's rule (`mayViewAs`, which the
 * auth server also enforces), so an owner who is not a platform admin is
 * never shown the button.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  mayViewAs: vi.fn(),
  findByGitUsername: vi.fn(),
  resolveHighestMembership: vi.fn(),
  findAssignedByGrader: vi.fn(),
  findGradersProgress: vi.fn(),
  addAuditLog: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  mayViewAs: (...a: unknown[]) => mocks.mayViewAs(...a),
}));
vi.mock('@classmoji/auth/server', () => ({
  resolveHighestMembership: (...a: unknown[]) => mocks.resolveHighestMembership(...a),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findByGitUsername: (...a: unknown[]) => mocks.findByGitUsername(...a) },
    gitRepoAssignmentGrader: {
      findAssignedByGrader: (...a: unknown[]) => mocks.findAssignedByGrader(...a),
      findGradersProgress: (...a: unknown[]) => mocks.findGradersProgress(...a),
    },
  },
}));
vi.mock('~/utils/helpers', () => ({ addAuditLog: (...a: unknown[]) => mocks.addAuditLog(...a) }));

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

const asOwner = (userId: string) =>
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId,
    classroom: { id: 'class-1', slug: 'cs52-26f', git_organization: { provider: 'GITHUB' } },
    membership: { id: 'm-1', role: 'OWNER' },
  });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.mayViewAs.mockImplementation((userId: unknown) => userId === 'platform-admin-1');
  mocks.findByGitUsername.mockResolvedValue({
    id: 'user-1',
    name: 'Ada Lovelace',
    login: 'ada',
    image: null,
  });
  mocks.resolveHighestMembership.mockResolvedValue({
    role: 'ASSISTANT',
    is_grader: true,
    has_accepted_invite: true,
  });
  mocks.findAssignedByGrader.mockResolvedValue([]);
  mocks.findGradersProgress.mockResolvedValue([]);
});

describe('staff drawer loader — canViewAs', () => {
  it('is false for an owner who is not a platform admin', async () => {
    asOwner('owner-1');
    const data = await load();

    expect(data.canViewAs).toBe(false);
    expect(mocks.mayViewAs).toHaveBeenCalledWith('owner-1');
  });

  it('is true for a platform admin who owns the classroom', async () => {
    asOwner('platform-admin-1');
    const data = await load();

    expect(data.canViewAs).toBe(true);
  });
});
