/**
 * What hook-station reports to the error tracker: a route's thrown 5xx (or a
 * thrown error with no status at all), once, tagged with the route pattern
 * and the delivery's ids, never its body; and the swallowed failures of the
 * collab notifier. The response a route answers is the same with the hook as
 * without it, also when the reporter itself throws. No network, no port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  setErrorReporter,
  type ErrorReporter,
  type ReportContext,
} from '@classmoji/utils/error-report';

import { notifyCollabOfPush, type CollabPrisma } from '../src/collabExternal.ts';
import {
  isReportableRouteError,
  registerErrorReporting,
  resultingStatus,
} from '../src/errorReporting.ts';

let captured: Array<{ error: unknown; context: ReportContext }>;

const fakeReporter = (): ErrorReporter => ({
  capture: (error, context) => {
    captured.push({ error, context });
  },
  flush: async () => true,
});

beforeEach(() => {
  captured = [];
  setErrorReporter(fakeReporter());
});

afterEach(() => {
  setErrorReporter(null);
  vi.restoreAllMocks();
});

const withStatus = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

/** Routes registered in a prefixed plugin, after the hook, as index.ts does. */
async function buildApp(withHook: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  if (withHook) registerErrorReporting(app);
  await app.register(
    async routes => {
      routes.post('/github', async () => {
        throw new Error('handler blew up');
      });
      routes.get('/refused', async () => {
        throw withStatus('already taken', 409);
      });
      routes.get('/unavailable', async () => {
        throw withStatus('upstream down', 503);
      });
      routes.get('/coded', async (_request, reply) => {
        reply.code(418);
        throw new Error('no status of its own');
      });
      routes.post(
        '/validated',
        { schema: { body: { type: 'object', required: ['id'] } } },
        async () => ({ ok: true })
      );
      routes.get('/ok', async () => ({ ok: true }));
    },
    { prefix: '/webhooks/callback' }
  );
  return app;
}

const CASES = [
  { method: 'POST', url: '/webhooks/callback/github', payload: { secret: 'body text' } },
  { method: 'GET', url: '/webhooks/callback/refused' },
  { method: 'GET', url: '/webhooks/callback/unavailable' },
  { method: 'GET', url: '/webhooks/callback/coded' },
  { method: 'POST', url: '/webhooks/callback/validated', payload: {} },
  { method: 'GET', url: '/webhooks/callback/ok' },
] as const;

const answer = (res: Awaited<ReturnType<FastifyInstance['inject']>>) => {
  const { date: _date, ...headers } = res.headers;
  return { status: res.statusCode, body: res.body, headers };
};

describe('the onError hook', () => {
  it('leaves every response exactly as Fastify answers it without the hook', async () => {
    const plain = await buildApp(false);
    const hooked = await buildApp(true);
    for (const request of CASES) {
      const before = answer(await plain.inject(request));
      const after = answer(await hooked.inject(request));
      expect(after).toEqual(before);
    }
  });

  it('leaves the response untouched when the reporter itself throws', async () => {
    setErrorReporter({
      capture: () => {
        throw new Error('reporter broke');
      },
      flush: async () => true,
    });
    const plain = await buildApp(false);
    const hooked = await buildApp(true);
    const request = CASES[0];
    expect(answer(await hooked.inject(request))).toEqual(answer(await plain.inject(request)));
  });

  it('reports a thrown 5xx once with the route, status and delivery ids, never the body', async () => {
    const app = await buildApp(true);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github?installation=1',
      headers: {
        'x-github-event': 'push',
        'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      },
      payload: { secret: 'body text' },
    });
    expect(res.statusCode).toBe(500);
    expect(captured).toHaveLength(1);
    expect((captured[0].error as Error).message).toBe('handler blew up');
    expect(captured[0].context).toEqual({
      surface: 'hook_station.route',
      handled: false,
      tags: {
        route: '/webhooks/callback/github',
        method: 'POST',
        status: 500,
        provider: 'github',
        event: 'push',
        delivery_id: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      },
    });
    expect(JSON.stringify(captured[0].context)).not.toContain('body text');
  });

  it('reports a 503 and an error with no status of its own, never a 4xx refusal or validation', async () => {
    const app = await buildApp(true);
    for (const request of CASES) await app.inject(request);
    expect(captured.map(c => c.context.tags?.route)).toEqual([
      '/webhooks/callback/github',
      '/webhooks/callback/unavailable',
      '/webhooks/callback/coded',
    ]);
    expect(captured.map(c => c.context.tags?.status)).toEqual([500, 503, 418]);
  });

  it('drops a header that is not a plain short id instead of tagging it', async () => {
    const app = await buildApp(true);
    await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: { 'x-github-event': 'push; <script>', 'x-github-delivery': 'x'.repeat(200) },
    });
    expect(captured[0].context.tags).toMatchObject({ event: undefined, delivery_id: undefined });
  });

  it('with no reporter registered, nothing is sent and the answer is the same', async () => {
    setErrorReporter(null);
    const app = await buildApp(true);
    const res = await app.inject(CASES[0]);
    expect(res.statusCode).toBe(500);
    expect(captured).toEqual([]);
  });
});

