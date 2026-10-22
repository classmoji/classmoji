import getPrisma from '@classmoji/database';
import type { BillingEventAction, Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { checkoutPriceId as checkoutPriceIdFromEnv } from '@classmoji/utils';

import StripeService from '../stripe/index.ts';
import { PER_FILE_MAX_BYTES, PRO_QUOTA_BYTES } from '../media/mediaQuota.ts';
import { PLAN_CONTENT_LIMITS } from './planLimits.ts';
import * as subscriptionService from './subscription.service.ts';

/**
 * A user's own plan, as the billing page and the MCP `billing_status` tool
 * show it. Billing is per USER (one plan covers every classroom they own), so
 * nothing here takes a classroom.
 */

/** The parts of a Stripe subscription worth showing; never the raw object. */
export interface BillingSummary {
  status: string;
  priceCents: number | null;
  /** Unix seconds: when the current paid month ends (next charge). */
  currentPeriodEnd: number | null;
  /** Unix seconds: when Pro ends, set only once a cancellation is scheduled. */
  endsAt: number | null;
  card: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  email: string | null;
}

/** One line of the Free vs Pro comparison. */
export interface PlanFeature {
  label: string;
  free: string | boolean;
  pro: string | boolean;
}

export interface BillingStatus {
  tier: 'FREE' | 'PRO';
  /** Pro with no Stripe subscription: given by Classmoji, nothing to manage. */
  isComped: boolean;
  /** Null for Free and comped accounts, or when Stripe could not be reached. */
  billing: BillingSummary | null;
  /** The price checkout sells, for the upgrade offer. Free users only. */
  proPriceCents: number | null;
  features: PlanFeature[];
}

type CardOwner = string | Stripe.PaymentMethod | null | undefined;

const cardOf = (pm: CardOwner): BillingSummary['card'] =>
  pm && typeof pm !== 'string' && pm.card
    ? {
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
      }
    : null;

/**
 * `endsAt` follows the same rule as the webhook's `resolveEndsAt`
 * (apps/hook-station/src/routes/stripe.ts): a scheduled `cancel_at`, else the
 * period end under `cancel_at_period_end`.
 */
export const summarizeSubscription = (sub: Stripe.Subscription): BillingSummary => {
  const raw = sub as unknown as {
    cancel_at?: number | null;
    cancel_at_period_end?: boolean;
    current_period_end?: number | null;
  };
  const item = sub.items?.data?.[0] as
    | (Stripe.SubscriptionItem & { current_period_end?: number })
    | undefined;
  const currentPeriodEnd = item?.current_period_end ?? raw.current_period_end ?? null;
  const endsAt = raw.cancel_at ?? (raw.cancel_at_period_end ? currentPeriodEnd : null);

  const customer =
    typeof sub.customer === 'object' && !('deleted' in sub.customer && sub.customer.deleted)
      ? (sub.customer as Stripe.Customer)
      : null;

  return {
    status: sub.status,
    priceCents: item?.price?.unit_amount ?? null,
    currentPeriodEnd,
    endsAt,
    card:
      cardOf(sub.default_payment_method as CardOwner) ??
      cardOf(customer?.invoice_settings?.default_payment_method as CardOwner),
    email: customer?.email ?? null,
  };
};

/** The price checkout sells (see `proPrice.ts` in `@classmoji/utils`). */
export const checkoutPriceId = (): string => checkoutPriceIdFromEnv();

/**
 * Free vs Pro, from the constants the limits enforce, so every place that
 * lists the plans says what the code actually does.
 */
export const planFeatures = (): PlanFeature[] => {
  const pages = PLAN_CONTENT_LIMITS.FREE.pages;
  const slides = PLAN_CONTENT_LIMITS.FREE.slides;
  return [
    { label: 'Classrooms', free: 'Unlimited', pro: 'Unlimited' },
    { label: 'Repositories', free: 'Unlimited', pro: 'Unlimited' },
    { label: 'Autograding, grading and the gradebook', free: true, pro: true },
    { label: 'Github and Gitlab', free: true, pro: true },
    {
      label: 'Pages per class',
      free: pages === null ? 'Unlimited' : `Up to ${pages}`,
      pro: 'Unlimited',
    },
    {
      label: 'Slides per class',
      free: slides === null ? 'Unlimited' : `Up to ${slides}`,
      pro: 'Unlimited',
    },
    { label: 'AI quizzes', free: false, pro: true },
    { label: 'Ask Moji course assistant', free: false, pro: true },
    { label: 'Forms', free: false, pro: true },
    {
      label: 'Media storage (videos and files)',
      free: false,
      pro: `${Math.round(PRO_QUOTA_BYTES / 1024 ** 3)} GB per class, ${Math.round(
        PER_FILE_MAX_BYTES / 1e9
      )} GB per file`,
    },
    { label: 'Custom domain for the class site', free: false, pro: true },
  ];
};

/** What Pro adds or raises over Free. */
export const proFeatures = (): PlanFeature[] =>
  planFeatures().filter(row => row.free === false || row.free !== row.pro);

/** A row as one line: "Unlimited classrooms", "Forms", "Pages per class: up to 10". */
export const featureText = (label: string, value: string | boolean): string =>
  value === 'Unlimited'
    ? `Unlimited ${label.charAt(0).toLowerCase()}${label.slice(1)}`
    : typeof value === 'string'
      ? `${label}: ${value.charAt(0).toLowerCase()}${value.slice(1)}`
      : label;

/**
 * The caller's own plan. Reads Stripe for the details; a Stripe failure leaves
 * `billing` null rather than failing the whole read.
 */
export const getStatus = async (userId: string): Promise<BillingStatus> => {
  const current = await subscriptionService.getCurrent(userId);
  const tier =
    current.tier === 'PRO' && subscriptionService.isSubscriptionActive(current) ? 'PRO' : 'FREE';

  let billing: BillingSummary | null = null;
  if (tier === 'PRO' && current.stripe_subscription_id) {
    try {
      billing = summarizeSubscription(
        await StripeService.findSubscription(current.stripe_subscription_id)
      );
    } catch (err) {
      console.error('[billing] could not load the Stripe subscription', err);
    }
  }

  let proPriceCents: number | null = null;
  if (tier === 'FREE' && checkoutPriceId()) {
    try {
      proPriceCents = (await StripeService.findPrice(checkoutPriceId())).unit_amount ?? null;
    } catch (err) {
      console.error('[billing] could not load the Pro price', err);
    }
  }

  return {
    tier,
    isComped: tier === 'PRO' && !current.stripe_subscription_id,
    billing,
    proPriceCents,
    features: planFeatures(),
  };
};

export interface BillingEventInput {
  userId: string;
  action: BillingEventAction;
  /** `web:billing`, `stripe:webhook`. */
  source: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeEventId?: string | null;
  data?: Prisma.InputJsonValue;
}

/**
 * Record a billing event. Never throws: the record is for people reading it
 * later, and a failed write must not stop a checkout or fail a webhook (which
 * Stripe would then redeliver, writing the grant twice).
 */
export const recordEvent = async (input: BillingEventInput): Promise<void> => {
  try {
    await getPrisma().billingEvent.create({
      data: {
        user_id: input.userId,
        action: input.action,
        source: input.source,
        stripe_customer_id: input.stripeCustomerId ?? null,
        stripe_subscription_id: input.stripeSubscriptionId ?? null,
        stripe_event_id: input.stripeEventId ?? null,
        ...(input.data !== undefined ? { data: input.data } : {}),
      },
    });
  } catch (err) {
    console.error('[billing] could not record a billing event', { action: input.action, err });
  }
};
