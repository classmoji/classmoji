/**
 * Stripe mocks — intentionally no-ops.
 *
 * The webapp has no client-side Stripe: billing runs through StripeService in the
 * server loader, so page.route cannot intercept it. A real mock needs a server-side
 * seam. The functions below remain as exported no-ops so stale importers compile.
 */
import { Page } from '@playwright/test';

export interface StripeMockOptions {
  shouldFail?: boolean;
  sessionData?: Record<string, unknown>;
}

/** @deprecated No-op; cannot mock Stripe from the browser layer. */
export async function mockStripeAPI(_page: Page, _options: StripeMockOptions = {}): Promise<void> {}

/** @deprecated No-op; cannot mock Stripe from the browser layer. */
export async function mockPaymentSuccess(_page: Page): Promise<void> {}

/** @deprecated No-op; cannot mock Stripe from the browser layer. */
export async function mockPaymentCancel(_page: Page): Promise<void> {}

/** @deprecated No-op; cannot mock Stripe from the browser layer. */
export async function clearStripeMocks(_page: Page): Promise<void> {}
