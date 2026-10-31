import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Which price grants Pro is a SERVER decision.
 *
 * The checkout action used to line-item whatever `priceId` the browser posted,
 * which meant the tier a subscription grants was chosen by the client. The
 * price now comes from `STRIPE_PRO_PRICE_ID` and the posted value is not read
 * at all — and the Stripe webhook asserts the same env value before writing a
 * PRO row (apps/hook-station/src/routes/stripe.ts), so both ends agree.
 *
 * Driven through the real action rather than a resolver helper on purpose:
 * "ignores the client price" is only provable by posting one and watching where
 * Stripe's argument actually comes from.
 */

const createCheckoutSessionMock = vi.fn();
const createBillingPortalSessionMock = vi.fn();
const createCustomerMock = vi.fn();
const findByIdMock = vi.fn();
const updateUserMock = vi.fn();
const getAuthSessionMock = vi.fn();
const getCurrentMock = vi.fn();
const recordEventMock = vi.fn();

vi.mock('@classmoji/services', async () => {
  // The real price rule, so these tests still prove where the price comes from.
  const { checkoutPriceId } = await import('@classmoji/utils');
  return {
    ClassmojiService: {
      user: {
        findById: (...a: unknown[]) => findByIdMock(...a),
        update: (...a: unknown[]) => updateUserMock(...a),
      },
      subscription: { getCurrent: (...a: unknown[]) => getCurrentMock(...a) },
      billing: {
        checkoutPriceId: () => checkoutPriceId(),
        recordEvent: (...a: unknown[]) => recordEventMock(...a),
      },
    },
    StripeService: {
      createCheckoutSession: (...a: unknown[]) => createCheckoutSessionMock(...a),
      createBillingPortalSession: (...a: unknown[]) => createBillingPortalSessionMock(...a),
      createCustomer: (...a: unknown[]) => createCustomerMock(...a),
      findSubscription: vi.fn(),
    },
  };
});

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => getAuthSessionMock(...a),
}));

// The action touches none of the component's UI seams; stub what importing
// route.tsx pulls in.
vi.mock('~/hooks', () => ({
  useSubscription: () => ({ isProTier: false, isFreeTier: true }),
}));
vi.mock('@classmoji/ui-components', () => ({
  useCallout: () => ({ show: vi.fn() }),
}));

const { action } = await import('../route.tsx');

