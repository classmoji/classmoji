/**
 * Stripe webhook route tests.
 *
 * These handlers are the only writers of the billing state that gates PRO
 * features, so most of what is pinned here is a refusal: an unrecognized price
 * grants nothing, a cancel REQUEST does not end the paid term early, and a
 * finished subscription leaves a FREE row behind rather than a lapsed PRO one.
 *
 * Every subscription payload therefore carries `items.data[].price.id`, because
 * a payload without the Pro price is now a no-op by design.
 *
 * The other axis these tests pin is DELIVERY, and the distinction is the whole
 * point: a refusal is an answer (200, recorded, never retried), while a failure
 * is not (5xx, NOT recorded, so Stripe redelivers and the handler runs again).
 * Recording an event the handler did not complete is unrecoverable — the
 * redelivery short-circuits as a duplicate and a paid grant is lost in silence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import dayjs from 'dayjs';

const PRO_PRICE_ID = 'price_pro_test';

/** A subscription payload carrying the configured Pro price. */
const proSub = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub_new',
  customer: 'cus_1',
  items: { data: [{ price: { id: PRO_PRICE_ID } }] },
  ...overrides,
});

const constructWebhookEvent = vi.fn();
const userFindBy = vi.fn();
const subGetCurrent = vi.fn();
const subUpdate = vi.fn();
const subCreate = vi.fn();
const subFindBy = vi.fn();
const processedFindUnique = vi.fn();
const processedCreate = vi.fn();

vi.mock('@classmoji/database', () => ({
  getPrisma: () => ({
    processedWebhookEvent: {
      findUnique: processedFindUnique,
      create: processedCreate,
    },
  }),
}));

vi.mock('@classmoji/services', () => ({
  StripeService: { constructWebhookEvent },
  ClassmojiService: {
    user: { findBy: userFindBy },
    subscription: {
      getCurrent: subGetCurrent,
      update: subUpdate,
      create: subCreate,
      findBy: subFindBy,
    },
  },
}));

const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify();
  await app.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });
  const { default: stripeRoutes } = await import('../src/routes/stripe.ts');
  await app.register(stripeRoutes, { prefix: '/webhooks/callback' });
  return app;
};

