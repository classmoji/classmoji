import Stripe from 'stripe';

let _stripe: Stripe | null = null;
const stripe = (): Stripe => {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);
  return _stripe;
};

class StripeService {
  static async createCheckoutSession({
    priceId,
    userId,
    customerId,
  }: {
    priceId: string;
    userId: string;
    customerId: string;
  }): Promise<Stripe.Checkout.Session> {
    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: userId,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      // Stripe Tax works out the tax from the billing address checkout asks
      // for; `customer_update` saves that address on the existing customer,
      // which Stripe requires before it will calculate tax for one.
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto' },
      success_url: `${process.env.WEBAPP_URL}/settings/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.WEBAPP_URL}/settings/billing?canceled=true`,
      metadata: {
        user_id: userId,
      },
    });

    return session;
  }

  static async getCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
    const session = await stripe().checkout.sessions.retrieve(sessionId);
    return session;
  }

  /**
   * A portal session, optionally opened straight on one task. `subscriptionId`
   * is required for `subscription_cancel`, which cancels that subscription.
   */
  static async createBillingPortalSession(
    customerId: string,
    flow?: { type: 'payment_method_update' } | { type: 'subscription_cancel'; subscriptionId: string }
  ): Promise<Stripe.BillingPortal.Session> {
    const returnUrl = `${process.env.WEBAPP_URL}/settings/billing`;
    const flowData: Stripe.BillingPortal.SessionCreateParams.FlowData | undefined = !flow
      ? undefined
      : flow.type === 'payment_method_update'
        ? { type: 'payment_method_update' }
        : {
            type: 'subscription_cancel',
            subscription_cancel: { subscription: flow.subscriptionId },
            after_completion: { type: 'redirect', redirect: { return_url: returnUrl } },
          };
    const session = await stripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      ...(flowData ? { flow_data: flowData } : {}),
    });
    return session;
  }

  /** The subscription with its card and customer, for the billing page. */
  static async findSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    const subscription = await stripe().subscriptions.retrieve(subscriptionId, {
      expand: ['default_payment_method', 'customer.invoice_settings.default_payment_method'],
    });
    return subscription;
  }

  static async findPrice(priceId: string): Promise<Stripe.Price> {
    return stripe().prices.retrieve(priceId);
  }

  static constructWebhookEvent(body: string | Buffer, signature: string): Stripe.Event {
    const event = stripe().webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET as string
    );
    return event;
  }

  static async createCustomer({
    name,
    email,
    userId,
  }: {
    name: string;
    email: string;
    userId: string;
  }): Promise<Stripe.Customer> {
    const customer = await stripe().customers.create({
      name,
      email,
      metadata: {
        user_id: userId,
      },
    });
    return customer;
  }
}

export default StripeService;
