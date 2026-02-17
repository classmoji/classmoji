import { Page } from '@playwright/test';

export interface StripeMockOptions {
  /** Simulate payment failure */
  shouldFail?: boolean;
  /** Custom checkout session data */
  sessionData?: Record<string, unknown>;
}

/**
 * Mock Stripe.js and Stripe API endpoints
 *
 * Used for testing token purchases and billing features.
 */
export async function mockStripeAPI(page: Page, options: StripeMockOptions = {}): Promise<void> {
  const { shouldFail = false } = options;

  // Mock Stripe.js loading
  await page.route('**/js.stripe.com/**', async (route) => {
    // Return a minimal Stripe.js mock
    return route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        window.Stripe = function(key) {
          console.log('[Stripe Mock] Initialized with key:', key);
          return {
            redirectToCheckout: async function(options) {
              console.log('[Stripe Mock] redirectToCheckout called:', options);
              ${shouldFail ? 'return { error: { message: "Payment failed" } };' : 'return { error: null };'}
            },
            createPaymentMethod: async function(options) {
              console.log('[Stripe Mock] createPaymentMethod called:', options);
              return {
                paymentMethod: { id: 'pm_test_${Date.now()}' },
                error: null,
              };
            },
            confirmCardPayment: async function(clientSecret, data) {
              console.log('[Stripe Mock] confirmCardPayment called');
              return {
                paymentIntent: { status: 'succeeded' },
                error: null,
              };
            },
            elements: function() {
              return {
                create: function(type, options) {
                  return {
                    mount: function(selector) {
                      console.log('[Stripe Mock] Element mounted:', type, selector);
                    },
                    on: function(event, callback) {},
                    destroy: function() {},
                  };
                },
              };
            },
          };
        };
      `,
    });
  });

  // Mock Stripe API calls
  await page.route('**/api.stripe.com/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (shouldFail) {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            type: 'card_error',
            message: 'Your card was declined.',
          },
        }),
      });
    }

    // Checkout sessions
    if (url.includes('/checkout/sessions')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: `cs_test_${Date.now()}`,
          url: 'https://checkout.stripe.com/mock-session',
          payment_status: 'paid',
          ...options.sessionData,
        }),
      });
    }

    // Payment intents
    if (url.includes('/payment_intents')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: `pi_test_${Date.now()}`,
          status: 'succeeded',
          client_secret: `pi_test_secret_${Date.now()}`,
        }),
      });
    }

    // Default success response
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true }),
    });
  });

  // Mock internal checkout API
  await page.route('**/api/checkout/**', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        url: 'https://checkout.stripe.com/mock-session',
        sessionId: `cs_test_${Date.now()}`,
      }),
    });
  });
}

/**
 * Mock successful payment completion callback
 */
export async function mockPaymentSuccess(page: Page): Promise<void> {
  // Mock the success callback URL
  await page.route('**/payment/success**', async (route) => {
    return route.fulfill({
      status: 302,
      headers: {
        Location: '/student/classmoji-development/tokens?payment=success',
      },
    });
  });
}

/**
 * Mock payment cancellation
 */
export async function mockPaymentCancel(page: Page): Promise<void> {
  await page.route('**/payment/cancel**', async (route) => {
    return route.fulfill({
      status: 302,
      headers: {
        Location: '/student/classmoji-development/tokens?payment=cancelled',
      },
    });
  });
}

/**
 * Clear Stripe mocks
 */
export async function clearStripeMocks(page: Page): Promise<void> {
  await page.unroute('**/js.stripe.com/**');
  await page.unroute('**/api.stripe.com/**');
  await page.unroute('**/api/checkout/**');
  await page.unroute('**/payment/success**');
  await page.unroute('**/payment/cancel**');
}
