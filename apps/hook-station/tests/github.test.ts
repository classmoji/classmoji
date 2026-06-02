import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';

// Must match the secret set in tests/setup.ts before any route import.
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

const sign = (body: string): string => {
  const hmac = crypto.createHmac('sha256', GITHUB_SECRET);
  hmac.update(body);
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

describe('github webhook route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    Object.values(triggers).forEach(t => t.mockClear());
    app = await buildApp();
  });

  it('returns 401 when signature header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      payload: { action: 'closed' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when signature does not match', async () => {
    const payload = { action: 'closed' };
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('triggers closed handler for an issue close event', async () => {
    const payload = { action: 'closed', issue: { id: 1, number: 7 } };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: { 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(triggers.closed).toHaveBeenCalledTimes(1);
  });

  it('does not trigger closed handler when payload has no issue', async () => {
    const payload = { action: 'closed' };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: { 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(triggers.closed).not.toHaveBeenCalled();
  });

  it('triggers memberAdded for member_added action', async () => {
    const payload = { action: 'member_added', member: { login: 'alice' } };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: { 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(triggers.memberAdded).toHaveBeenCalledTimes(1);
  });

  it('triggers newInstallation when created carries an installation but no repository/issues', async () => {
    const payload = { action: 'created', installation: { id: 99 } };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: { 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(triggers.newInstall).toHaveBeenCalledTimes(1);
  });

  it('does not trigger newInstallation when created carries a repository', async () => {
    const payload = {
      action: 'created',
      installation: { id: 99 },
      repository: { id: 1 },
    };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: { 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(triggers.newInstall).not.toHaveBeenCalled();
  });

  it('triggers appUninstalled for deleted+installation without issue/repository', async () => {
    const payload = { action: 'deleted', installation: { id: 99 } };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: { 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(triggers.appUninstalled).toHaveBeenCalledTimes(1);
    expect(triggers.deleted).not.toHaveBeenCalled();
  });

  it('triggers repositoryAssignmentDeleted for deleted+issue', async () => {
    const payload = { action: 'deleted', issue: { id: 1 } };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: { 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(triggers.deleted).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with success but no trigger for unknown action', async () => {
    const payload = { action: 'totally_unknown_action_xyz' };
    const body = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: { 'x-hub-signature-256': sign(body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(Object.values(triggers).every(t => t.mock.calls.length === 0)).toBe(true);
  });

  // HMAC is verified over the raw request body, not JSON.stringify(body).
  describe('REGRESSION: GitHub webhook HMAC over raw body still works after TS migration', () => {
    it('accepts a signature computed over the EXACT raw bytes (whitespace-padded JSON)', async () => {
      // Whitespace-padded JSON that JSON.stringify(parse(...)) would not reproduce.
      const rawBody = '{\n  "action": "closed",\n  "issue": { "id": 1, "number": 7 }\n}';
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/callback/github',
        headers: { 'x-hub-signature-256': sign(rawBody), 'content-type': 'application/json' },
        payload: rawBody,
      });
      expect(res.statusCode).toBe(200);
      expect(triggers.closed).toHaveBeenCalledTimes(1);
    });

    it('rejects a signature computed over a re-serialized body (the main-branch bug)', async () => {
      const rawBody = '{\n  "action": "closed",\n  "issue": { "id": 1, "number": 7 }\n}';
      const reSerialized = JSON.stringify(JSON.parse(rawBody));
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/callback/github',
        headers: {
          'x-hub-signature-256': sign(reSerialized),
          'content-type': 'application/json',
        },
        payload: rawBody,
      });
      expect(res.statusCode).toBe(401);
      expect(triggers.closed).not.toHaveBeenCalled();
    });

    it('accepts a signature over a non-ASCII (multibyte UTF-8) raw body', async () => {
      const payload = { action: 'closed', issue: { id: 1, number: 7, title: 'café — 日本語 — 🎓' } };
      const rawBody = JSON.stringify(payload);
      expect(Buffer.byteLength(rawBody, 'utf8')).toBeGreaterThan(rawBody.length);

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/callback/github',
        headers: { 'x-hub-signature-256': sign(rawBody), 'content-type': 'application/json' },
        payload: rawBody,
      });
      expect(res.statusCode).toBe(200);
      expect(triggers.closed).toHaveBeenCalledTimes(1);
    });

    it('returns 401 when the x-hub-signature-256 header is absent even with a valid body', async () => {
      const rawBody = JSON.stringify({ action: 'closed', issue: { id: 1, number: 7 } });
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/callback/github',
        headers: { 'content-type': 'application/json' },
        payload: rawBody,
      });
      expect(res.statusCode).toBe(401);
      expect(triggers.closed).not.toHaveBeenCalled();
    });

    it('rejects a forged all-zeros signature over an otherwise valid body', async () => {
      const rawBody = JSON.stringify({ action: 'closed', issue: { id: 1, number: 7 } });
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/callback/github',
        headers: {
          'x-hub-signature-256':
            'sha256=0000000000000000000000000000000000000000000000000000000000000000',
          'content-type': 'application/json',
        },
        payload: rawBody,
      });
      expect(res.statusCode).toBe(401);
      expect(triggers.closed).not.toHaveBeenCalled();
    });

    it('returns 401 when the body (rawBody) is missing despite a signature header', async () => {
      // No payload at all -> fastify-raw-body never captures a rawBody, so the
      // route's `typeof rawBody !== 'string'` guard must reject before verifying.
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/callback/github',
        headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
      });
      expect(res.statusCode).toBe(401);
      expect(triggers.closed).not.toHaveBeenCalled();
    });
  });
});
