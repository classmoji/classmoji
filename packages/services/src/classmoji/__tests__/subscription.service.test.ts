/**
 * Unit tests for the subscription primitives every paid feature gates on.
 *
 * Two decisions live here and nowhere else, which is the point of the file:
 *
 *  - `isSubscriptionActive` — the `ends_at` test that used to be hand-copied
 *    into the webapp, the MCP server and the `useSubscription` hook. The row
 *    shape that matters is `{tier:'PRO', ends_at: <past>}`: the Stripe handlers
 *    stamp `ends_at` rather than rewriting `tier`, so a gate that reads `tier`
 *    alone serves a cancelled account forever.
 *  - `getProStateForClassroomId` — which owner's subscription a classroom's
 *    tier comes from when it has several. The rule is "any accepted owner with
 *    an active PRO wins", and the case that forced it is real: cs87 at
 *    Dartmouth has five owners whose first-positioned members are FREE, so the
 *    old `memberships[0]` pick reported the wrong tier there.
 *
 * Prisma is mocked; the decisions run for real against hand-built rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const classroomFindUnique = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: { findUnique: classroomFindUnique },
  }),
}));

const { isSubscriptionActive, getProStateForClassroomId } =
  await import('../subscription.service.ts');

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + HOUR);
const past = () => new Date(Date.now() - HOUR);

/** A classroom row shaped exactly as getProStateForClassroomId selects it. */
const classroomWithOwners = (
  ...owners: Array<{ tier: 'FREE' | 'PRO'; ends_at?: Date | null } | null>
) => ({
  memberships: owners.map((subscription, index) => ({
    user: {
      subscriptions: subscription
        ? [{ id: `sub-${index}`, tier: subscription.tier, ends_at: subscription.ends_at ?? null }]
        : [],
    },
  })),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isSubscriptionActive', () => {
  it('treats a null ends_at as open-ended, not expired', () => {
    // This is how a COMPED Pro account is stored — no Stripe subscription and
    // no end date — and it is every Pro account in production today.
    expect(isSubscriptionActive({ ends_at: null })).toBe(true);
    expect(isSubscriptionActive({})).toBe(true);
  });

  it('accepts a future end date and refuses a past one', () => {
    expect(isSubscriptionActive({ ends_at: future() })).toBe(true);
    expect(isSubscriptionActive({ ends_at: past() })).toBe(false);
  });

  it('parses a string timestamp the same way', () => {
    // Rows crossing a JSON boundary (a cached loader payload, a webhook body)
    // arrive as ISO strings.
    expect(isSubscriptionActive({ ends_at: future().toISOString() })).toBe(true);
    expect(isSubscriptionActive({ ends_at: past().toISOString() })).toBe(false);
  });

  it('refuses a missing row and an unparseable date', () => {
    expect(isSubscriptionActive(null)).toBe(false);
    expect(isSubscriptionActive(undefined)).toBe(false);
    // Garbage is not a licence to serve a paid feature.
    expect(isSubscriptionActive({ ends_at: 'not a date' })).toBe(false);
  });
});

describe('getProStateForClassroomId', () => {
  it('returns FREE for a classroom that does not exist', async () => {
    classroomFindUnique.mockResolvedValue(null);
    await expect(getProStateForClassroomId('nope')).resolves.toMatchObject({
      tier: 'FREE',
      isPro: false,
    });
  });

  it('returns FREE for a classroom with no accepted owners', async () => {
    classroomFindUnique.mockResolvedValue({ memberships: [] });
    await expect(getProStateForClassroomId('class-1')).resolves.toMatchObject({
      tier: 'FREE',
      isPro: false,
    });
  });

  it('returns FREE when the owner has never had a subscription row', async () => {
    classroomFindUnique.mockResolvedValue(classroomWithOwners(null));
    await expect(getProStateForClassroomId('class-1')).resolves.toMatchObject({
      tier: 'FREE',
      isPro: false,
    });
  });

  it('passes a comped PRO owner (no end date)', async () => {
    classroomFindUnique.mockResolvedValue(classroomWithOwners({ tier: 'PRO', ends_at: null }));
    await expect(getProStateForClassroomId('class-1')).resolves.toMatchObject({
      tier: 'PRO',
      isActive: true,
      isPro: true,
    });
  });

  it('REFUSES a lapsed {tier:PRO, ends_at: past} row', async () => {
    // The exact shape the `deleted` webhook used to leave behind. `tier` still
    // says PRO; only the activity test catches it.
    classroomFindUnique.mockResolvedValue(classroomWithOwners({ tier: 'PRO', ends_at: past() }));
    await expect(getProStateForClassroomId('class-1')).resolves.toMatchObject({
      tier: 'PRO',
      isActive: false,
      isPro: false,
    });
  });

  it('passes a PRO owner whose term has not run out yet', async () => {
    // The cancel_at_period_end shape: cancelled, but paid through the period.
    classroomFindUnique.mockResolvedValue(classroomWithOwners({ tier: 'PRO', ends_at: future() }));
    await expect(getProStateForClassroomId('class-1')).resolves.toMatchObject({ isPro: true });
  });

  describe('multiple owners', () => {
    it('any owner with an active PRO wins, even when the oldest is FREE', async () => {
      // cs87-dartmouth, exactly: five owners, the first-positioned ones FREE.
      // "Oldest owner" would report FREE and strip quizzes from a live class.
      classroomFindUnique.mockResolvedValue(
        classroomWithOwners(
          { tier: 'FREE' },
          { tier: 'FREE' },
          { tier: 'PRO', ends_at: null },
          { tier: 'FREE' }
        )
      );
      await expect(getProStateForClassroomId('class-1')).resolves.toMatchObject({
        tier: 'PRO',
        isPro: true,
      });
    });

    it('a LAPSED PRO co-owner does not rescue the classroom', async () => {
      classroomFindUnique.mockResolvedValue(
        classroomWithOwners({ tier: 'FREE' }, { tier: 'PRO', ends_at: past() })
      );
      await expect(getProStateForClassroomId('class-1')).resolves.toMatchObject({
        tier: 'FREE',
        isPro: false,
      });
    });

    it('falls back to the OLDEST owner when nobody holds an active PRO', async () => {
      // Deterministic, so a FREE answer names a specific row instead of varying
      // between calls. `sub-0` is the first membership, ordered created_at asc.
      classroomFindUnique.mockResolvedValue(
        classroomWithOwners({ tier: 'PRO', ends_at: past() }, { tier: 'FREE' })
      );
      const state = await getProStateForClassroomId('class-1');
      expect(state.isPro).toBe(false);
      expect(state.subscription?.id).toBe('sub-0');
    });
  });

  it('asks only for ACCEPTED owners, ordered oldest first', async () => {
    // An unaccepted OWNER membership is an invitation. It must not donate the
    // invitee's subscription to a classroom they have not joined — the same
    // line resolveSiteContext draws for viewers.
    classroomFindUnique.mockResolvedValue({ memberships: [] });
    await getProStateForClassroomId('class-1');

    const [args] = classroomFindUnique.mock.calls[0] as [
      {
        where: { id: string };
        select: {
          memberships: {
            where: { role: string; has_accepted_invite: boolean };
            orderBy: { created_at: string };
          };
        };
      },
    ];
    expect(args.where).toEqual({ id: 'class-1' });
    expect(args.select.memberships.where).toEqual({ role: 'OWNER', has_accepted_invite: true });
    expect(args.select.memberships.orderBy).toEqual({ created_at: 'asc' });
  });
});
