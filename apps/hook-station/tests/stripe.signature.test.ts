import { describe, it, expect, beforeAll } from 'vitest';
import Stripe from 'stripe';
import StripeService from '../../../packages/services/src/stripe/index.ts';

// Exercises the REAL StripeService.constructWebhookEvent against Stripe's own
// signing primitives (no mocks). This guards the signature-verification seam
// that every route-level test stubs out.
const WEBHOOK_SECRET = 'whsec_test_secret_for_signature_verification';

describe('StripeService.constructWebhookEvent (real signature verification)', () => {
  let stripe: Stripe;
  const payload = JSON.stringify({
    id: 'evt_test_1',
    type: 'customer.subscription.created',
    data: { object: { id: 'sub_test', customer: 'cus_test' } },
  });

  beforeAll(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_key';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    // Stripe SDK is only used here for its signing helper; no network calls.
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  });

  it('constructs the event for a validly-signed body', () => {
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    const event = StripeService.constructWebhookEvent(payload, header);

    expect(event.id).toBe('evt_test_1');
    expect(event.type).toBe('customer.subscription.created');
  });

  it('throws when the body is tampered with after signing', () => {
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });
    const tampered = payload.replace('cus_test', 'cus_attacker');

    expect(() => StripeService.constructWebhookEvent(tampered, header)).toThrow();
  });

  it('throws when the header was signed with the wrong secret', () => {
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_some_other_secret',
    });

    expect(() => StripeService.constructWebhookEvent(payload, header)).toThrow();
  });

  it('throws for a malformed t=,v1= signature header', () => {
    expect(() =>
      StripeService.constructWebhookEvent(payload, 't=,v1=')
    ).toThrow();
  });
});