describe('resultingStatus / isReportableRouteError', () => {
  const reply = (statusCode = 200) => ({ statusCode });

  it('follows Fastify: a code the route set, else the error’s own 4xx/5xx, else 500', () => {
    expect(resultingStatus(reply(), new Error('x'))).toBe(500);
    expect(resultingStatus(reply(), withStatus('x', 404))).toBe(404);
    expect(resultingStatus(reply(), Object.assign(new Error('x'), { status: 502 }))).toBe(502);
    expect(resultingStatus(reply(), withStatus('x', 302))).toBe(500);
    expect(resultingStatus(reply(422), withStatus('x', 500))).toBe(422);
  });

  it('reports 5xx and status-less errors only', () => {
    expect(isReportableRouteError(reply(), new Error('x'))).toBe(true);
    expect(isReportableRouteError(reply(), withStatus('x', 500))).toBe(true);
    expect(isReportableRouteError(reply(), withStatus('x', 401))).toBe(false);
    expect(isReportableRouteError(reply(), withStatus('x', 413))).toBe(false);
  });
});

describe('notifyCollabOfPush', () => {
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const input = {
    classroomId: 'c1',
    collabEnabled: true,
    after: 'c'.repeat(40),
    before: 'a'.repeat(40),
    commits: [],
    complete: true,
    forced: true,
  };

  it('reports a failed trigger per doc, with the classroom and doc ids', async () => {
    const prisma = {
      page: { findMany: vi.fn(async () => []) },
      slide: { findMany: vi.fn(async () => []) },
      collabDoc: {
        findMany: vi.fn(async () => [{ kind: 'page', doc_id: 'p1', pushed_commit: null }]),
      },
    } as unknown as CollabPrisma;
    const failure = new Error('trigger.dev unavailable');
    await notifyCollabOfPush(input, {
      prisma,
      trigger: async () => {
        throw failure;
      },
      log: quiet,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(failure);
    expect(captured[0].context).toEqual({
      surface: 'collab_external.trigger',
      tags: { classroom_id: 'c1', kind: 'page', doc_id: 'p1' },
    });
  });

  it('reports a failed notify (never throws)', async () => {
    const failure = new Error('db down');
    const prisma = {
      collabDoc: { findMany: vi.fn(async () => Promise.reject(failure)) },
    } as unknown as CollabPrisma;
    await expect(
      notifyCollabOfPush(input, { prisma, trigger: async () => {}, log: quiet })
    ).resolves.toBeUndefined();
    expect(captured).toHaveLength(1);
    expect(captured[0].context).toEqual({
      surface: 'collab_external.notify',
      tags: { classroom_id: 'c1' },
    });
  });
});
