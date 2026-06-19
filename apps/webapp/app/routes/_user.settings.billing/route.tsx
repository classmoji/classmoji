import { Button, Spin } from 'antd';
import { IconCrown, IconArrowRight, IconExternalLink, IconCheck } from '@tabler/icons-react';
import { useFetcher, useLocation } from 'react-router';
import { useEffect, useState, useRef } from 'react';
import { namedAction } from 'remix-utils/named-action';
import dayjs from 'dayjs';

import { ClassmojiService, StripeService } from '@classmoji/services';
import { useCallout } from '@classmoji/ui-components';
import { useSubscription } from '~/hooks';
import InfoCard from './InforCard';
import { getAuthSession } from '@classmoji/auth/server';
import type { Route } from './+types/route';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await getAuthSession(request);

  const classmojiSubscription = await ClassmojiService.subscription.getCurrent(authData!.userId);
  let stripeSubscription = null;

  if (classmojiSubscription.stripe_subscription_id) {
    stripeSubscription = await StripeService.findSubscription(
      classmojiSubscription.stripe_subscription_id
    );
  }

  return {
    stripeSubscription,
    classmojiSubscription,
  };
};

const SettingsSubscription = ({ loaderData }: Route.ComponentProps) => {
  const { stripeSubscription, classmojiSubscription } = loaderData;
  const { isProTier, isFreeTier } = useSubscription('owner');
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
    }
  }, [fetcher.data]);

  useEffect(() => {
    const data = loaderData as Record<string, unknown>;
    if (data?.action === 'UPDATE_SUBSCRIPTION') {
      callout.show({ variant: 'success', title: data.message as string });
    }
  }, [loaderData]);

  const handleUpgrade = () => {
    setLoading(true);
    fetcher.submit(
      {
        priceId: 'price_1Rn1QGFQBcAaaelWqEvAl324',
      },
      {
        method: 'post',
        encType: 'application/json',
        action: '?/createCheckoutSession',
      }
    );
  };

  const handleManagePlan = () => {
    setLoading(true);
    fetcher.submit(
      {},
      {
        method: 'post',
        encType: 'application/json',
        action: '?/createBillingPortalSession',
      }
    );
  };

  const isVIP = !stripeSubscription;

  let nextBillingDate = null;

  if (isVIP) {
    nextBillingDate = classmojiSubscription.started_at
      ? dayjs(classmojiSubscription.started_at).format('MMM D, YYYY')
      : 'N/A';
  } else {
    nextBillingDate = dayjs
      .unix(stripeSubscription?.items?.data[0]?.current_period_end)
      .format('MMM D, YYYY');
  }

  return (
    <>
      <Spin spinning={loading} fullscreen />
      <div className="space-y-6">
        {/* Upgrade Banner for Free Users */}
        {isFreeTier && (
          <div className="bg-linear-to-r from-yellow-50 to-orange-50 dark:from-yellow-900/20 dark:to-orange-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-ink-0 mb-2">
                  Unleash the full power of Classmoji
                </h3>
                <p className="text-ink-2">
                  Unlock AI Quizzes to auto-generate and grade assessments for your students.
                </p>
              </div>
              <div className="flex items-center gap-4">
                <Button type="primary" onClick={handleUpgrade}>
                  Upgrade Plan
                </Button>
                <div className="text-right">
                  <p className="text-sm text-ink-2 mb-1">Want to learn more?</p>
                  <Button
                    type="text"
                    size="small"
                    icon={<IconExternalLink size={14} />}
                    className="text-ink-1 hover:text-gray-900 dark:hover:text-gray-100 p-0 h-auto"
                  >
                    Book a demo
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Plan Details Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Current Plan */}
          <InfoCard title="Current plan">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 mb-4">
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                    isProTier ? 'bg-secondary' : 'bg-gray-100 dark:bg-neutral-700'
                  }`}
                >
                  <IconCrown className={`w-5 h-5 ${isProTier ? 'text-black' : 'text-ink-4'}`} />
                </div>
                <div>
                  <h2 data-onboarding="settings-billing" className="text-xl font-bold text-ink-0">
                    {isFreeTier ? 'Free' : 'Pro'}
                  </h2>
                </div>
              </div>
              {isProTier && isVIP === false && (
                <Button
                  type="primary"
                  icon={<IconArrowRight size={14} color="white" />}
                  onClick={handleManagePlan}
                >
                  Manage plan
                </Button>
              )}
            </div>
          </InfoCard>

          {/* Price */}
          <InfoCard title="Price">
            <p className="text-xl font-bold text-ink-0">
              {isFreeTier || isVIP ? '$0.00' : '$29.00'} / month
            </p>
          </InfoCard>

          {/* Subscription Renews */}
          <InfoCard title="Subscription renews on">
            <p
              className={`text-xl font-bold ${
                classmojiSubscription.cancelled_at ? 'text-red-500' : 'text-ink-0'
              }`}
            >
              {nextBillingDate}
            </p>
          </InfoCard>
        </div>

        {/* Plan inclusions */}
        {isProTier && (
          <InfoCard title="Your plan includes">
            <div className="flex items-center gap-2">
              <IconCheck size={18} className="text-green-600 dark:text-green-500" />
              <span className="text-ink-0 font-medium">AI Quizzes</span>
            </div>
          </InfoCard>
        )}
      </div>
    </>
  );
};

export const action = async ({ request }: Route.ActionArgs) => {
  const data = await request.json();
  const authData = await getAuthSession(request);
  const classmojiUser = await ClassmojiService.user.findById(authData!.userId);

  return namedAction(request, {
    async createCheckoutSession() {
      const { priceId } = data;
      let customerId = classmojiUser!.stripe_customer_id;

      if (!customerId) {
        customerId = (
          await StripeService.createCustomer({
            name: classmojiUser!.name!,
            email: classmojiUser!.email!,
            userId: authData!.userId.toString(),
          })
        ).id;

        ClassmojiService.user.update(authData!.userId, {
          stripe_customer_id: customerId,
        });
      }

      const session = await StripeService.createCheckoutSession({
        priceId,
        userId: authData!.userId.toString(),
        customerId,
      });
      return { checkoutSessionUrl: session.url };
    },
    async createBillingPortalSession() {
      const classmojiUser = await ClassmojiService.user.findById(authData!.userId);
      const session = await StripeService.createBillingPortalSession(
        classmojiUser!.stripe_customer_id!
      );
      return { billingPortalSessionUrl: session.url };
    },
  });
};

export default SettingsSubscription;
