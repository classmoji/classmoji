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

export const getByClassroom = async (classroomSlug: string): Promise<CurrentSubscription> => {
  // Classroom slug is unique per git_organization (compound unique), not globally,
  // so we use findFirst here. Callers reach this via authenticated routes that have
  // already constrained the user to a specific classroom, making a same-slug
  // collision in another org irrelevant to the result.
  const classroom = await getPrisma().classroom.findFirst({
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
