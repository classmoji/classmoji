import { ClassmojiService } from '@classmoji/services';
import dayjs from 'dayjs';

const stripeWebhookHandlers = {
  'customer.subscription.created': async (user, subscription) => {
    try {
      // * cancel current subscription (always exists)
      // * this usually happens when user upgrades to a paid tier
      // * free users do not have a Stripe subscription
      const currentSubscription = await ClassmojiService.subscription.getCurrent(user.id);

      // * expire current free tier subscription (only if it exists in DB)
      if (currentSubscription?.id) {
        await ClassmojiService.subscription.update(currentSubscription.id, {
          ends_at: new Date(),
        });
      }

      // * create new paid tier subscription
      await ClassmojiService.subscription.create({
        user_id: user.id,
        tier: 'PRO',
        started_at: new Date(),
        stripe_subscription_id: subscription.id,
      });
    } catch (error) {
      console.error('❌ Error in customer.subscription.created', error);
    }
  },

  'customer.subscription.updated': async (user, subscription) => {
    const subscriptionUpdate = {
      cancelled_at: dayjs.unix(subscription.canceled_at).toDate(),
      cancellation_reason: subscription.cancellation_details?.reason,
      ends_at: new Date(),
    };

    try {
      // * subscription was canceled
      if (subscription.canceled_at) {
        // * update current subscription
        const currentSubscription = await ClassmojiService.subscription.getCurrent(user.id);

        // * only update if subscription exists in DB
        if (!currentSubscription?.id) return;

        // * check if current subscription was created within the last like 30 seconds
        const isNewSubscription = dayjs().diff(currentSubscription.created_at, 'seconds') < 30;

        // * handle double webhook calls within 60 seconds
        if (isNewSubscription) return;

        await ClassmojiService.subscription.update(currentSubscription.id, subscriptionUpdate);

        // * create new subscription with free tier
        await ClassmojiService.subscription.create({
          user_id: user.id,
          tier: 'FREE',
        });
      }
    } catch (error) {
      console.error('❌ Error in customer.subscription.updated', error);
    }
  },

  'customer.subscription.deleted': async (_, subscription) => {
    try {
      const classmojiSubscription = await ClassmojiService.subscription.findBy({
        where: {
          stripe_subscription_id: subscription.id,
        },
      });

      // * stripe immediately expires the subscription
      if (classmojiSubscription?.id) {
        await ClassmojiService.subscription.update(classmojiSubscription.id, {
          ends_at: new Date(),
        });
      }
    } catch (error) {
      console.error('❌ Error in customer.subscription.deleted', error);
    }
  },
};

export default async function stripeRoutes(fastify) {
  fastify.post('/stripe', {
    preHandler: async function () {},
    handler: async function (request, reply) {
      const handler = stripeWebhookHandlers[request.body.type];
      const subscription = request.body.data.object;
      const user = await ClassmojiService.user.findBy({
        where: {
          stripe_customer_id: subscription.customer,
        },
      });
      if (handler) {
        await handler(user, subscription);
      }
      return reply.status(200).send({ success: true });
    },
  });
}
