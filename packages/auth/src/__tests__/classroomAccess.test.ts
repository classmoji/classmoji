/**
 * Unit tests for the role RESOLUTION inside `assertClassroomAccess` — the gate
 * behind requireClassroomAdmin / requireClassroomStaff /
 * requireClassroomTeachingTeam, and therefore behind nearly every webapp
 * loader.
 *
 * ClassroomMembership is unique on (classroom_id, user_id, role), so one person
 * routinely holds several roles in the same classroom: promoting a student to
 * assistant ADDS a row rather than replacing one, and the primary dev identity
 * holds OWNER, ASSISTANT and STUDENT at once. The underlying service lookup is
 * an unordered `findFirst`, so asking it once for a set of roles hands back an
 * arbitrary member of that set.
 *
 * That matters because callers do not merely pass or fail this gate — they read
 * `membership.role` back out of it to decide what to SEND: the roster's
 * owner-only contact fields, the slide list's drafts. An arbitrary role means
 * an owner can lose their own columns, or a TA who is also enrolled can lose
 * the drafts they are allowed to open.
 *
 * The gate therefore resolves the caller's HIGHEST role. These tests pin that,
 * and pin that the role FILTER still bounds the answer — a route that admits
 * only students must not start resolving the caller as an owner.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  findBySlug: vi.fn(),
  findByClassroomAndUser: vi.fn(),
  auditCreate: vi.fn(),
  getClassroomForUI: vi.fn(),
}));

vi.mock('better-auth', () => ({
  betterAuth: () => ({ api: { getSession: (...a: unknown[]) => mocks.getSession(...a) } }),
}));
vi.mock('better-auth/adapters/prisma', () => ({ prismaAdapter: () => ({}) }));
vi.mock('better-auth/plugins', () => ({ admin: () => ({}), mcp: () => ({}) }));
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

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

const { assertClassroomAccess, requireClassroomAdmin, requireClassroomTeachingTeam } =
  await import('../server.ts');

type Role = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE', settings: {} };

const request = () => new Request(`http://localhost/admin/${CLASS_SLUG}/students`);

/**
 * Sign the caller in holding `roles`. The gate probes one role per lookup, so
 * the mock answers per requested role — the arbitrary ordering an unfiltered
 * `findFirst` would impose is deliberately NOT modelled, because the gate must
 * not depend on it.
 */
function signedInHolding(roles: Role[], userId = 'user-1') {
  mocks.getSession.mockResolvedValue({ user: { id: userId, name: userId } });
  mocks.findByClassroomAndUser.mockImplementation(
    (_classroomId: unknown, _userId: unknown, requested: unknown) => {
      const wanted = Array.isArray(requested) ? (requested as Role[]) : null;
      const match = wanted ? wanted.find(role => roles.includes(role)) : roles[0];
      return Promise.resolve(match ? { id: `m-${match}`, role: match } : null);
    }
  );
}

const accessAs = (allowedRoles: Role[]) =>
  assertClassroomAccess({
    request: request(),
    classroomSlug: CLASS_SLUG,
    allowedRoles,
    resourceType: 'STUDENT_ROSTER',
    attemptedAction: 'view_roster',
  });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findBySlug.mockResolvedValue(CLASSROOM);
  mocks.getClassroomForUI.mockImplementation((c: unknown) => c);
  mocks.auditCreate.mockResolvedValue(undefined);
});

// ─── The single-role case is unchanged ───────────────────────────────────────

describe('assertClassroomAccess — a caller holding one role', () => {
  it.each([['OWNER'], ['TEACHER'], ['ASSISTANT']] as const)('resolves %s as itself', async role => {
    signedInHolding([role]);

    const result = await accessAs(['OWNER', 'TEACHER', 'ASSISTANT']);

    expect(result.membership).toMatchObject({ role });
  });

  it('refuses a caller with no membership at all', async () => {
    signedInHolding([]);

    await expect(accessAs(['OWNER'])).rejects.toMatchObject({ status: 403 });
  });
});

