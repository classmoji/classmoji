import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Stripe from 'stripe';
import { ClassmojiService, StripeService } from '@classmoji/services';
import { getPrisma } from '@classmoji/database';
import dayjs from 'dayjs';

/**
 * Stripe subscription webhooks.
 *
 * These handlers are the ONLY writers of the `subscriptions` table's billing
 * state, and that table is now what gates two paid features (quizzes and
 * class-site custom domains) through
 * `subscription.getProStateForClassroomId`. Three properties follow from that,
 * and each one is a bug this file used to have:
 *
 *  - **`ends_at` is Stripe's date, not ours.** Under `cancel_at_period_end` —
 *    the standard billing-portal cancel — Stripe sets `canceled_at` to the
 *    moment the button was clicked and keeps the subscription usable until
 *    `current_period_end`. Writing `new Date()` there ended the paid term the
 *    instant someone clicked Cancel, weeks early.
 *  - **Only PRO prices grant PRO.** The handler used to write `tier: 'PRO'` for
 *    any subscription on the account. The price is now asserted against
 *    `STRIPE_PRO_PRICE_ID` and an unrecognized one writes NOTHING.
 *  - **The newest row wins.** `subscription.getCurrent` orders by `created_at`
 *    desc, so creating a FREE successor row is how an account is demoted — and
 *    creating one EAGERLY (at cancel-request time, as `updated` used to) makes
 *    a correct future `ends_at` unreachable, because the FREE row shadows the
 *    PRO row immediately. The successor is therefore created only by
 *    `deleted`, when the term is genuinely over.
 *  - **"Processed" means the handler succeeded.** The event is recorded, and the
 *    delivery answered 200, only after the handler returns. A thrown handler is
 *    a 5xx with no row, which is what makes Stripe's ~3 days of retries the
 *    recovery path a one-shot grant needs. A deliberate REFUSAL is not a
 *    failure and keeps its 200 — an endpoint that never 2xxs is one Stripe
 *    eventually disables.
 */

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

/**
 * The configured Pro price, or a throw.
 *
 * Deliberately split from the comparison below, because an unset variable and a
 * foreign price are opposite situations that used to share one `false`:
 *
 *  - **Unset is OUR bug.** Nothing about this delivery is wrong; this
 *    deployment cannot judge it. Throwing turns the webhook into a non-2xx, so
 *    Stripe keeps redelivering for ~3 days and the grant lands by itself once
 *    `fly secrets set STRIPE_PRO_PRICE_ID` reaches THIS app — hook-station is a
 *    separate Fly app from the webapp, with its own secret store, so setting it
 *    on one and not the other is a single missed command away.
 *  - **A foreign price is a real answer.** See `matchesProPrice`.
 *
 * Still fails closed either way: no branch here can mint a PRO row.
 */
const getProPriceId = (): string => {
  const proPriceId = (process.env.STRIPE_PRO_PRICE_ID || '').trim();
  if (!proPriceId) {
    throw new Error(
      'STRIPE_PRO_PRICE_ID is not set on hook-station; refusing to judge a subscription price.'
    );
  }
  return proPriceId;
};

/**
 * Does this Stripe subscription carry the Pro price?
 *
 * Checked before ANY write that grants PRO. Checkout is a customer-facing flow
 * and the price it is handed has, historically, come from the browser; without
 * this assertion a subscription to any price at all — a $0 test price, a
 * different product — mints a PRO row here.
 */
const matchesProPrice = (subscription: Stripe.Subscription, proPriceId: string): boolean => {
  const items = subscription.items?.data ?? [];
  return items.some(item => item.price?.id === proPriceId);
};

/**
 * When does this subscription's paid access actually end?
 *
 * Preference order, and each fallback is a real Stripe shape:
 *  1. `cancel_at` — set when a cancellation is SCHEDULED for a specific time.
 *  2. `current_period_end` under `cancel_at_period_end` — the ordinary
 *     "cancel at the end of the month" flow.
 *  3. `ended_at` — the subscription is already over.
 *  4. `null` — no end is known, which for an active subscription is correct:
 *     an open-ended row is what `isSubscriptionActive` reads as live.
 *
 * `canceled_at` is deliberately NOT in this list. It is the timestamp of the
 * REQUEST, not of the expiry, and treating it as an end date is exactly the bug
 * this replaces.
 */
