/**
 * Which Stripe prices are Pro, from `STRIPE_PRO_PRICE_ID`.
 *
 * The variable may list several prices, comma-separated. The FIRST is the one
 * checkout sells; the rest are older Pro prices the webhook still accepts, so
 * their subscribers keep Pro after a price change. Read on the server only.
 */
export const proPriceIds = (value = process.env.STRIPE_PRO_PRICE_ID): string[] =>
  (value || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

/** The price checkout sells, or '' when none is configured. */
export const checkoutPriceId = (value = process.env.STRIPE_PRO_PRICE_ID): string =>
  proPriceIds(value)[0] ?? '';
