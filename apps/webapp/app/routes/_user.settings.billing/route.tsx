import { Button, Table, Spin } from 'antd';
import { IconCrown, IconArrowRight, IconExternalLink } from '@tabler/icons-react';
import { useFetcher, useLocation } from 'react-router';
import { useEffect, useState, useRef } from 'react';
import { namedAction } from 'remix-utils/named-action';
import dayjs from 'dayjs';

import { ClassmojiService, StripeService } from '@classmoji/services';
import { useSubscription } from '~/hooks';
import InfoCard from './InforCard';
import { getUsageData } from './utils';
import { getAuthSession } from '@classmoji/auth/server';
import { toast } from 'react-toastify';
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
  const usageData = getUsageData({ isFreeTier, isProTier });
  const fetcher = useFetcher();
  const [loading, setLoading] = useState(false);
  const { search } = useLocation();
  const toastShownRef = useRef(new Set());

  useEffect(() => {
    const url = new URLSearchParams(search);
    const success = url.get('success');
    const sessionId = url.get('session_id');

    if (success && sessionId && !toastShownRef.current.has(sessionId)) {
      toast.success('Subscription updated successfully');
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
      toast.success(data.message as string);
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
          <div
            className="rounded-xl border p-6"
            style={{
              background:
                'linear-gradient(135deg, var(--accent-soft) 0%, var(--lilac-bg) 100%)',
              borderColor: 'var(--accent-soft-2)',
            }}
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="display text-xl text-ink-0 mb-2">
                  Unleash the full power of Classmoji
                </h3>
                <p className="text-ink-2">
                  Get unlimited students, courses, TA management, team projects, and so much more.
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
                    className="text-ink-1! hover:text-ink-0! p-0 h-auto"
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
              <div className="flex items-center gap-3">
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                    isProTier ? 'bg-accent-soft' : 'bg-paper'
                  }`}
                >
                  <IconCrown
                    className={`w-5 h-5 ${isProTier ? 'text-accent-ink' : 'text-ink-3'}`}
                  />
                </div>
                <div>
                  <h2 className="display text-xl text-ink-0">
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
            <p className="display text-2xl text-ink-0">
              {isFreeTier || isVIP ? '$0.00' : '$29.00'} / month
            </p>
          </InfoCard>

          {/* Subscription Renews */}
          <InfoCard title="Subscription renews on">
            <p
              className={`display text-2xl ${
                classmojiSubscription.cancelled_at ? 'text-red-500' : 'text-ink-0'
              }`}
            >
              {nextBillingDate}
            </p>
          </InfoCard>
        </div>

        {/* Current Usage Table */}
        <div className="panel">
          <div className="panel-head">
            <h3 className="display text-lg text-ink-0">Current usage</h3>
          </div>
          <div className="panel-body">
          <Table
            dataSource={usageData}
            pagination={false}
            className="pb-8"
            rowKey="key"
            size="small"
            columns={[
              {
                title: 'FEATURE',
                dataIndex: 'feature',
                key: 'feature',
                width: '33%',
                render: (text, record) => (
                  <div className="flex items-center gap-2">
                    <span className="text-ink-0 font-medium">{text}</span>
                    {record.feature === 'Students per course' && (
                      <div className="w-4 h-4 rounded-full bg-paper-2 flex items-center justify-center">
                        <span className="text-xs text-ink-2">?</span>
                      </div>
                    )}
                  </div>
                ),
              },
              {
                title: 'ALLOWED',
                dataIndex: 'allowed',
                key: 'allowed',
                width: '33%',
                render: (text, record) => (
                  <div className="flex items-center">
                    {!record.available ? (
                      <span>❌</span>
                    ) : (
                      <span className="text-ink-0 font-medium">{text}</span>
                    )}
                  </div>
                ),
              },
              {
                title: 'USED',
                dataIndex: 'used',
                key: 'used',
                width: '33%',
                render: (text, record) => (
                  <span className="text-ink-0 font-medium">
                    {!record.available ? '-' : text}
                  </span>
                ),
              },
            ]}
          />
          </div>
        </div>
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
