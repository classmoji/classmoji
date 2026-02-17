import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

class StripeService {
  static async createCheckoutSession({ priceId, userId, customerId }) {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: userId,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${process.env.HOST_URL}/settings/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.HOST_URL}/settings/billing?canceled=true`,
      metadata: {
        user_id: userId,
      },
    });

    return session;
  }

  static async getCheckoutSession(sessionId) {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return session;
  }

  static async createBillingPortalSession(customerId) {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.HOST_URL}/settings/billing`,
    });
    return session;
  }

  static async findSubscription(subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return subscription;
  }

  static async constructWebhookEvent(body, signature) {
    const event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    return event;
  }

  static async createCustomer({ name, email, userId }) {
    const customer = await stripe.customers.create({
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
