/**
 * The Pro flag the /teacher and /assistant layouts hand their sidebar.
 *
 * The staff nav shows its Pro-only entries (Quizzes, and Forms for teachers)
 * from this flag. The client's own tier fetch, `/api/get-org-subscription`, is
 * OWNER-only because it returns the paying owner's subscription row, so a
 * teacher or assistant needs the fact from somewhere they are already allowed
 * to read — their layout loader — and must get ONLY the fact.
 *
 * The role matrix runs through the REAL `assertClassroomAccess` (via the real
 * `requireClassroomTeachingTeam` the layouts call), mocked only at the session,
 * classroom and membership lookups — the same seam
 * packages/auth/src/__tests__/classroomAccess.test.ts uses. So if a layout's
 * gate were swapped for a wider one, the STUDENT and non-member rows here would
 * start failing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Role = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE', settings: {} };

// A real-looking paying owner's subscription. None of it may reach a staff
// layout's payload.
const PRO_SUBSCRIPTION = {
  id: 'subscription-row-7f3a',
  user_id: 'owner-user-9',
  tier: 'PRO',
  stripe_subscription_id: 'sub_STRIPE_91b2',
  started_at: new Date('2026-01-01T00:00:00Z'),
  ends_at: null,
};

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  findBySlug: vi.fn(),
  findByClassroomAndUser: vi.fn(),
  auditCreate: vi.fn(),
  getClassroomForUI: vi.fn(),
  getProStateForClassroomId: vi.fn(),
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
    subscription: {
      getProStateForClassroomId: (...a: unknown[]) => mocks.getProStateForClassroomId(...a),
    },
    module: { hasModulesForClassroom: vi.fn(async () => false) },
    resourceView: {
      getRecentViewers: vi.fn(async () => []),
      normalizePath: vi.fn(() => '/x'),
      recordView: vi.fn(),
    },
  },
}));

// The loaders are under test; the view layers only need to import.
vi.mock('~/components', () => ({ CommonLayout: () => null, RequireRole: () => null }));
vi.mock('~/components/features/pages', () => ({ PagePeekProvider: () => null }));
vi.mock('~/utils/pagesNav.server', () => ({
  EMPTY_PAGES_NAV: { hasPages: false, siteSlugByPageId: {}, siteOrigin: null },
  loadPagesNav: vi.fn(async () => ({ hasPages: false, siteSlugByPageId: {}, siteOrigin: null })),
}));

const { loadClassroomIsPro } = await import('~/utils/classroomProFlag.server');
const { revalidateOnClassChange } = await import('~/utils/revalidateOnClassChange');

const LAYOUTS = {
  teacher: await import('../teacher/route'),
  assistant: await import('../assistant/route'),
};

/**
 * Sign the caller in holding `roles` in the classroom. The gate probes one role
 * per lookup, so the mock answers per requested role (as classroomAccess.test
 * does).
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

const classroomIs = (pro: boolean) =>
  mocks.getProStateForClassroomId.mockResolvedValue(
    pro
      ? { tier: 'PRO', isActive: true, isPro: true, subscription: PRO_SUBSCRIPTION }
      : // A lapsed PRO row: the resolver still hands back a row and tier 'PRO'.
        {
          tier: 'PRO',
          isActive: false,
          isPro: false,
          subscription: { ...PRO_SUBSCRIPTION, ends_at: new Date('2026-02-01T00:00:00Z') },
        }
  );

const runLayout = async (prefix: keyof typeof LAYOUTS) =>
  (await LAYOUTS[prefix].loader({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/${prefix}/${CLASS_SLUG}/quizzes`),
  } as never)) as Record<string, unknown>;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findBySlug.mockResolvedValue(CLASSROOM);
  mocks.getClassroomForUI.mockImplementation((c: unknown) => c);
  mocks.auditCreate.mockResolvedValue(undefined);
});

describe.each(['teacher', 'assistant'] as const)('the /%s layout Pro flag', prefix => {
  describe.each([['OWNER'], ['TEACHER'], ['ASSISTANT']] as const)('for a %s', role => {
    it.each([
      [true, 'Pro'],
      [false, 'not Pro'],
    ])('is %s when the classroom is %s', async (pro, _label) => {
      signedInHolding([role]);
      classroomIs(pro);

      const payload = await runLayout(prefix);

      expect(payload.isPro).toBe(pro);
      expect(mocks.getProStateForClassroomId).toHaveBeenCalledWith(CLASSROOM.id);
    });
  });

  it.each([
    ['a STUDENT', ['STUDENT'] as Role[]],
    ['a non-member', [] as Role[]],
  ])('is false for %s, without reading the tier at all', async (_label, roles) => {
    signedInHolding(roles);
    classroomIs(true);

    const payload = await runLayout(prefix);

    expect(payload.isPro).toBe(false);
    expect(mocks.getProStateForClassroomId).not.toHaveBeenCalled();
  });

  it('is false for a signed-out caller', async () => {
    mocks.getSession.mockResolvedValue(null);
    classroomIs(true);

    const payload = await runLayout(prefix);

    expect(payload.isPro).toBe(false);
    expect(mocks.getProStateForClassroomId).not.toHaveBeenCalled();
  });

  it('carries a boolean and nothing of the subscription behind it', async () => {
    signedInHolding(['ASSISTANT']);
    classroomIs(true);

    const payload = await runLayout(prefix);

    expect(typeof payload.isPro).toBe('boolean');
    expect('subscription' in payload).toBe(false);
    expect('tier' in payload).toBe(false);
    const serialized = JSON.stringify(payload);
    for (const secret of [
      PRO_SUBSCRIPTION.id,
      PRO_SUBSCRIPTION.user_id,
      PRO_SUBSCRIPTION.stripe_subscription_id,
      'stripe',
      'ends_at',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('re-reads per classroom rather than keeping the last one', async () => {
    expect(LAYOUTS[prefix].shouldRevalidate).toBe(revalidateOnClassChange);
  });

  it('keeps the rest of the nav when the Pro lookup fails', async () => {
    signedInHolding(['TEACHER']);
    mocks.getProStateForClassroomId.mockRejectedValue(new Error('connection pool timeout'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const payload = await runLayout(prefix);

    expect(payload.isPro).toBe(false);
    // The authorized payload, not the empty fallback the loader's catch returns.
    expect(payload.isTeachingTeam).toBe(true);
    expect(payload.navVisibility).toMatchObject({ hasModules: false, hasPages: false });
    consoleError.mockRestore();
  });
});

describe('loadClassroomIsPro', () => {
  it('answers false when the lookup throws, rather than throwing', async () => {
    mocks.getProStateForClassroomId.mockRejectedValue(new Error('connection pool timeout'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(loadClassroomIsPro(CLASSROOM.id)).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('returns the resolver’s decision as a bare boolean', async () => {
    classroomIs(true);
    expect(await loadClassroomIsPro(CLASSROOM.id)).toBe(true);

    classroomIs(false);
    expect(await loadClassroomIsPro(CLASSROOM.id)).toBe(false);
  });

  it('keys on isPro, not tier: a lapsed PRO row is not Pro', async () => {
    classroomIs(false);
    const result = await loadClassroomIsPro(CLASSROOM.id);

    expect(result).toBe(false);
    expect(typeof result).toBe('boolean');
  });
});

describe('revalidateOnClassChange', () => {
  const args = (currentClass: string, nextClass: string, defaultShouldRevalidate: boolean) =>
    ({
      currentParams: { class: currentClass },
      nextParams: { class: nextClass },
      defaultShouldRevalidate,
    }) as never;

  it('re-runs the layout loader when the classroom changes', () => {
    expect(revalidateOnClassChange(args('cs52', 'cs10', false))).toBe(true);
  });

  it('otherwise defers to the default', () => {
    expect(revalidateOnClassChange(args('cs52', 'cs52', false))).toBe(false);
    expect(revalidateOnClassChange(args('cs52', 'cs52', true))).toBe(true);
  });
});
