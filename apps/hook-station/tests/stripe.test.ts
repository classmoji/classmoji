import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import dayjs from 'dayjs';

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

  beforeEach(() => {
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
  });

  afterEach(() => {
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
      data: { object: { id: 'sub_new', customer: 'cus_1' } },
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
      })
    );
  });

  it('subscription.created: skips when no user matches the customer', async () => {
    constructWebhookEvent.mockReturnValue({
      type: 'customer.subscription.created',
      data: { object: { id: 'sub_new', customer: 'cus_unknown' } },
    });
    userFindBy.mockResolvedValue(null);

    const app = await buildApp();
    const res = await post(app, {}, { 'stripe-signature': 'sig' });

    expect(res.statusCode).toBe(200);
    expect(subCreate).not.toHaveBeenCalled();
  });

  it('subscription.updated: ignores brand-new subscriptions under the 30s cutoff', async () => {
    // Pin created_at relative to a captured "now" so the 30s cutoff is exercised
    // deterministically. fastify-raw-body and app.inject rely on real timers, so
    // we offset created_at rather than faking the system clock. We use a 5s
    // margin (25s) rather than 29s: under CI load, request handling can take
    // >1s, which would push a 29s offset across the exact 30s boundary and flake.
    const now = Date.now();
    constructWebhookEvent.mockReturnValue({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_x', customer: 'cus_1', canceled_at: dayjs().unix() } },
    });
    userFindBy.mockResolvedValue({ id: 'user-1' });
    // 25s old: comfortably under the 30s cutoff, so the route must skip.
    subGetCurrent.mockResolvedValue({
      id: 'sub-cur',
      created_at: new Date(now - 25_000),
    });

    const app = await buildApp();
    const res = await post(app, {}, { 'stripe-signature': 'sig' });

    expect(res.statusCode).toBe(200);
    expect(subUpdate).not.toHaveBeenCalled();
    expect(subCreate).not.toHaveBeenCalled();
  });

  it('subscription.updated: processes subscriptions past the 30s cutoff', async () => {
    const now = Date.now();
    constructWebhookEvent.mockReturnValue({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_x',
          customer: 'cus_1',
          canceled_at: dayjs().unix(),
          cancellation_details: { reason: 'cancellation_requested' },
        },
      },
    });
    userFindBy.mockResolvedValue({ id: 'user-1' });
    // 35s old: comfortably over the cutoff (5s margin), so the route processes it.
    subGetCurrent.mockResolvedValue({
      id: 'sub-cur',
      created_at: new Date(now - 35_000),
    });

    const app = await buildApp();
    const res = await post(app, {}, { 'stripe-signature': 'sig' });

    expect(res.statusCode).toBe(200);
    expect(subUpdate).toHaveBeenCalledTimes(1);
    expect(subCreate).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', tier: 'FREE' })
    );
  });

  it('subscription.updated: cancels and creates FREE tier when older than 30s', async () => {
    constructWebhookEvent.mockReturnValue({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_x',
          customer: 'cus_1',
          canceled_at: dayjs().unix(),
          cancellation_details: { reason: 'cancellation_requested' },
        },
      },
    });
    userFindBy.mockResolvedValue({ id: 'user-1' });
    subGetCurrent.mockResolvedValue({
      id: 'sub-cur',
      created_at: dayjs().subtract(2, 'minute').toDate(),
    });

    const app = await buildApp();
    const res = await post(app, {}, { 'stripe-signature': 'sig' });
    expect(res.statusCode).toBe(200);

    expect(subUpdate).toHaveBeenCalledWith(
      'sub-cur',
      expect.objectContaining({
        cancellation_reason: 'cancellation_requested',
        ends_at: expect.any(Date),
        cancelled_at: expect.any(Date),
      })
    );
    expect(subCreate).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', tier: 'FREE' })
    );
  });

  it('subscription.updated: skips when subscription not actually canceled', async () => {
    constructWebhookEvent.mockReturnValue({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_x', customer: 'cus_1', canceled_at: null } },
    });
    userFindBy.mockResolvedValue({ id: 'user-1' });

    const app = await buildApp();
    const res = await post(app, {}, { 'stripe-signature': 'sig' });
    expect(res.statusCode).toBe(200);

    expect(subUpdate).not.toHaveBeenCalled();
    expect(subCreate).not.toHaveBeenCalled();
  });

  it('subscription.deleted: closes matching subscription by stripe id', async () => {
    constructWebhookEvent.mockReturnValue({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_z', customer: 'cus_1' } },
    });
    userFindBy.mockResolvedValue(null);
    subFindBy.mockResolvedValue({ id: 'sub-internal' });

    const app = await buildApp();
    const res = await post(app, {}, { 'stripe-signature': 'sig' });

    expect(res.statusCode).toBe(200);
    expect(subFindBy).toHaveBeenCalledWith({ where: { stripe_subscription_id: 'sub_z' } });
    expect(subUpdate).toHaveBeenCalledWith(
      'sub-internal',
      expect.objectContaining({ ends_at: expect.any(Date) })
    );
  });

  it('subscription.deleted: silent when no matching internal subscription', async () => {
    constructWebhookEvent.mockReturnValue({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_z', customer: 'cus_1' } },
    });
    subFindBy.mockResolvedValue(null);

    const app = await buildApp();
    const res = await post(app, {}, { 'stripe-signature': 'sig' });

    expect(res.statusCode).toBe(200);
    expect(subUpdate).not.toHaveBeenCalled();
  });

  describe('handler exception containment', () => {
    // Each handler wraps its service calls in try/catch + console.error. A
    // service failure must NOT 500 the webhook (Stripe would retry-storm) and
    // must still record the event for idempotency so the retry is a no-op.
    it('created: swallows a service error, logs it, returns 200, and records the event', async () => {
      constructWebhookEvent.mockReturnValue({
        id: 'evt_err_created',
        type: 'customer.subscription.created',
        data: { object: { id: 'sub_new', customer: 'cus_1' } },
      });
      userFindBy.mockResolvedValue({ id: 'user-1' });
      subGetCurrent.mockResolvedValue(null);
      subCreate.mockRejectedValue(new Error('db down'));

      const app = await buildApp();
      const res = await post(app, {}, { 'stripe-signature': 'sig' });

      expect(res.statusCode).toBe(200);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error in customer.subscription.created',
        expect.any(Error)
      );
      expect(processedCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ event_id: 'evt_err_created' }) })
      );
    });

    it('updated: swallows a service error, logs it, and returns 200', async () => {
      const now = Date.now();
      constructWebhookEvent.mockReturnValue({
        id: 'evt_err_updated',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_x',
            customer: 'cus_1',
            canceled_at: dayjs().unix(),
            cancellation_details: { reason: 'cancellation_requested' },
          },
        },
      });
      userFindBy.mockResolvedValue({ id: 'user-1' });
      subGetCurrent.mockResolvedValue({ id: 'sub-cur', created_at: new Date(now - 35_000) });
      subUpdate.mockRejectedValue(new Error('db down'));

      const app = await buildApp();
      const res = await post(app, {}, { 'stripe-signature': 'sig' });

      expect(res.statusCode).toBe(200);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error in customer.subscription.updated',
        expect.any(Error)
      );
    });

    it('deleted: swallows a service error, logs it, and returns 200', async () => {
      constructWebhookEvent.mockReturnValue({
        id: 'evt_err_deleted',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_z', customer: 'cus_1' } },
      });
      subFindBy.mockRejectedValue(new Error('db down'));

      const app = await buildApp();
      const res = await post(app, {}, { 'stripe-signature': 'sig' });

      expect(res.statusCode).toBe(200);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error in customer.subscription.deleted',
        expect.any(Error)
      );
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
        data: { object: { id: 'sub_new', customer: 'cus_1' } },
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
