import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';

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
  const { default: githubRoutes } = await import('../src/routes/github.ts');
  await app.register(githubRoutes, { prefix: '/webhooks/callback' });
  return app;
};

describe('github webhook route', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    process.env.GITHUB_WEBHOOK_SECRET = GITHUB_SECRET;
  });

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
});
