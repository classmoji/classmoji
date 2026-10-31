/**
 * `billing_status` — the caller's own plan, the MCP side of Settings → Billing.
 *
 * Read-only and self-scoped: it takes no arguments and reads only the caller's
 * subscription, through `ClassmojiService.billing.getStatus`, the same read
 * model the billing page renders. Reading one's own state is not audited (as
 * on the page). Paying, changing the card and cancelling stay on the page,
 * which hands off to Stripe-hosted Checkout and the portal; this tool returns
 * the link to it. Hidden from the Ask Moji client (see `hiddenFromClient`).
 */

import { ClassmojiService } from '@classmoji/services';
import type { ToolDefinition } from '../mcp/registry.ts';

const isoDate = (unix: number | null): string | null =>
  unix ? new Date(unix * 1000).toISOString() : null;

export const billingStatusTool: ToolDefinition<Record<string, never>> = {
  name: 'billing_status',
  title: 'My plan and billing',
  description:
    'Your own Classmoji plan: Free or Pro, the monthly price, the next payment date or the ' +
    'date Pro ends after a cancellation, whether a payment failed, the card on file (brand and ' +
    'last 4 digits) and where receipts go, plus what Pro includes. One plan covers every ' +
    'classroom you own. To upgrade, update the card or cancel, open manage_url in a browser.',
  scope: 'read',
  roles: null,
  inputSchema: {},
  // Reads the subscription from Stripe.
  annotations: { openWorld: true },
  handler: async (_args, { viewer }) => {
    const { billing: billingService } = ClassmojiService;
    const status = await billingService.getStatus(viewer.userId);
    const billing = status.billing;

    const result = {
      plan: status.tier,
      comped: status.isComped,
      ...(billing
        ? {
            status: billing.status,
            payment_failed: billing.status === 'past_due' || billing.status === 'unpaid',
            price_per_month_cents: billing.priceCents,
            next_payment_at: billing.endsAt ? null : isoDate(billing.currentPeriodEnd),
            pro_ends_at: isoDate(billing.endsAt),
            card: billing.card
              ? {
                  brand: billing.card.brand,
                  last4: billing.card.last4,
                  expires: `${String(billing.card.expMonth).padStart(2, '0')}/${billing.card.expYear}`,
                }
              : null,
            receipts_sent_to: billing.email,
          }
        : {}),
      ...(status.tier === 'FREE' ? { pro_price_per_month_cents: status.proPriceCents } : {}),
      pro_includes: billingService
        .proFeatures()
        .map(row => billingService.featureText(row.label, row.pro)),
      manage_url: `${process.env.WEBAPP_URL ?? ''}/settings/billing`,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
};
