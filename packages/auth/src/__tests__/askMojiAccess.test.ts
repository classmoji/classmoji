/**
 * `assertAskMojiAccess` (R2): the gate every Ask Moji route runs. It admits
 * all four bot roles, returns every role held and the strongest, carries the
 * impersonation fields of the web session, and audits a denial with resource
 * type ASK_MOJI, as `assertClassroomAccess` does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  findBySlug: vi.fn(),
  findByClassroomAndUser: vi.fn(),
  membershipFindMany: vi.fn(),
  auditCreate: vi.fn(),
  getClassroomForUI: vi.fn(),
}));

vi.mock('better-auth', () => ({
  betterAuth: () => ({ api: { getSession: (...a: unknown[]) => mocks.getSession(...a) } }),
}));
vi.mock('better-auth/adapters/prisma', () => ({ prismaAdapter: () => ({}) }));
vi.mock('better-auth/plugins', () => ({
  admin: () => ({}),
  emailOTP: () => ({}),
  mcp: () => ({}),
}));
vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroomMembership: { findMany: (...a: unknown[]) => mocks.membershipFindMany(...a) },
  }),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: {
      findBySlug: (...a: unknown[]) => mocks.findBySlug(...a),
      getClassroomForUI: (...a: unknown[]) => mocks.getClassroomForUI(...a),
    },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findByClassroomAndUser(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    githubUserToken: { getGitHubTokenForUser: vi.fn() },
  },
}));

const { assertAskMojiAccess } = await import('../server.ts');

type Role = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';
const SLUG = 'cs-1';
const CLASSROOM = { id: 'class-1', slug: SLUG, status: 'ACTIVE', settings: {} };
const request = () => new Request(`http://localhost/api/ask-moji/${SLUG}/start`);

const signedIn = (
  roles: Role[],
  session: Record<string, unknown> = { id: 'web-1' },
  userId = 'user-1'
) => {
  mocks.getSession.mockResolvedValue({ user: { id: userId }, session });
  mocks.findByClassroomAndUser.mockImplementation(
    (_c: unknown, _u: unknown, requested: unknown) => {
      const wanted = Array.isArray(requested) ? (requested as Role[]) : null;
      const match = wanted ? wanted.find(r => roles.includes(r)) : roles[0];
      return Promise.resolve(match ? { id: `m-${match}`, role: match } : null);
    }
  );
  mocks.membershipFindMany.mockImplementation((args: { where: { role: { in: Role[] } } }) =>
    Promise.resolve(
      roles
        .filter(r => args.where.role.in.includes(r))
        .map(role => ({ role, has_accepted_invite: role !== 'STUDENT' }))
    )
  );
};

const rejection = async (p: Promise<unknown>): Promise<Response> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  throw new Error('expected a refusal');
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findBySlug.mockResolvedValue(CLASSROOM);
  mocks.getClassroomForUI.mockImplementation((c: unknown) => c);
  mocks.auditCreate.mockResolvedValue(undefined);
});

describe('assertAskMojiAccess', () => {
  it.each<Role>(['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'])('admits a %s', async role => {
    signedIn([role]);
    const access = await assertAskMojiAccess(request(), SLUG);
    expect(access).toMatchObject({
      userId: 'user-1',
      actorUserId: 'user-1',
      impersonation: null,
      webSessionId: 'web-1',
      classroom: { id: 'class-1' },
      roles: [role],
      highestRole: role,
    });
  });

  it('returns every role held, strongest first', async () => {
    signedIn(['STUDENT', 'ASSISTANT']);
    const access = await assertAskMojiAccess(request(), SLUG);
    expect(access.roles).toEqual(['ASSISTANT', 'STUDENT']);
    expect(access.highestRole).toBe('ASSISTANT');
  });

  it('reads the roles held in one query of role and acceptance only', async () => {
    signedIn(['TEACHER', 'STUDENT']);
    const access = await assertAskMojiAccess(request(), SLUG);
    expect(mocks.membershipFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.membershipFindMany).toHaveBeenCalledWith({
      where: {
        classroom_id: 'class-1',
        user_id: 'user-1',
        role: { in: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'] },
      },
      select: { role: true, has_accepted_invite: true },
    });
    // An unaccepted row still counts (the rule assertClassroomAccess admits by).
    expect(access.roles).toEqual(['TEACHER', 'STUDENT']);
    expect(access.highestRole).toBe('TEACHER');
  });

  it('carries the impersonation behind the web session', async () => {
    const expiresAt = new Date('2026-10-18T12:00:00Z');
    signedIn(['STUDENT'], { id: 'web-imp', impersonatedBy: 'admin-1', expiresAt });
    const access = await assertAskMojiAccess(request(), SLUG);
    expect(access).toMatchObject({
      userId: 'user-1',
      actorUserId: 'admin-1',
      webSessionId: 'web-imp',
      impersonation: { by: 'admin-1', sessionId: 'web-imp', expiresAt: expiresAt.toISOString() },
    });
  });

  it('refuses a non-member, audited as ASK_MOJI', async () => {
    signedIn([]);
    const refused = await rejection(assertAskMojiAccess(request(), SLUG));
    expect(refused.status).toBe(403);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ACCESS_DENIED',
        resource_type: 'ASK_MOJI',
        classroom_id: 'class-1',
      })
    );
  });

  it('refuses a signed-out caller and an unknown classroom', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await rejection(assertAskMojiAccess(request(), SLUG))).status).toBe(401);
    signedIn(['STUDENT']);
    mocks.findBySlug.mockResolvedValue(null);
    expect((await rejection(assertAskMojiAccess(request(), SLUG))).status).toBe(404);
  });

  it('refuses a student in an unpublished classroom, admits its owner', async () => {
    mocks.findBySlug.mockResolvedValue({ ...CLASSROOM, status: 'UNPUBLISHED' });
    signedIn(['STUDENT']);
    expect((await rejection(assertAskMojiAccess(request(), SLUG))).status).toBe(403);
    signedIn(['OWNER']);
    expect((await assertAskMojiAccess(request(), SLUG)).highestRole).toBe('OWNER');
  });
});
