import { Spin } from 'antd';
import { useFetcher, useLocation } from 'react-router';
import { useEffect, useState, useRef } from 'react';
import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService, StripeService } from '@classmoji/services';
import { useCallout } from '@classmoji/ui-components';
import FreePlans from './FreePlans';
import ProBilling from './ProBilling';
import type { PortalFlow } from './ProBilling';
import { getAuthSession } from '@classmoji/auth/server';
import type { Route } from './+types/route';

/** `data.tool` / `source` for every billing event written from this page. */
const SOURCE = 'web:billing';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await getAuthSession(request);
  const { billing: billingService } = ClassmojiService;

  // The caller's own plan only: a normal page load of one's own state, so no
  // event is recorded.
  const status = await billingService.getStatus(authData!.userId);

  return {
    tier: status.tier,
    isComped: status.isComped,
    billing: status.billing,
    proPriceCents: status.proPriceCents,
    // As display lines, so the components need nothing from the server bundle.
    freeLines: status.features
      .filter(row => row.free !== false)
      .map(row => billingService.featureText(row.label, row.free)),
    proLines: billingService.proFeatures().map(row => billingService.featureText(row.label, row.pro)),
  };
};

const SettingsSubscription = ({ loaderData }: Route.ComponentProps) => {
  const { tier, billing, isComped, proPriceCents, freeLines, proLines } = loaderData;
  const fetcher = useFetcher();
  const [loading, setLoading] = useState(false);
  const { search } = useLocation();
  const toastShownRef = useRef(new Set());
  const callout = useCallout();

  useEffect(() => {
    const url = new URLSearchParams(search);
    const success = url.get('success');
    const sessionId = url.get('session_id');

    if (success && sessionId && !toastShownRef.current.has(sessionId)) {
      callout.show({ variant: 'success', title: 'Subscription updated successfully' });
      toastShownRef.current.add(sessionId);
    }
  }, [search]);

  useEffect(() => {
    if (fetcher.data?.checkoutSessionUrl) {
      window.location.href = fetcher.data.checkoutSessionUrl;
    } else if (fetcher.data?.billingPortalSessionUrl) {
      window.location.href = fetcher.data.billingPortalSessionUrl;
    } else if (fetcher.data?.error) {
      // Nothing to navigate to — drop the fullscreen spinner, which otherwise
      // covers the page until a reload.
      setLoading(false);
      callout.show({ variant: 'error', title: fetcher.data.error });
    }
  }, [fetcher.data]);

  const handleUpgrade = () => {
    setLoading(true);
    // No price in the body: which price grants Pro is a server decision, and
    // the action resolves it from the environment. See createCheckoutSession.
    fetcher.submit(
      {},
      {
        method: 'post',
        encType: 'application/json',
        action: '?/createCheckoutSession',
      }
    );
  };

  // `flow` only picks which portal screen opens; the subscription it acts on
  // is resolved on the server.
  const handlePortal = (flow?: PortalFlow) => {
    setLoading(true);
    fetcher.submit(flow ? { flow } : {}, {
      method: 'post',
      encType: 'application/json',
      action: '?/createBillingPortalSession',
    });
  };

  return (
    <>
      <Spin spinning={loading} fullscreen />
      {tier === 'PRO' ? (
        <ProBilling
          billing={billing}
          isComped={isComped}
          proLines={proLines}
          onPortal={handlePortal}
        />
      ) : (
        <FreePlans
          freeLines={freeLines}
          proLines={proLines}
          proPriceCents={proPriceCents}
          onUpgrade={handleUpgrade}
        />
      )}
    </>
  );
};

export const action = async ({ request }: Route.ActionArgs) => {
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { flow?: unknown };
  const authData = await getAuthSession(request);
  const userId = authData!.userId;
  const classmojiUser = await ClassmojiService.user.findById(userId);

  return namedAction(request, {
    async createCheckoutSession() {
      const priceId = ClassmojiService.billing.checkoutPriceId();
      if (!priceId) {
        console.error('STRIPE_PRO_PRICE_ID is not set — cannot start a Pro checkout.');
        return {
          error: 'Upgrades are not available right now. Please contact support.',
        };
      }

      let customerId = classmojiUser!.stripe_customer_id;
      const customerCreated = !customerId;

      if (!customerId) {
        customerId = (
          await StripeService.createCustomer({
            name: classmojiUser!.name!,
            email: classmojiUser!.email!,
            userId: userId.toString(),
          })
        ).id;

        // Awaited: the webhook finds the user by this id, so a lost write
        // would leave a paid subscription that grants nothing.
        await ClassmojiService.user.update(userId, {
          stripe_customer_id: customerId,
        });
      }

      const session = await StripeService.createCheckoutSession({
        priceId,
        userId: userId.toString(),
        customerId,
      });

      await ClassmojiService.billing.recordEvent({
        userId,
        action: 'CHECKOUT_STARTED',
        source: SOURCE,
        stripeCustomerId: customerId,
        data: { tool: SOURCE, price_id: priceId, customer_created: customerCreated },
      });

      return { checkoutSessionUrl: session.url };
    },
    async createBillingPortalSession() {
      const customerId = classmojiUser?.stripe_customer_id;
      if (!customerId) {
        return { error: 'There is no billing account yet. Upgrade to Pro first.' };
      }

      let flow: 'payment_method_update' | 'subscription_cancel' | null = null;
      let subscriptionId: string | null = null;
      let session;

      if (body.flow === 'payment_method_update') {
        flow = 'payment_method_update';
        session = await StripeService.createBillingPortalSession(customerId, {
          type: 'payment_method_update',
        });
      } else if (body.flow === 'subscription_cancel') {
        const current = await ClassmojiService.subscription.getCurrent(userId);
        if (current?.stripe_subscription_id) {
          flow = 'subscription_cancel';
          subscriptionId = current.stripe_subscription_id;
          session = await StripeService.createBillingPortalSession(customerId, {
            type: 'subscription_cancel',
            subscriptionId,
          });
        }
      }
      session ??= await StripeService.createBillingPortalSession(customerId);

      await ClassmojiService.billing.recordEvent({
        userId,
        action: 'PORTAL_OPENED',
        source: SOURCE,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        data: { tool: SOURCE, flow },
      });

      return { billingPortalSessionUrl: session.url };
    },
  });
};

export default SettingsSubscription;