const post = async (
  app: FastifyInstance,
  body: object | string,
  headers: Record<string, string> = {}
) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/callback/stripe',
    headers: { 'content-type': 'application/json', ...headers },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('stripe webhook route', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.STRIPE_PRO_PRICE_ID = PRO_PRICE_ID;
    [
      constructWebhookEvent,
      userFindBy,
      subGetCurrent,
      subUpdate,
      subCreate,
      subFindBy,
      processedFindUnique,
      processedCreate,
    ].forEach(m => m.mockReset());
    processedFindUnique.mockResolvedValue(null);
    processedCreate.mockResolvedValue({});
    // Captured so exception-path tests can assert it fired, and RESTORED in
    // afterEach — a leaked console.error spy would otherwise accumulate across
    // every suite in the process and swallow real diagnostics.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.STRIPE_PRO_PRICE_ID;
    vi.restoreAllMocks();
  });

  it('returns 401 when signature header is missing', async () => {
    const app = await buildApp();
    const res = await post(app, { foo: 'bar' });
    expect(res.statusCode).toBe(401);
    expect(constructWebhookEvent).not.toHaveBeenCalled();
  });

  it('returns 401 when the body is missing despite a valid-looking signature header', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/stripe',
      // text/plain + empty payload avoids fastify's JSON parse 400 so we exercise
      // the route's own missing-rawBody guard, not the body parser.
      headers: { 'content-type': 'text/plain', 'stripe-signature': 't=1,v1=abc' },
      payload: '',
    });
    expect(res.statusCode).toBe(401);
    expect(constructWebhookEvent).not.toHaveBeenCalled();
  });

  it('returns 401 when signature verification throws', async () => {
    constructWebhookEvent.mockImplementation(() => {
      throw new Error('bad sig');
    });
    const app = await buildApp();
    const res = await post(app, { foo: 'bar' }, { 'stripe-signature': 't=1,v1=bad' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 and skips for unrecognized event types', async () => {
    constructWebhookEvent.mockReturnValue({
      type: 'invoice.paid',
      data: { object: { customer: 'cus_1' } },
    });
    const app = await buildApp();
    const res = await post(app, {}, { 'stripe-signature': 'sig' });
    expect(res.statusCode).toBe(200);
    expect(userFindBy).not.toHaveBeenCalled();
    // A skipped (unhandled) event is not an error and must still be recorded for
    // idempotency so Stripe retries of it short-circuit as duplicates.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(processedCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ source: 'stripe' }) })
    );
  });

  it('subscription.created: cancels prior subscription and creates a new PRO one', async () => {
    constructWebhookEvent.mockReturnValue({
      type: 'customer.subscription.created',
      data: { object: proSub() },
    });
    userFindBy.mockResolvedValue({ id: 'user-1' });
    subGetCurrent.mockResolvedValue({ id: 'sub-old' });

    const app = await buildApp();
    const res = await post(app, {}, { 'stripe-signature': 'sig' });

    expect(res.statusCode).toBe(200);
    expect(subUpdate).toHaveBeenCalledWith(
      'sub-old',
      expect.objectContaining({ ends_at: expect.any(Date) })
    );
    expect(subCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        tier: 'PRO',
        stripe_subscription_id: 'sub_new',
        // A live subscription has no end date. `isSubscriptionActive` reads a
        // null `ends_at` as open-ended, which is the whole point.
        ends_at: null,
      })
    );
  });

  it('subscription.created: skips when no user matches the customer', async () => {
    constructWebhookEvent.mockReturnValue({
      type: 'customer.subscription.created',
      data: { object: proSub({ customer: 'cus_unknown' }) },
    });
    userFindBy.mockResolvedValue(null);

    const app = await buildApp();
    const res = await post(app, {}, { 'stripe-signature': 'sig' });

    expect(res.statusCode).toBe(200);
    expect(subCreate).not.toHaveBeenCalled();
  });

  describe('price assertion', () => {
    // Checkout is a customer-facing flow; without this assertion a subscription
    // to ANY price mints a PRO row. An unrecognized price writes nothing.
    it('grants nothing when the subscription carries a different price', async () => {
      constructWebhookEvent.mockReturnValue({
        type: 'customer.subscription.created',
        data: { object: proSub({ items: { data: [{ price: { id: 'price_something_else' } }] } }) },
      });
      userFindBy.mockResolvedValue({ id: 'user-1' });

      const app = await buildApp();
      const res = await post(app, {}, { 'stripe-signature': 'sig' });

      expect(res.statusCode).toBe(200);
      expect(subCreate).not.toHaveBeenCalled();
      expect(subUpdate).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      // A refusal is an ANSWER, not a failure: recorded, 200'd, never retried.
      // Redelivering it would produce the same answer forever.
      expect(processedCreate).toHaveBeenCalled();
    });

    it('FAILS CLOSED and asks for a REDELIVERY when STRIPE_PRO_PRICE_ID is unset', async () => {
      // A deployment that forgot the variable must stop granting PRO, not grant
      // it to every price — the failure mode of an assertion decides whether it
      // is one. But the delivery is not the customer's fault and nothing about
      // it is wrong: hook-station is a separate Fly app with its own secrets, so
      // a 5xx here means the grant lands by itself once the secret is set,
      // instead of being lost the moment the event is marked processed.
      delete process.env.STRIPE_PRO_PRICE_ID;
      constructWebhookEvent.mockReturnValue({
        id: 'evt_no_price_env',
        type: 'customer.subscription.created',
        data: { object: proSub() },
      });
      userFindBy.mockResolvedValue({ id: 'user-1' });

      const app = await buildApp();
      const res = await post(app, {}, { 'stripe-signature': 'sig' });

      expect(res.statusCode).toBe(500);
      expect(subCreate).not.toHaveBeenCalled();
      expect(processedCreate).not.toHaveBeenCalled();
    });
  });

  describe('subscription.updated: end dates come from Stripe', () => {
    it('persists current_period_end under cancel_at_period_end, NOT now', async () => {
      // The standard billing-portal cancel. Stripe sets `canceled_at` to the
      // moment of the CLICK and keeps the subscription usable until the period
      // ends; writing `new Date()` here ended the paid term weeks early.
      const periodEnd = dayjs().add(21, 'day');
      constructWebhookEvent.mockReturnValue({
        type: 'customer.subscription.updated',
        data: {
          object: proSub({
            id: 'sub_x',
            canceled_at: dayjs().unix(),
            cancel_at_period_end: true,
            current_period_end: periodEnd.unix(),
            cancellation_details: { reason: 'cancellation_requested' },
          }),
        },
      });
      subFindBy.mockResolvedValue({ id: 'sub-cur', user_id: 'user-1' });

      const app = await buildApp();
      const res = await post(app, {}, { 'stripe-signature': 'sig' });
      expect(res.statusCode).toBe(200);

      expect(subFindBy).toHaveBeenCalledWith({ where: { stripe_subscription_id: 'sub_x' } });
      const [, patch] = subUpdate.mock.calls[0] as [string, { ends_at: Date }];
      // Stripe timestamps are whole seconds — compare on that grid, not on ms.
      expect(patch.ends_at.getTime()).toBe(periodEnd.unix() * 1000);
      // Still PRO until the term runs out — `deleted` is what demotes.
      expect(subCreate).not.toHaveBeenCalled();
    });

    it('prefers an explicit cancel_at over the period end', async () => {
      const cancelAt = dayjs().add(3, 'day');
      constructWebhookEvent.mockReturnValue({
        type: 'customer.subscription.updated',
        data: {
          object: proSub({
            id: 'sub_x',
            canceled_at: dayjs().unix(),
            cancel_at: cancelAt.unix(),
            cancel_at_period_end: true,
            current_period_end: dayjs().add(21, 'day').unix(),
          }),
        },
      });
      subFindBy.mockResolvedValue({ id: 'sub-cur', user_id: 'user-1' });

      const app = await buildApp();
      await post(app, {}, { 'stripe-signature': 'sig' });

      const [, patch] = subUpdate.mock.calls[0] as [string, { ends_at: Date }];
      expect(patch.ends_at.getTime()).toBe(cancelAt.unix() * 1000);
    });

    it('CLEARS the end date when a cancellation is undone', async () => {
      // Stripe drops cancel_at/cancel_at_period_end when a customer changes
      // their mind. The old handler early-returned unless `canceled_at` was
      // set, so an un-cancelled account stayed scheduled for expiry forever.
      constructWebhookEvent.mockReturnValue({
        type: 'customer.subscription.updated',
        data: {
          object: proSub({
            id: 'sub_x',
            canceled_at: null,
            cancel_at: null,
            cancel_at_period_end: false,
            current_period_end: dayjs().add(21, 'day').unix(),
          }),
        },
      });
      subFindBy.mockResolvedValue({ id: 'sub-cur', user_id: 'user-1' });

      const app = await buildApp();
      await post(app, {}, { 'stripe-signature': 'sig' });

      expect(subUpdate).toHaveBeenCalledWith('sub-cur', {
        ends_at: null,
        cancelled_at: null,
        cancellation_reason: null,
      });
    });

    it('skips when no local row matches the stripe subscription id', async () => {
      constructWebhookEvent.mockReturnValue({
        type: 'customer.subscription.updated',
        data: { object: proSub({ id: 'sub_unknown' }) },
      });
      subFindBy.mockResolvedValue(null);

      const app = await buildApp();
      const res = await post(app, {}, { 'stripe-signature': 'sig' });
      expect(res.statusCode).toBe(200);

      expect(subUpdate).not.toHaveBeenCalled();
      expect(subCreate).not.toHaveBeenCalled();
    });
  });

  it('subscription.deleted: closes the PRO row AND creates the FREE successor', async () => {
    // The successor is what actually demotes the account: `getCurrent` returns
    // the newest row, so without it the newest row stays {tier:'PRO'} forever.
    const endedAt = dayjs().subtract(1, 'hour');
    constructWebhookEvent.mockReturnValue({
      type: 'customer.subscription.deleted',
      data: { object: proSub({ id: 'sub_z', ended_at: endedAt.unix() }) },
    });
    userFindBy.mockResolvedValue(null);
    subFindBy.mockResolvedValue({ id: 'sub-internal', user_id: 'user-1' });

    const app = await buildApp();
    const res = await post(app, {}, { 'stripe-signature': 'sig' });

    expect(res.statusCode).toBe(200);
    expect(subFindBy).toHaveBeenCalledWith({ where: { stripe_subscription_id: 'sub_z' } });
    const [, patch] = subUpdate.mock.calls[0] as [string, { ends_at: Date }];
    expect(patch.ends_at.getTime()).toBe(endedAt.unix() * 1000);
    expect(subCreate).toHaveBeenCalledWith({ user_id: 'user-1', tier: 'FREE' });
  });

  it('subscription.deleted: falls back to now when Stripe reports no ended_at', async () => {
    constructWebhookEvent.mockReturnValue({
      type: 'customer.subscription.deleted',
      data: { object: proSub({ id: 'sub_z' }) },
    });
    subFindBy.mockResolvedValue({ id: 'sub-internal', user_id: 'user-1' });

    const app = await buildApp();
    await post(app, {}, { 'stripe-signature': 'sig' });

    expect(subUpdate).toHaveBeenCalledWith(
      'sub-internal',
      expect.objectContaining({ ends_at: expect.any(Date) })
    );
  });

  it('subscription.deleted: silent when no matching internal subscription', async () => {
    constructWebhookEvent.mockReturnValue({
      type: 'customer.subscription.deleted',
      data: { object: proSub({ id: 'sub_z' }) },
    });
    subFindBy.mockResolvedValue(null);

    const app = await buildApp();
    const res = await post(app, {}, { 'stripe-signature': 'sig' });

    expect(res.statusCode).toBe(200);
    expect(subUpdate).not.toHaveBeenCalled();
    expect(subCreate).not.toHaveBeenCalled();
  });

  describe('handler failures ask Stripe to redeliver', () => {
    // A failed handler must NOT be recorded as processed. It used to be, and the
    // consequence was silent and permanent: the redelivery short-circuits as a
    // duplicate without running anything, so a transient database blip during a
    // PRO grant left a charged customer on the free tier with a 200 in Stripe's
    // dashboard and nothing to retry.
    it('created: 5xx and NO processed row when the grant write fails', async () => {
      constructWebhookEvent.mockReturnValue({
        id: 'evt_err_created',
        type: 'customer.subscription.created',
        data: { object: proSub() },
      });
      userFindBy.mockResolvedValue({ id: 'user-1' });
      subGetCurrent.mockResolvedValue(null);
      subCreate.mockRejectedValue(new Error('db down'));

      const app = await buildApp();
      const res = await post(app, {}, { 'stripe-signature': 'sig' });

      expect(res.statusCode).toBe(500);
      expect(processedCreate).not.toHaveBeenCalled();
    });

    it('updated: 5xx and NO processed row when the write fails', async () => {
      constructWebhookEvent.mockReturnValue({
        id: 'evt_err_updated',
        type: 'customer.subscription.updated',
        data: {
          object: proSub({
            id: 'sub_x',
            canceled_at: dayjs().unix(),
            cancellation_details: { reason: 'cancellation_requested' },
          }),
        },
      });
      userFindBy.mockResolvedValue({ id: 'user-1' });
      subFindBy.mockResolvedValue({ id: 'sub-cur', user_id: 'user-1' });
      subUpdate.mockRejectedValue(new Error('db down'));

      const app = await buildApp();
      const res = await post(app, {}, { 'stripe-signature': 'sig' });

      expect(res.statusCode).toBe(500);
      expect(processedCreate).not.toHaveBeenCalled();
    });

    it('deleted: 5xx and NO processed row when the read fails', async () => {
      constructWebhookEvent.mockReturnValue({
        id: 'evt_err_deleted',
        type: 'customer.subscription.deleted',
        data: { object: proSub({ id: 'sub_z' }) },
      });
      subFindBy.mockRejectedValue(new Error('db down'));

      const app = await buildApp();
      const res = await post(app, {}, { 'stripe-signature': 'sig' });

      expect(res.statusCode).toBe(500);
      expect(processedCreate).not.toHaveBeenCalled();
    });

    it('a redelivery after a failure RUNS the handler again', async () => {
      // The property the processed row must not defeat. Recording a failed
      // delivery is what turns a retryable blip into a permanent loss.
      constructWebhookEvent.mockReturnValue({
        id: 'evt_retry_me',
        type: 'customer.subscription.created',
        data: { object: proSub() },
      });
      userFindBy.mockResolvedValue({ id: 'user-1' });
      subGetCurrent.mockResolvedValue(null);

      const processed = new Set<string>();
      processedFindUnique.mockImplementation(async ({ where }: { where: { event_id: string } }) =>
        processed.has(where.event_id) ? { event_id: where.event_id } : null
      );
      processedCreate.mockImplementation(async ({ data }: { data: { event_id: string } }) => {
        processed.add(data.event_id);
        return data;
      });
      subCreate.mockRejectedValueOnce(new Error('deadlock detected')).mockResolvedValue({});

      const app = await buildApp();

      const first = await post(app, {}, { 'stripe-signature': 'sig' });
      expect(first.statusCode).toBe(500);

      const second = await post(app, {}, { 'stripe-signature': 'sig' });
      expect(second.statusCode).toBe(200);
      expect(subCreate).toHaveBeenCalledTimes(2);
      expect(JSON.parse(second.body)).not.toHaveProperty('duplicate');
    });

    it('created: a redelivery never mints a SECOND PRO row for the same stripe id', async () => {
      // Retries are only safe because `created` is idempotent. A retry after a
      // partial success (row written, processed-write failed) would otherwise
      // expire the fresh row and mint a duplicate.
      constructWebhookEvent.mockReturnValue({
        id: 'evt_partial',
        type: 'customer.subscription.created',
        data: { object: proSub() },
      });
      userFindBy.mockResolvedValue({ id: 'user-1' });
      subFindBy.mockResolvedValue({ id: 'sub-existing', stripe_subscription_id: 'sub_new' });

      const app = await buildApp();
      const res = await post(app, {}, { 'stripe-signature': 'sig' });

      expect(res.statusCode).toBe(200);
      expect(subCreate).not.toHaveBeenCalled();
      expect(subUpdate).not.toHaveBeenCalled();
      expect(processedCreate).toHaveBeenCalled();
    });
  });

  // NOTE: idempotency is verified here against an in-memory Set that simulates the
  // processed_webhook_event.event_id unique constraint. It does NOT exercise the
  // real Postgres unique index or a concurrent double-delivery race. A follow-up
  // integration test against a real/SQLite DB should cover constraint enforcement.
  describe('REGRESSION: Stripe webhook idempotency still works after TS migration', () => {
    it('a duplicate delivery of the same event.id is processed once', async () => {
      constructWebhookEvent.mockReturnValue({
        id: 'evt_dup_1',
        type: 'customer.subscription.created',
        data: { object: proSub() },
      });
      userFindBy.mockResolvedValue({ id: 'user-1' });
      subGetCurrent.mockResolvedValue(null);

      // Mirrors the table's unique constraint: findUnique returns a row once create has run.
      const processed = new Set<string>();
      processedFindUnique.mockImplementation(async ({ where }: { where: { event_id: string } }) =>
        processed.has(where.event_id) ? { event_id: where.event_id } : null
      );
      processedCreate.mockImplementation(async ({ data }: { data: { event_id: string } }) => {
        processed.add(data.event_id);
        return data;
      });

      const app = await buildApp();

      const first = await post(app, {}, { 'stripe-signature': 'sig' });
      expect(first.statusCode).toBe(200);
      expect(JSON.parse(first.body)).not.toHaveProperty('duplicate');
      expect(subCreate).toHaveBeenCalledTimes(1);

      const second = await post(app, {}, { 'stripe-signature': 'sig' });
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body)).toMatchObject({ duplicate: true });
      expect(subCreate).toHaveBeenCalledTimes(1);
    });
  });
});
