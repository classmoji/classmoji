import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Stripe from 'stripe';
import { ClassmojiService, StripeService } from '@classmoji/services';
import dayjs from 'dayjs';

interface BillingUser {
  id: string;
}

const getCustomerId = (
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null
): string | null => {
  if (!customer) {
    return null;
  }

  return typeof customer === 'string' ? customer : customer.id;
};

const stripeWebhookHandlers: Record<
  string,
  (user: BillingUser | null, subscription: Stripe.Subscription) => Promise<void>
> = {
  'customer.subscription.created': async (
    user: BillingUser | null,
    subscription: Stripe.Subscription
  ) => {
    if (!user) {
      return;
    }

    try {
      const currentSubscription = await ClassmojiService.subscription.getCurrent(user.id);

      if (currentSubscription?.id) {
        await ClassmojiService.subscription.update(currentSubscription.id, {
          ends_at: new Date(),
        });
      }

      await ClassmojiService.subscription.create({
        user_id: user.id,
        tier: 'PRO',
        started_at: new Date(),
        stripe_subscription_id: subscription.id,
      });
    } catch (error: unknown) {
      console.error('Error in customer.subscription.created', error);
    }
  },

  'customer.subscription.updated': async (
    user: BillingUser | null,
    subscription: Stripe.Subscription
  ) => {
    if (!user || !subscription.canceled_at) {
      return;
    }

    const subscriptionUpdate = {
      cancelled_at: dayjs.unix(subscription.canceled_at).toDate(),
      cancellation_reason: subscription.cancellation_details?.reason,
      ends_at: new Date(),
    };

    try {
      const currentSubscription = await ClassmojiService.subscription.getCurrent(user.id);
      if (!currentSubscription?.id) {
        return;
      }

      const isNewSubscription = dayjs().diff(currentSubscription.created_at, 'seconds') < 30;
      if (isNewSubscription) {
        return;
      }

      await ClassmojiService.subscription.update(currentSubscription.id, subscriptionUpdate);
      await ClassmojiService.subscription.create({
        user_id: user.id,
        tier: 'FREE',
      });
    } catch (error: unknown) {
      console.error('Error in customer.subscription.updated', error);
    }
  },

  'customer.subscription.deleted': async (
    _user: BillingUser | null,
    subscription: Stripe.Subscription
  ) => {
    try {
      const classmojiSubscription = await ClassmojiService.subscription.findBy({
        where: {
          stripe_subscription_id: subscription.id,
        },
      });

      if (classmojiSubscription?.id) {
        await ClassmojiService.subscription.update(classmojiSubscription.id, {
          ends_at: new Date(),
        });
      }
    } catch (error: unknown) {
      console.error('Error in customer.subscription.deleted', error);
    }
  },
};

export default async function stripeRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/stripe', {
    config: { rawBody: true },
    handler: async function handler(request: FastifyRequest, reply: FastifyReply) {
      const signature = request.headers['stripe-signature'];
      const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;

      if (typeof signature !== 'string' || !rawBody) {
        return reply.status(401).send('Unauthorized');
      }

      let event: Stripe.Event;
      try {
        event = StripeService.constructWebhookEvent(rawBody, signature);
      } catch (err: unknown) {
        request.log.warn({ err }, 'Stripe webhook signature verification failed');
        return reply.status(401).send('Unauthorized');
      }

      const handler = stripeWebhookHandlers[event.type];
      if (!handler) {
        return reply.status(200).send({ success: true });
      }

      const subscription = event.data.object as Stripe.Subscription;
      const customerId = getCustomerId(subscription.customer);

      const user = customerId
        ? await ClassmojiService.user.findBy({
            where: {
              stripe_customer_id: customerId,
            },
          })
        : null;

      await handler(user, subscription);

      return reply.status(200).send({ success: true });
    },
  });
}