const resolveEndsAt = (subscription: Stripe.Subscription): Date | null => {
  const raw = subscription as unknown as {
    cancel_at?: number | null;
    cancel_at_period_end?: boolean;
    current_period_end?: number | null;
    ended_at?: number | null;
  };

  if (raw.cancel_at) return dayjs.unix(raw.cancel_at).toDate();
  if (raw.cancel_at_period_end && raw.current_period_end) {
    return dayjs.unix(raw.current_period_end).toDate();
  }
  if (raw.ended_at) return dayjs.unix(raw.ended_at).toDate();
  return null;
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
      // A customer nobody here owns. Retrying cannot make them matchable, so
      // this is a finished delivery, not a failure.
      return;
    }

    // Throws when the variable is missing — see getProPriceId. Read BEFORE any
    // database work so a misconfigured deployment fails without a half-write.
    const proPriceId = getProPriceId();

    if (!matchesProPrice(subscription, proPriceId)) {
      // A price we do not sell: someone else's SKU, or a leftover test price.
      // Write nothing, and treat the delivery as finished — retrying will
      // produce the same answer forever, and an endpoint that never 2xxs is one
      // Stripe eventually disables.
      console.warn(
        `Stripe subscription ${subscription.id} does not carry STRIPE_PRO_PRICE_ID — no tier granted`
      );
      return;
    }

    // Idempotent under redelivery, which now actually happens: a failure after
    // this point is answered with a 5xx and Stripe sends the event again.
    // Without this check the retry would expire the PRO row it just minted and
    // mint a duplicate. `stripe_subscription_id` is unique.
    const existing = await ClassmojiService.subscription.findBy({
      where: { stripe_subscription_id: subscription.id },
    });
    if (existing?.id) {
      return;
    }

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
      ends_at: resolveEndsAt(subscription),
      stripe_subscription_id: subscription.id,
    });
  },

  /**
   * Every mid-life change: cancel requested, cancel undone, plan updated,
   * renewal.
   *
   * Resolves the row by `stripe_subscription_id` rather than "the newest row
   * for this user", so an event about one subscription can never rewrite
   * another's dates. Writes only the end date and the cancellation metadata —
   * the tier does not change here, because a scheduled cancellation is still
   * PRO until the term runs out, and `deleted` is what finally demotes.
   *
   * Un-cancelling is handled by the same path with no special case: Stripe
   * clears `cancel_at`/`cancel_at_period_end`, `resolveEndsAt` returns null,
   * and the row goes back to open-ended. The previous version early-returned
   * unless `canceled_at` was set, so a customer who changed their mind stayed
   * scheduled for expiry forever.
   *
   * The old 30-second "is this subscription brand new?" guard is gone with the
   * bug it papered over. It existed because `created` and `updated` arrive
   * together and the old handler's response to any `updated` was to expire the
   * account; resolving by `stripe_subscription_id` and writing only dates makes
   * an `updated` for a fresh subscription a no-op write of the same values. It
   * also removes an ordering assumption — Stripe does not guarantee `created`
   * arrives first, and an `updated` that gets there early simply finds no row.
   */
  'customer.subscription.updated': async (
    _user: BillingUser | null,
    subscription: Stripe.Subscription
  ) => {
    const existing = await ClassmojiService.subscription.findBy({
      where: { stripe_subscription_id: subscription.id },
    });
    if (!existing?.id) {
      return;
    }

    await ClassmojiService.subscription.update(existing.id, {
      ends_at: resolveEndsAt(subscription),
      cancelled_at: subscription.canceled_at ? dayjs.unix(subscription.canceled_at).toDate() : null,
      cancellation_reason: subscription.cancellation_details?.reason ?? null,
    });
  },

  /**
   * The subscription is over: close the PRO row and create the FREE successor.
   *
   * The successor is the half that used to be missing, and its absence was not
   * cosmetic. `getCurrent` returns the newest row, so without it the newest row
   * for a cancelled account stays `{ tier: 'PRO', ends_at: <past> }` forever —
   * live to any gate that reads `tier` alone, and only ever caught by the
   * `ends_at` test that now lives in `isSubscriptionActive`. Belt and braces:
   * the row says FREE *and* the old row has expired.
   *
   * `ends_at` prefers Stripe's `ended_at` over "now" so that a delivery delayed
   * by a retry storm records when the subscription actually ended.
   */
  'customer.subscription.deleted': async (
    _user: BillingUser | null,
    subscription: Stripe.Subscription
  ) => {
    const classmojiSubscription = await ClassmojiService.subscription.findBy({
      where: {
        stripe_subscription_id: subscription.id,
      },
    });

    if (!classmojiSubscription?.id) {
      return;
    }

    const endedAt = (subscription as unknown as { ended_at?: number | null }).ended_at;
    await ClassmojiService.subscription.update(classmojiSubscription.id, {
      ends_at: endedAt ? dayjs.unix(endedAt).toDate() : new Date(),
    });

    await ClassmojiService.subscription.create({
      user_id: classmojiSubscription.user_id,
      tier: 'FREE',
    });
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

      // Idempotency: Stripe retries deliveries; reject duplicates so a retry
      // doesn't produce a second subscription row.
      const prisma = getPrisma();
      const alreadyProcessed = await prisma.processedWebhookEvent.findUnique({
        where: { event_id: event.id },
      });
      if (alreadyProcessed) {
        return reply.status(200).send({ success: true, duplicate: true });
      }

      const handler = stripeWebhookHandlers[event.type];
      if (!handler) {
        await prisma.processedWebhookEvent.create({
          data: { event_id: event.id, source: 'stripe' },
        });
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

      // "Processed" must mean the handler SUCCEEDED, not merely that it ran.
      // Marking it first and answering 200 regardless made Stripe's retries —
      // the only recovery path a one-shot grant has — unreachable: a redelivery
      // of the same event.id short-circuits above without running anything, so a
      // transient failure lost a paid PRO grant permanently and silently.
      try {
        await handler(user, subscription);
      } catch (err: unknown) {
        request.log.error({ err, eventId: event.id, type: event.type }, 'Stripe handler failed');
        // No processed row: Stripe redelivers for ~3 days, and the handlers are
        // idempotent, so the retry either finishes the job or fails the same way
        // loudly. A refusal is NOT routed here — see the handlers.
        return reply.status(500).send({ error: 'handler failed' });
      }

      await prisma.processedWebhookEvent.create({
        data: { event_id: event.id, source: 'stripe' },
      });

      return reply.status(200).send({ success: true });
    },
  });
}