// ─── Multi-role callers resolve to their highest role ────────────────────────

describe('assertClassroomAccess — a caller holding several roles', () => {
  it('resolves OWNER+STUDENT as OWNER', async () => {
    signedInHolding(['OWNER', 'STUDENT']);

    const result = await accessAs(['OWNER', 'TEACHER', 'ASSISTANT']);

    expect(result.membership).toMatchObject({ role: 'OWNER' });
  });

  it('resolves ASSISTANT+STUDENT as ASSISTANT', async () => {
    signedInHolding(['ASSISTANT', 'STUDENT']);

    const result = await accessAs(['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT']);

    expect(result.membership).toMatchObject({ role: 'ASSISTANT' });
  });

  it('resolves OWNER+ASSISTANT+STUDENT — the dev identity — as OWNER', async () => {
    signedInHolding(['OWNER', 'ASSISTANT', 'STUDENT']);

    const result = await accessAs(['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT']);

    expect(result.membership).toMatchObject({ role: 'OWNER' });
  });

  it('is not swayed by the order the roles happen to exist in', async () => {
    signedInHolding(['STUDENT', 'ASSISTANT', 'OWNER']);

    const result = await accessAs(['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT']);

    expect(result.membership).toMatchObject({ role: 'OWNER' });
  });

  it('probes each candidate role separately rather than in one filtered lookup', async () => {
    // The mechanism, pinned: a single lookup over four roles is exactly the
    // unordered query whose answer was arbitrary.
    signedInHolding(['OWNER', 'STUDENT']);

    await accessAs(['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT']);

    for (const call of mocks.findByClassroomAndUser.mock.calls) {
      expect(call[2]).toHaveLength(1);
    }
  });
});

// ─── The role filter still bounds the answer ─────────────────────────────────

describe('assertClassroomAccess — the allowed-role filter still applies', () => {
  it('resolves an OWNER+STUDENT as STUDENT on a student-only route', async () => {
    // Highest-role-wins picks among the roles the ROUTE allows — it never
    // reaches outside them.
    signedInHolding(['OWNER', 'STUDENT']);

    const result = await accessAs(['STUDENT']);

    expect(result.membership).toMatchObject({ role: 'STUDENT' });
  });

  it('still refuses a STUDENT-only caller on an owner-only route', async () => {
    signedInHolding(['STUDENT']);

    await expect(accessAs(['OWNER'])).rejects.toMatchObject({ status: 403 });
  });
});

// ─── What this buys the routes that read membership.role back ────────────────

describe('the gates the roster and slide-list routes actually call', () => {
  it('requireClassroomAdmin admits an OWNER who is also a STUDENT', async () => {
    signedInHolding(['OWNER', 'STUDENT']);

    const result = await requireClassroomAdmin(request(), CLASS_SLUG);

    expect(result.membership).toMatchObject({ role: 'OWNER' });
  });

  it('requireClassroomTeachingTeam reports OWNER for an OWNER who is also a STUDENT', async () => {
    // This is what `isOwner` in the students loader hangs off: resolving the
    // STUDENT row would strip an owner of their own columns and actions.
    signedInHolding(['OWNER', 'STUDENT']);

    const result = await requireClassroomTeachingTeam(request(), CLASS_SLUG);

    expect(result.membership?.role).toBe('OWNER');
  });

  it('requireClassroomTeachingTeam reports ASSISTANT for a TA who is also enrolled', async () => {
    // And this is what the slides list's `isStaff` hangs off — a TA enrolled as
    // a student must still be shown the drafts they are allowed to open.
    signedInHolding(['ASSISTANT', 'STUDENT']);

    const result = await requireClassroomTeachingTeam(request(), CLASS_SLUG);

    expect(result.membership?.role).toBe('ASSISTANT');
  });
});
