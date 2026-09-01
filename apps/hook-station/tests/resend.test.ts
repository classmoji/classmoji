import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';

/**
 * The Resend delivery webhook: signature, replay, and what a bounce writes.
 *
 * ── Why the signature is tested against real HMACs ─────────────────────────
 * This endpoint's entire trust boundary is the Svix signature. Every other
 * route test in this app stubs verification out, which is right for testing
 * dispatch and wrong for testing the seam itself — so this file signs its own
 * payloads with `node:crypto` and the route verifies them with its own code.
 * A mistake in either half fails here rather than in production.
 *
 * ── The three refusals that matter ─────────────────────────────────────────
 *  - a TAMPERED body: the signature covers the body, so any edit invalidates it;
 *  - a MISSING signature: no header, no entry;
 *  - a REPLAY: a delivery captured and re-sent later carries a perfectly valid
 *    signature, because the timestamp is inside the signed content. Only the
 *    clock check can refuse it, which is why it gets its own test rather than
 *    being assumed from the signature passing.
 */

const SECRET_KEY = crypto.randomBytes(24);
const WEBHOOK_SECRET = `whsec_${SECRET_KEY.toString('base64')}`;

const updateMany = vi.fn();

vi.mock('@classmoji/database', () => ({
  getPrisma: () => ({ formMagicToken: { updateMany } }),
  default: () => ({ formMagicToken: { updateMany } }),
}));

/** Sign a body exactly as Svix does, so the route's own verifier can check it. */
const sign = (
  body: string,
  { id = 'msg_test_1', timestamp = Math.floor(Date.now() / 1000) } = {}
): Record<string, string> => {
  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');

  return {
    'svix-id': id,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${signature}`,
    'content-type': 'application/json',
  };
};

const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify();
  await app.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });
  const { default: resendRoutes } = await import('../src/routes/resend.ts');
  await app.register(resendRoutes, { prefix: '/webhooks/callback' });
  return app;
};

const bouncePayload = (emailId = 'msg-abc') =>
  JSON.stringify({
    type: 'email.bounced',
    created_at: new Date().toISOString(),
    data: {
      email_id: emailId,
      bounce: {
        type: 'Permanent',
        subType: 'General',
        message: 'The recipient does not exist.',
      },
    },
  });

beforeEach(() => {
  process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
  updateMany.mockReset();
  updateMany.mockResolvedValue({ count: 1 });
});

describe('signature verification', () => {
  it('accepts a validly signed delivery', async () => {
    const app = await buildApp();
    const body = bouncePayload();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/resend',
      headers: sign(body),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('refuses a body tampered with after signing', async () => {
    const app = await buildApp();
    const headers = sign(bouncePayload('msg-abc'));

    // Same headers, different body — which is the attack the signature exists
    // to stop: a genuine delivery re-pointed at somebody else's message.
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/resend',
      headers,
      payload: bouncePayload('msg-somebody-else'),
    });

    expect(response.statusCode).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('refuses a delivery with no signature at all', async () => {
    const app = await buildApp();
    const body = bouncePayload();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/resend',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });

    expect(response.statusCode).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('refuses a REPLAY, whose signature is still perfectly valid', async () => {
    const app = await buildApp();
    const body = bouncePayload();
    // Ten minutes old: past the five-minute tolerance, and correctly signed
    // for that timestamp — so only the clock can refuse it.
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/resend',
      headers: sign(body, { timestamp: stale }),
      payload: body,
    });

    expect(response.statusCode).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('refuses a signature signed with the wrong secret', async () => {
    const app = await buildApp();
    const body = bouncePayload();
    const id = 'msg_test_1';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const forged = crypto
      .createHmac('sha256', crypto.randomBytes(24))
      .update(`${id}.${timestamp}.${body}`)
      .digest('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/resend',
      headers: {
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': `v1,${forged}`,
        'content-type': 'application/json',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('before it is configured', () => {
  it('answers 503 rather than crashing or accepting anything', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const app = await buildApp();
    const body = bouncePayload();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/resend',
      headers: sign(body),
      payload: body,
    });

    // 503 and not 401: this is OUR missing configuration, and Resend retries a
    // 5xx — so the first real bounce after the secret is added still lands.
    expect(response.statusCode).toBe(503);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('what an event does', () => {
  it('marks the token the bounce names, with the provider reason', async () => {
    const app = await buildApp();
    const body = bouncePayload('msg-xyz');

    await app.inject({
      method: 'POST',
      url: '/webhooks/callback/resend',
      headers: sign(body),
      payload: body,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { provider_message_id: 'msg-xyz' },
      data: {
        delivery_state: 'BOUNCED',
        delivery_detail: 'Permanent/General: The recipient does not exist.',
      },
    });
  });

  it('records a delayed delivery without calling it a failure', async () => {
    const app = await buildApp();
    const body = JSON.stringify({
      type: 'email.delivery_delayed',
      data: { email_id: 'msg-slow' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/resend',
      headers: sign(body),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(updateMany.mock.calls[0][0].data.delivery_state).toBe('DELAYED');
  });

  /**
   * THE NO-OP THAT MUST NOT BE AN ERROR.
   *
   * This endpoint sees every email event for the whole Resend account — roster
   * invitations, notifications, grade mail. Almost none of them are form magic
   * tokens. `updateMany` matching nothing must be a quiet 200: a 5xx would put
   * Resend into days of retries for a delivery that can never match, and
   * eventually get the endpoint disabled.
   */
  it('is a quiet no-op for a message id it has never seen', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const app = await buildApp();
    const body = bouncePayload('msg-belongs-to-something-else');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/resend',
      headers: sign(body),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('ignores an event type it does not know, without touching the database', async () => {
    const app = await buildApp();
    const body = JSON.stringify({
      type: 'email.some_future_event',
      data: { email_id: 'msg-abc' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/resend',
      headers: sign(body),
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('is idempotent under redelivery, which is how a retry is safe', async () => {
    const app = await buildApp();
    const body = bouncePayload('msg-retry');
    const headers = sign(body);

    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/resend',
      headers,
      payload: body,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/resend',
      headers,
      payload: body,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // The same terminal state written twice: nothing observable changes.
    expect(updateMany.mock.calls[0][0]).toEqual(updateMany.mock.calls[1][0]);
  });

  it('answers 5xx when the database fails, so the provider retries', async () => {
    updateMany.mockRejectedValue(new Error('connection lost'));
    const app = await buildApp();
    const body = bouncePayload();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/resend',
      headers: sign(body),
      payload: body,
    });

    expect(response.statusCode).toBe(500);
  });
});
