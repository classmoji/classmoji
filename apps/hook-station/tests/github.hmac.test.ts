import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';

const GITHUB_SECRET = 'test-gh-secret';

const triggers = {
  closed: vi.fn().mockResolvedValue(undefined),
  memberAdded: vi.fn().mockResolvedValue(undefined),
  newInstall: vi.fn().mockResolvedValue(undefined),
  deleted: vi.fn().mockResolvedValue(undefined),
  appUninstalled: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@classmoji/tasks', () => ({
  default: {
    repositoryAssignmentClosedHandlerTask: { trigger: triggers.closed },
    memberAddedHandlerTask: { trigger: triggers.memberAdded },
    newInstallationHandlerTask: { trigger: triggers.newInstall },
    repositoryAssignmentDeletedHandlerTask: { trigger: triggers.deleted },
    appUninstalledHandlerTask: { trigger: triggers.appUninstalled },
  },
}));

const signRaw = (raw: string): string => {
  const hmac = crypto.createHmac('sha256', GITHUB_SECRET);
  hmac.update(raw, 'utf8');
  return `sha256=${hmac.digest('hex')}`;
};

const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify();
  await app.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });
  const { default: githubRoutes } = await import('../src/routes/github.ts');
  await app.register(githubRoutes, { prefix: '/webhooks/callback' });
  return app;
};

describe('github webhook HMAC verification (RW-03 regression contract)', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    process.env.GITHUB_WEBHOOK_SECRET = GITHUB_SECRET;
  });

  beforeEach(async () => {
    Object.values(triggers).forEach(t => t.mockClear());
    app = await buildApp();
  });

  it('accepts a push event whose signature is computed over the exact raw bytes and processes it', async () => {
    const rawBody = '{"action": "closed", "issue": {"id": 1, "number": 7}}';

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: {
        'x-hub-signature-256': signRaw(rawBody),
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(triggers.closed).toHaveBeenCalledTimes(1);
  });

  it('rejects a push event whose signature is computed over JSON.stringify(body) instead of the raw bytes', async () => {
    const rawBody = '{"action": "closed", "issue": {"id": 1, "number": 7}}';
    const reSerialized = JSON.stringify(JSON.parse(rawBody));

    // The two serializations must differ or the test below is vacuous.
    expect(reSerialized).not.toBe(rawBody);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: {
        'x-hub-signature-256': signRaw(reSerialized),
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(401);
    expect(triggers.closed).not.toHaveBeenCalled();
  });

  it('rejects a push event carrying a wrong/forged signature', async () => {
    const rawBody = '{"action": "closed", "issue": {"id": 1, "number": 7}}';

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: {
        'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
        'content-type': 'application/json',
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(401);
    expect(triggers.closed).not.toHaveBeenCalled();
  });

  it('rejects a push event that is missing the X-Hub-Signature-256 header', async () => {
    const rawBody = '{"action": "closed", "issue": {"id": 1, "number": 7}}';

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: { 'content-type': 'application/json' },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(401);
    expect(triggers.closed).not.toHaveBeenCalled();
  });
});
