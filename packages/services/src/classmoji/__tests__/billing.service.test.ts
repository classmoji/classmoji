/**
 * Unit tests for the billing read model the billing page and the MCP
 * `billing_status` tool share, and for the billing event log.
 *
 * Prisma and Stripe are mocked; the decisions (which tier, which price, what a
 * Stripe subscription shows as) run for real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const subscriptionFindFirst = vi.fn();
const billingEventCreate = vi.fn();
const findSubscription = vi.fn();
const findPrice = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    subscription: { findFirst: subscriptionFindFirst },
    billingEvent: { create: billingEventCreate },
  }),
}));

vi.mock('../../stripe/index.ts', () => ({
  default: { findSubscription, findPrice },
}));

const billing = await import('../billing.service.ts');

const HOUR = 60 * 60 * 1000;

describe('getStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('STRIPE_PRO_PRICE_ID', 'price_current,price_old');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('a user with no rows is Free and is offered the CURRENT price', async () => {
    subscriptionFindFirst.mockResolvedValue(null);
    findPrice.mockResolvedValue({ unit_amount: 2000 });

    const status = await billing.getStatus('user-1');

    expect(status).toMatchObject({ tier: 'FREE', isComped: false, billing: null, proPriceCents: 2000 });
    expect(findPrice).toHaveBeenCalledWith('price_current');
    expect(findSubscription).not.toHaveBeenCalled();
  });

  it('only reads the caller’s own subscription rows', async () => {
    subscriptionFindFirst.mockResolvedValue(null);
    findPrice.mockResolvedValue({ unit_amount: 2000 });

    await billing.getStatus('user-1');

    expect(subscriptionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 'user-1' } })
    );
  });

  it('a lapsed PRO row reads as Free', async () => {
    subscriptionFindFirst.mockResolvedValue({
      tier: 'PRO',
      stripe_subscription_id: 'sub_1',
      ends_at: new Date(Date.now() - HOUR),
    });
    findPrice.mockResolvedValue({ unit_amount: 2000 });

    expect((await billing.getStatus('user-1')).tier).toBe('FREE');
  });

  it('a PRO row without a Stripe subscription is comped', async () => {
    subscriptionFindFirst.mockResolvedValue({ tier: 'PRO', stripe_subscription_id: null, ends_at: null });

    const status = await billing.getStatus('user-1');

    expect(status).toMatchObject({ tier: 'PRO', isComped: true, billing: null, proPriceCents: null });
    expect(findSubscription).not.toHaveBeenCalled();
  });

  it('a paid PRO row is summarized from Stripe', async () => {
    subscriptionFindFirst.mockResolvedValue({ tier: 'PRO', stripe_subscription_id: 'sub_1', ends_at: null });
    findSubscription.mockResolvedValue({
      status: 'active',
      cancel_at: null,
      cancel_at_period_end: false,
      items: { data: [{ price: { unit_amount: 2000 }, current_period_end: 1800000000 }] },
      default_payment_method: { card: { brand: 'visa', last4: '4242', exp_month: 3, exp_year: 2030 } },
      customer: { email: 'tim@example.com', invoice_settings: {} },
    });

    const status = await billing.getStatus('user-1');

    expect(status.billing).toEqual({
      status: 'active',
      priceCents: 2000,
      currentPeriodEnd: 1800000000,
      endsAt: null,
      card: { brand: 'visa', last4: '4242', expMonth: 3, expYear: 2030 },
      email: 'tim@example.com',
    });
  });

  it('a Stripe failure leaves the details empty instead of failing the read', async () => {
    subscriptionFindFirst.mockResolvedValue({ tier: 'PRO', stripe_subscription_id: 'sub_1', ends_at: null });
    findSubscription.mockRejectedValue(new Error('stripe down'));

    const status = await billing.getStatus('user-1');

    expect(status).toMatchObject({ tier: 'PRO', isComped: false, billing: null });
  });
});

describe('summarizeSubscription', () => {
  it('a cancellation at period end ends at the period end', () => {
    const summary = billing.summarizeSubscription({
      status: 'active',
      cancel_at_period_end: true,
      items: { data: [{ price: { unit_amount: 2000 }, current_period_end: 1800000000 }] },
      customer: 'cus_1',
    } as never);

    expect(summary.endsAt).toBe(1800000000);
    expect(summary.email).toBeNull();
  });

  it('falls back to the customer’s default card', () => {
    const summary = billing.summarizeSubscription({
      status: 'active',
      items: { data: [] },
      default_payment_method: null,
      customer: {
        email: null,
        invoice_settings: {
          default_payment_method: { card: { brand: 'amex', last4: '0005', exp_month: 1, exp_year: 2031 } },
        },
      },
    } as never);

    expect(summary.card).toEqual({ brand: 'amex', last4: '0005', expMonth: 1, expYear: 2031 });
  });
});

describe('plan features', () => {
  it('Pro features are what Free lacks or limits', () => {
    const labels = billing.proFeatures().map(row => row.label);

    expect(labels).toContain('AI quizzes');
    expect(labels).not.toContain('Classrooms');
    expect(labels).not.toContain('Repositories');
  });

  it('reads as plain lines', () => {
    expect(billing.featureText('Classrooms', 'Unlimited')).toBe('Unlimited classrooms');
    expect(billing.featureText('Pages per class', 'Up to 10')).toBe('Pages per class: up to 10');
    expect(billing.featureText('Forms', true)).toBe('Forms');
  });
});

describe('recordEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the row', async () => {
    billingEventCreate.mockResolvedValue({});

    await billing.recordEvent({
      userId: 'user-1',
      action: 'CHECKOUT_STARTED',
      source: 'web:billing',
      stripeCustomerId: 'cus_1',
      data: { tool: 'web:billing' },
    });

    expect(billingEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        user_id: 'user-1',
        action: 'CHECKOUT_STARTED',
        source: 'web:billing',
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: null,
        stripe_event_id: null,
        data: { tool: 'web:billing' },
      }),
    });
  });

  it('never throws, so a failed write cannot break a checkout or a webhook', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    billingEventCreate.mockRejectedValue(new Error('db down'));

    await expect(
      billing.recordEvent({ userId: 'user-1', action: 'PRO_GRANTED', source: 'stripe:webhook' })
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
