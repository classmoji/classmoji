import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns 401 when signature header is missing', async () => {
    const app = await buildApp();
    const res = await post(app, { foo: 'bar' });
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

  it('subscription.updated: ignores brand-new subscriptions (<30s old)', async () => {
    constructWebhookEvent.mockReturnValue({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_x', customer: 'cus_1', canceled_at: dayjs().unix() } },
    });
    userFindBy.mockResolvedValue({ id: 'user-1' });
    subGetCurrent.mockResolvedValue({ id: 'sub-cur', created_at: new Date() });

    const app = await buildApp();
    await post(app, {}, { 'stripe-signature': 'sig' });

    expect(subUpdate).not.toHaveBeenCalled();
    expect(subCreate).not.toHaveBeenCalled();
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
    await post(app, {}, { 'stripe-signature': 'sig' });

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
    await post(app, {}, { 'stripe-signature': 'sig' });

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
