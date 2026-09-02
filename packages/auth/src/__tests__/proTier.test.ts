/**
 * Unit tests for `assertProTier` — the Pro gate, lifted out of the webapp's
 * `helpers.ts` so apps/pages can gate the forms subtree with the same rule.
 *
 * There is not much logic here, and that is the point: the tier DECISION lives
 * in `subscription.getProStateForClassroomId`, and this is only the HTTP shell
 * around it. What these tests pin is the shell's contract, because three
 * surfaces now depend on it:
 *
 *  - it THROWS a `Response`, and it throws 403 — not 401, not a redirect, not a
 *    returned value. Route loaders let it propagate to an error boundary; a
 *    returned falsy value would sail straight past `await assertProTier(...)`
 *    at every call site;
 *  - a classroom nobody holds is a 403, not a crash and not a pass. The slug
 *    always arrives after an access check that already proved the classroom
 *    exists, so a miss means a race, and refusing is the safe end of it;
 *  - it never second-guesses the service. Whatever `isPro` says, goes — the
 *    hand-copied `ends_at` comparisons this replaced are exactly how a lapsed
 *    subscription stayed open on one surface after closing on another.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findBySlug: vi.fn(),
  getProState: vi.fn(),
}));

vi.mock('better-auth', () => ({
  betterAuth: () => ({ api: { getSession: vi.fn() } }),
}));
vi.mock('better-auth/adapters/prisma', () => ({ prismaAdapter: () => ({}) }));
vi.mock('better-auth/plugins', () => ({ admin: () => ({}), mcp: () => ({}) }));
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: {
      findBySlug: (...args: unknown[]) => mocks.findBySlug(...args),
      getClassroomForUI: (classroom: unknown) => classroom,
    },
    classroomMembership: { findByClassroomAndUser: vi.fn() },
    subscription: {
      getProStateForClassroomId: (...args: unknown[]) => mocks.getProState(...args),
    },
    audit: { create: vi.fn() },
    githubUserToken: { getGitHubTokenForUser: vi.fn() },
  },
}));

const { assertProTier } = await import('../server.ts');

/** The status of the Response a rejected call threw, or the raw rejection. */
const rejectionOf = async (promise: Promise<unknown>): Promise<Response | unknown> => {
  try {
    await promise;
  } catch (thrown) {
    return thrown;
  }
  throw new Error('expected assertProTier to reject, but it resolved');
};

describe('assertProTier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves for a Pro classroom', async () => {
    mocks.findBySlug.mockResolvedValue({ id: 'classroom-1', slug: 'cs52' });
    mocks.getProState.mockResolvedValue({ isPro: true });

    await expect(assertProTier('cs52')).resolves.toBeUndefined();
    // The decision is asked of the service, by classroom ID — not recomputed
    // here from a tier string and an ends_at.
    expect(mocks.getProState).toHaveBeenCalledWith('classroom-1');
  });

  it('throws a 403 Response for a free classroom', async () => {
    mocks.findBySlug.mockResolvedValue({ id: 'classroom-1', slug: 'cs52' });
    mocks.getProState.mockResolvedValue({ isPro: false });

    const thrown = await rejectionOf(assertProTier('cs52'));
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(403);
  });

  it('throws a 403 when the subscription service returns nothing at all', async () => {
    // `null` is what a classroom with no subscription row produces. It must read
    // as "not Pro", never as "unknown, so allow".
    mocks.findBySlug.mockResolvedValue({ id: 'classroom-1', slug: 'cs52' });
    mocks.getProState.mockResolvedValue(null);

    const thrown = await rejectionOf(assertProTier('cs52'));
    expect((thrown as Response).status).toBe(403);
  });

  it('throws a 403 for a slug no classroom holds, without asking about tier', async () => {
    mocks.findBySlug.mockResolvedValue(null);

    const thrown = await rejectionOf(assertProTier('does-not-exist'));
    expect((thrown as Response).status).toBe(403);
    expect(mocks.getProState).not.toHaveBeenCalled();
  });

  it('rejects rather than resolving falsy — the await at every call site depends on it', async () => {
    mocks.findBySlug.mockResolvedValue({ id: 'classroom-1', slug: 'cs52' });
    mocks.getProState.mockResolvedValue({ isPro: false });

    // Stated as its own case because it is the failure mode that would be
    // silent: every caller writes `await assertProTier(slug)` and reads
    // nothing back, so a version that RETURNED a 403 instead of throwing one
    // would open the feature everywhere and pass a naive test.
    let reached = false;
    try {
      await assertProTier('cs52');
      reached = true;
    } catch {
      // expected
    }
    expect(reached).toBe(false);
  });
});