const post = (name: string, body: Record<string, unknown> = {}) =>
  ({
    request: new Request(`http://localhost/settings/billing?/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }) as unknown as Parameters<typeof action>[0];

describe('billing action — createCheckoutSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthSessionMock.mockResolvedValue({ userId: 'user-1' });
    findByIdMock.mockResolvedValue({
      id: 'user-1',
      name: 'Tim',
      email: 'tim@example.com',
      stripe_customer_id: 'cus_existing',
    });
    createCheckoutSessionMock.mockResolvedValue({ url: 'https://checkout.stripe.test/session' });
    vi.stubEnv('STRIPE_PRO_PRICE_ID', 'price_from_env');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves the price from the environment', async () => {
    const result = await action(post('createCheckoutSession'));

    expect(createCheckoutSessionMock).toHaveBeenCalledTimes(1);
    expect(createCheckoutSessionMock.mock.calls[0][0]).toMatchObject({
      priceId: 'price_from_env',
      userId: 'user-1',
      customerId: 'cus_existing',
    });
    expect(result).toEqual({ checkoutSessionUrl: 'https://checkout.stripe.test/session' });
  });

  it('sells only the first price when older Pro prices are listed after it', async () => {
    vi.stubEnv('STRIPE_PRO_PRICE_ID', 'price_current, price_older');

    await action(post('createCheckoutSession'));

    expect(createCheckoutSessionMock.mock.calls[0][0]).toMatchObject({ priceId: 'price_current' });
  });

  it('IGNORES a price supplied by the client', async () => {
    await action(post('createCheckoutSession', { priceId: 'price_chosen_by_the_browser' }));

    expect(createCheckoutSessionMock).toHaveBeenCalledTimes(1);
    const [args] = createCheckoutSessionMock.mock.calls[0];
    expect(args.priceId).toBe('price_from_env');
    expect(JSON.stringify(args)).not.toContain('price_chosen_by_the_browser');
  });

  it('trims a padded environment value', async () => {
    vi.stubEnv('STRIPE_PRO_PRICE_ID', '  price_padded  ');
    await action(post('createCheckoutSession'));
    expect(createCheckoutSessionMock.mock.calls[0][0].priceId).toBe('price_padded');
  });

  it('refuses, without calling Stripe, when the environment has no price', async () => {
    // Fails closed and says so. A checkout session with an empty line item is a
    // Stripe error the instructor cannot act on.
    vi.stubEnv('STRIPE_PRO_PRICE_ID', '');

    const result = await action(post('createCheckoutSession', { priceId: 'price_anything' }));

    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
    expect((result as { error?: string }).error).toBeTruthy();
  });

  it('still refuses when the price is unset entirely', async () => {
    vi.stubEnv('STRIPE_PRO_PRICE_ID', undefined as unknown as string);

    const result = await action(post('createCheckoutSession'));

    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
    expect((result as { error?: string }).error).toBeTruthy();
  });

  it('creates a Stripe customer first when the user has none', async () => {
    findByIdMock.mockResolvedValue({
      id: 'user-1',
      name: 'Tim',
      email: 'tim@example.com',
      stripe_customer_id: null,
    });
    createCustomerMock.mockResolvedValue({ id: 'cus_new' });

    await action(post('createCheckoutSession'));

    expect(createCustomerMock).toHaveBeenCalledTimes(1);
    expect(createCheckoutSessionMock.mock.calls[0][0]).toMatchObject({
      priceId: 'price_from_env',
      customerId: 'cus_new',
    });
  });

  it('does not reach Stripe at all before the price is resolved', async () => {
    // The env check runs before customer creation, so a misconfigured
    // deployment does not leave a trail of Stripe customers behind.
    vi.stubEnv('STRIPE_PRO_PRICE_ID', '');
    findByIdMock.mockResolvedValue({
      id: 'user-1',
      name: 'Tim',
      email: 'tim@example.com',
      stripe_customer_id: null,
    });

    await action(post('createCheckoutSession'));

    expect(createCustomerMock).not.toHaveBeenCalled();
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });
});

describe('billing action — createBillingPortalSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthSessionMock.mockResolvedValue({ userId: 'user-1' });
    findByIdMock.mockResolvedValue({ id: 'user-1', stripe_customer_id: 'cus_existing' });
    createBillingPortalSessionMock.mockResolvedValue({ url: 'https://portal.stripe.test/session' });
  });

  it('is untouched by the price change', async () => {
    const result = await action(post('createBillingPortalSession'));

    expect(createBillingPortalSessionMock).toHaveBeenCalledWith('cus_existing');
    expect(result).toEqual({ billingPortalSessionUrl: 'https://portal.stripe.test/session' });
  });

  it('opens the card update screen when asked', async () => {
    await action(post('createBillingPortalSession', { flow: 'payment_method_update' }));

    expect(createBillingPortalSessionMock).toHaveBeenCalledWith('cus_existing', {
      type: 'payment_method_update',
    });
  });

  it('cancels the subscription the SERVER resolves, never one the client names', async () => {
    getCurrentMock.mockResolvedValue({ stripe_subscription_id: 'sub_own' });

    await action(
      post('createBillingPortalSession', { flow: 'subscription_cancel', subscriptionId: 'sub_other' })
    );

    expect(getCurrentMock).toHaveBeenCalledWith('user-1');
    expect(createBillingPortalSessionMock).toHaveBeenCalledWith('cus_existing', {
      type: 'subscription_cancel',
      subscriptionId: 'sub_own',
    });
  });

  it('falls back to the plain portal when there is no subscription to cancel', async () => {
    getCurrentMock.mockResolvedValue({ stripe_subscription_id: null });

    await action(post('createBillingPortalSession', { flow: 'subscription_cancel' }));

    expect(createBillingPortalSessionMock).toHaveBeenCalledWith('cus_existing');
  });

  it('ignores an unknown flow', async () => {
    await action(post('createBillingPortalSession', { flow: 'subscription_update' }));

    expect(createBillingPortalSessionMock).toHaveBeenCalledWith('cus_existing');
  });

  it('refuses, without calling Stripe, when the user has no Stripe customer', async () => {
    findByIdMock.mockResolvedValue({ id: 'user-1', stripe_customer_id: null });

    const result = await action(post('createBillingPortalSession'));

    expect(createBillingPortalSessionMock).not.toHaveBeenCalled();
    expect(result).toEqual({ error: expect.stringContaining('no billing account') });
  });
});

describe('billing action — billing events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('STRIPE_PRO_PRICE_ID', 'price_from_env');
    getAuthSessionMock.mockResolvedValue({ userId: 'user-1' });
    findByIdMock.mockResolvedValue({ id: 'user-1', stripe_customer_id: 'cus_existing' });
    createCheckoutSessionMock.mockResolvedValue({ url: 'https://checkout.stripe.test/session' });
    createBillingPortalSessionMock.mockResolvedValue({ url: 'https://portal.stripe.test/session' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('records CHECKOUT_STARTED for the signed-in user', async () => {
    await action(post('createCheckoutSession'));

    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: 'CHECKOUT_STARTED',
        source: 'web:billing',
        stripeCustomerId: 'cus_existing',
        data: expect.objectContaining({ tool: 'web:billing', price_id: 'price_from_env' }),
      })
    );
  });

  it('records PORTAL_OPENED with the screen and the server-resolved subscription', async () => {
    getCurrentMock.mockResolvedValue({ stripe_subscription_id: 'sub_own' });

    await action(post('createBillingPortalSession', { flow: 'subscription_cancel' }));

    expect(recordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: 'PORTAL_OPENED',
        stripeSubscriptionId: 'sub_own',
        data: expect.objectContaining({ flow: 'subscription_cancel' }),
      })
    );
  });

  it('records nothing when there is no checkout price', async () => {
    vi.stubEnv('STRIPE_PRO_PRICE_ID', '');

    await action(post('createCheckoutSession'));

    expect(recordEventMock).not.toHaveBeenCalled();
  });
});

describe('billing action — saving the new Stripe customer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('STRIPE_PRO_PRICE_ID', 'price_from_env');
    getAuthSessionMock.mockResolvedValue({ userId: 'user-1' });
    findByIdMock.mockResolvedValue({ id: 'user-1', name: 'Tim', email: 'tim@example.com' });
    createCustomerMock.mockResolvedValue({ id: 'cus_new' });
    createCheckoutSessionMock.mockResolvedValue({ url: 'https://checkout.stripe.test/session' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not open checkout when saving the customer id fails', async () => {
    updateUserMock.mockRejectedValue(new Error('db down'));

    await expect(action(post('createCheckoutSession'))).rejects.toThrow('db down');
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });
});
