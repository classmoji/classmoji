import Stripe from 'stripe';

let _stripe: Stripe | null = null;
const stripe = (): Stripe => {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);
  return _stripe;
};

class StripeService {
  static async createCheckoutSession({ priceId, userId, customerId }: { priceId: string; userId: string; customerId: string }): Promise<Stripe.Checkout.Session> {
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

  static async createBillingPortalSession(customerId: string): Promise<Stripe.BillingPortal.Session> {
    const session = await stripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.WEBAPP_URL}/settings/billing`,
    });
    return session;
  }

  static async findSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    const subscription = await stripe().subscriptions.retrieve(subscriptionId);
    return subscription;
  }

  static constructWebhookEvent(body: string | Buffer, signature: string): Stripe.Event {
    const event = stripe().webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET as string
    );
    return event;
  }

  static async createCustomer({ name, email, userId }: { name: string; email: string; userId: string }): Promise<Stripe.Customer> {
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
