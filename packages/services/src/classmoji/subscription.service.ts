import getPrisma from '@classmoji/database';
import type { Prisma, SubscriptionTier } from '@prisma/client';

type SubscriptionRecord = Prisma.SubscriptionGetPayload<Record<string, never>>;

type CurrentSubscription =
  | SubscriptionRecord
  | {
      id: null;
      tier: SubscriptionTier;
      stripe_subscription_id?: null;
      started_at?: null;
      ends_at?: null;
      cancelled_at?: null;
      cancellation_reason?: null;
      created_at?: null;
      updated_at?: null;
      user_id?: null;
    };

export const create = async (
  data: Prisma.SubscriptionUncheckedCreateInput
): Promise<SubscriptionRecord> => {
  return getPrisma().subscription.create({
    data,
  });
};

export const getCurrent = async (userId: string): Promise<CurrentSubscription> => {
  const subscription = await getPrisma().subscription.findFirst({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
  });

  // Return a default FREE subscription object if none exists
  if (!subscription) {
    return {
      id: null,
      tier: 'FREE',
      stripe_subscription_id: null,
      started_at: null,
      ends_at: null,
      cancelled_at: null,
      cancellation_reason: null,
      created_at: null,
      updated_at: null,
      user_id: null,
    };
  }

  return subscription;
};

export const findBy = async ({
  where,
}: {
  where: Prisma.SubscriptionWhereUniqueInput;
}): Promise<SubscriptionRecord | null> => {
  return getPrisma().subscription.findUnique({
    where,
  });
};

export const update = async (
  subscriptionId: string,
  data: Prisma.SubscriptionUpdateInput
): Promise<SubscriptionRecord> => {
  return getPrisma().subscription.update({
    where: {
      id: subscriptionId,
    },
    data,
  });
};

export const deleteByUserId = async (userId: string): Promise<SubscriptionRecord> => {
  return getPrisma().subscription.delete({
    where: {
      user_id: userId,
    },
  } as unknown as { where: Prisma.SubscriptionWhereUniqueInput });
};

/**
 * The shape every activity test needs — deliberately structural, so a caller can
 * hand this a full `Subscription` row, a `CurrentSubscription` placeholder, or a
 * narrow `select` without a cast.
 */
export type SubscriptionActivity = {
  ends_at?: Date | string | null;
};

/**
 * Is this subscription live RIGHT NOW?
 *
 * THE single definition of "active", extracted because it was hand-copied into
 * four places (webapp `assertProTier`, the MCP mirror, `useSubscription`, and —
 * had this not landed first — the class-site serving path). Four copies of a
 * one-line predicate is four chances to write `>=` instead of `>`, or to forget
 * it entirely and gate on `tier` alone.
 *
 * A null `ends_at` means OPEN-ENDED, not expired: that is how a comped PRO row
 * is stored (no Stripe subscription, no end date), and every PRO account in
 * production today is that shape. An `ends_at` in the past is a lapsed row that
 * `tier` alone still reports as PRO forever — see the `customer.subscription.*`
 * handlers in apps/hook-station, which stamp `ends_at` rather than rewriting
 * `tier`.
 */
export function isSubscriptionActive(
  subscription: SubscriptionActivity | null | undefined
): boolean {
  if (!subscription) return false;
  const endsAt = subscription.ends_at;
  if (endsAt === null || endsAt === undefined) return true;
  const ends = endsAt instanceof Date ? endsAt.getTime() : new Date(endsAt).getTime();
  // An unparseable timestamp is not a licence to serve a paid feature.
  if (Number.isNaN(ends)) return false;
  return ends > Date.now();
}

/** A classroom's effective billing tier, resolved across every owner. */
export type ClassroomProState = {
  tier: SubscriptionTier;
  /** Is the row behind `tier` still live? (See isSubscriptionActive.) */
  isActive: boolean;
  /** The only question a gate ever asks: `tier === 'PRO' && isActive`. */
  isPro: boolean;
  /** The row the decision came from, or null when it fell back to FREE. */
  subscription: SubscriptionRecord | null;
};

