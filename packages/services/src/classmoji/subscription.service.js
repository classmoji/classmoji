import prisma from '@classmoji/database';

export const create = async data => {
  return prisma.subscription.create({
    data,
  });
};

export const getCurrent = async userId => {
  const subscription = await prisma.subscription.findFirst({
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
    };
  }

  return subscription;
};

export const findBy = async ({ where }) => {
  return prisma.subscription.findUnique({
    where,
  });
};

export const update = async (subscriptionId, data) => {
  return prisma.subscription.update({
    where: {
      id: subscriptionId,
    },
    data,
  });
};

export const deleteByUserId = async userId => {
  return prisma.subscription.delete({
    where: {
      user_id: userId,
    },
  });
};

export const getByClassroom = async classroomSlug => {
  // organizationLogin is now classroomSlug
  const classroom = await prisma.classroom.findUnique({
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
