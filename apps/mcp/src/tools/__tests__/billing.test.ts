/**
 * `billing_status`: the caller's own plan, read through the same service the
 * billing page uses, for the caller only, and never offered to Ask Moji.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getStatus = vi.fn();

vi.mock('@classmoji/services', async () => {
  const actual = await vi.importActual<typeof import('@classmoji/services')>('@classmoji/services');
  return {
    ClassmojiService: {
      billing: {
        getStatus: (...a: unknown[]) => getStatus(...a),
        proFeatures: () => actual.ClassmojiService.billing.proFeatures(),
        featureText: (label: string, value: string | boolean) =>
          actual.ClassmojiService.billing.featureText(label, value),
      },
    },
  };
});

const { billingStatusTool } = await import('../billing.ts');
const { hiddenFromClient, toolAnnotations } = await import('../../mcp/registry.ts');
const { ASK_MOJI_CLIENT_ID } = await import('@classmoji/auth/mcp-token');

const call = async (userId: string) => {
  const res = await billingStatusTool.handler({} as never, {
    viewer: { userId, scopes: new Set(['read']), clientId: 'client-1' },
  } as never);
  return JSON.parse((res.content[0] as { text: string }).text);
};

describe('billing_status', () => {
  beforeEach(() => {
    getStatus.mockReset();
    vi.stubEnv('WEBAPP_URL', 'https://classmoji.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads only the caller’s plan', async () => {
    getStatus.mockResolvedValue({ tier: 'FREE', isComped: false, billing: null, proPriceCents: 2000 });

    await call('user-A');
    await call('user-B');

    expect(getStatus).toHaveBeenNthCalledWith(1, 'user-A');
    expect(getStatus).toHaveBeenNthCalledWith(2, 'user-B');
  });

  it('a Free user sees the Pro price, what Pro includes and where to upgrade', async () => {
    getStatus.mockResolvedValue({ tier: 'FREE', isComped: false, billing: null, proPriceCents: 2000 });

    const result = await call('user-A');

    expect(result).toMatchObject({
      plan: 'FREE',
      pro_price_per_month_cents: 2000,
      manage_url: 'https://classmoji.test/settings/billing',
    });
    expect(result.pro_includes).toContain('AI quizzes');
    expect(result.card).toBeUndefined();
  });

  it('a paying user sees the price, next payment and card, never the full card number', async () => {
    getStatus.mockResolvedValue({
      tier: 'PRO',
      isComped: false,
      proPriceCents: null,
      billing: {
        status: 'active',
        priceCents: 2000,
        currentPeriodEnd: 1800000000,
        endsAt: null,
        card: { brand: 'visa', last4: '4242', expMonth: 3, expYear: 2030 },
        email: 'tim@example.com',
      },
    });

    const result = await call('user-A');

    expect(result).toMatchObject({
      plan: 'PRO',
      payment_failed: false,
      price_per_month_cents: 2000,
      next_payment_at: new Date(1800000000 * 1000).toISOString(),
      pro_ends_at: null,
      card: { brand: 'visa', last4: '4242', expires: '03/2030' },
      receipts_sent_to: 'tim@example.com',
    });
    expect(result.pro_price_per_month_cents).toBeUndefined();
  });

  it('a cancelled plan shows when Pro ends instead of a next payment', async () => {
    getStatus.mockResolvedValue({
      tier: 'PRO',
      isComped: false,
      proPriceCents: null,
      billing: {
        status: 'past_due',
        priceCents: 2000,
        currentPeriodEnd: 1800000000,
        endsAt: 1800000000,
        card: null,
        email: null,
      },
    });

    const result = await call('user-A');

    expect(result).toMatchObject({
      payment_failed: true,
      next_payment_at: null,
      pro_ends_at: new Date(1800000000 * 1000).toISOString(),
    });
  });

  it('is read-only and marked as reaching an outside system', () => {
    expect(toolAnnotations(billingStatusTool as never)).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
    });
  });

  it('is never offered to the Ask Moji client, and is to every other client', () => {
    expect(hiddenFromClient('billing_status', { clientId: ASK_MOJI_CLIENT_ID })).toBe(true);
    expect(hiddenFromClient('billing_status', { clientId: 'some-other-client' })).toBe(false);
    expect(hiddenFromClient('billing_status', { clientId: null })).toBe(false);
  });
});