const FREE_STATE: ClassroomProState = {
  tier: 'FREE',
  isActive: false,
  isPro: false,
  subscription: null,
};

/**
 * THE classroom tier decision, by classroom id.
 *
 * Two rules, and the order between them is the whole point:
 *
 *  1. **Any owner with an active PRO wins.** A classroom can legitimately have
 *     several OWNER memberships (`@@unique([classroom_id, user_id, role])` is
 *     per-user, not per-classroom), and they do not share a billing account.
 *     Picking one owner and asking only them — which is what `getByClassroom`'s
 *     `memberships[0]` does — makes the answer depend on row order: cs87 at
 *     Dartmouth has five owners whose first-positioned members are FREE, so the
 *     arbitrary pick is already returning the wrong tier there. Resolving
 *     across all owners is also the only TIER-PRESERVING rule; "oldest owner"
 *     is merely deterministic, and would strip quizzes from any classroom whose
 *     paying owner is not the oldest.
 *  2. **Otherwise, the oldest owner's tier**, so a FREE answer still names a
 *     specific row rather than varying between calls.
 *
 * Only ACCEPTED owners count. An unaccepted OWNER membership is an invitation,
 * and an invitation must not donate its recipient's subscription to a classroom
 * they have not joined — the same line `resolveSiteContext` draws for viewers.
 * Every code path that mints the founding OWNER sets `has_accepted_invite: true`
 * at creation, so this narrows pending co-owners only.
 *
 * Takes a classroom ID, never a slug: both call sites (route gates and the
 * site-serving path) already hold one, and an id cannot be re-pointed at a
 * different classroom by a rename.
 */
export const getProStateForClassroomId = async (
  classroomId: string
): Promise<ClassroomProState> => {
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    select: {
      memberships: {
        where: { role: 'OWNER', has_accepted_invite: true },
        // Oldest first, so the fallback below is the oldest owner without a
        // second query.
        orderBy: { created_at: 'asc' },
        select: {
          user: {
            select: {
              subscriptions: {
                orderBy: { created_at: 'desc' },
                take: 1,
              },
            },
          },
        },
      },
    },
  });

  if (!classroom || classroom.memberships.length === 0) return FREE_STATE;

  const current = classroom.memberships.map(membership => membership.user.subscriptions[0] ?? null);

  const pro = current.find(
    subscription => subscription?.tier === 'PRO' && isSubscriptionActive(subscription)
  );
  if (pro) return { tier: 'PRO', isActive: true, isPro: true, subscription: pro };

  const oldest = current[0];
  if (!oldest) return FREE_STATE;

  const isActive = isSubscriptionActive(oldest);
  return {
    tier: oldest.tier,
    isActive,
    isPro: oldest.tier === 'PRO' && isActive,
    subscription: oldest,
  };
};

/**
 * The owner's subscription for a classroom SLUG.
 *
 * Superseded by `getProStateForClassroomId` for every tier decision — it picks
 * an arbitrary owner and does not test `ends_at`. Kept because
 * `apps/webapp/app/routes/api.$operation` calls it with a git-org login rather
 * than a classroom slug (a separate pre-existing oddity), and the webapp test
 * helpers seed against its shape.
 */
export const getByClassroom = async (classroomSlug: string): Promise<CurrentSubscription> => {
  // Classroom slug is globally unique, so this resolves to exactly one classroom.
  // The tier is the OWNER's most recent subscription — billing follows the person
  // who owns the classroom, not the caller.
  const classroom = await getPrisma().classroom.findUnique({
    where: { slug: classroomSlug },
    include: {
      memberships: {
        where: { role: 'OWNER' },
        include: {
          user: {
            include: {
              subscriptions: {
                orderBy: { created_at: 'desc' },
                take: 1,
              },
            },
          },
        },
      },
    },
  });

  if (!classroom || !classroom.memberships.length) {
    return { tier: 'FREE', id: null };
  }

  const owner = classroom.memberships[0].user;

  if (!owner.subscriptions.length) {
    return { tier: 'FREE', id: null };
  }

  return owner.subscriptions[0];
};
