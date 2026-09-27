import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Who hook-station believes on the Gitlab webhook and the autograde endpoint:
 * - a Gitlab event must carry the token of the instance it claims to come
 *   from; the old shared secret only works during a declared rollout window;
 * - autograde results need the repo's own token, and a repo gets a budget.
 */

const ingestTrigger = vi.fn().mockResolvedValue(undefined);
const verifyToken = vi.fn();

vi.mock('@classmoji/tasks', () => ({
  default: {
    ingestAutogradeResultTask: { trigger: ingestTrigger },
    repositoryPushHandlerTask: { trigger: vi.fn() },
    contentAssetsSyncTask: { trigger: vi.fn() },
  },
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitRepo: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn() },
    classroom: { findFirst: vi.fn().mockResolvedValue(null) },
  }),
}));

vi.mock('@classmoji/services', () => ({
  CLASSMOJI_BOT_EMAIL: 'hello@classmoji.com',
  verifyAutogradeCallbackToken: (...a: unknown[]) => verifyToken(...a),
  ClassmojiService: {
    gitlabInstance: {
      normalizeHost: (h: string) => h,
      defaultHost: () => 'https://gitlab.com',
      findByHost: async () => ({ id: 'inst-1', host: 'https://gitlab.school.edu', pending: false }),
      webhookSecret: (id: string | null) => `derived-${id ?? 'default'}`,
    },
  },
}));

const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify();
  const { default: gitlabRoutes } = await import('../src/routes/gitlab.ts');
  const { default: autogradeRoutes } = await import('../src/routes/autograde.ts');
  await app.register(gitlabRoutes, { prefix: '/webhooks/callback' });
  await app.register(autogradeRoutes, { prefix: '/webhooks/callback' });
  return app;
};

// A push to a non-default branch: authenticated, then ignored.
const push = {
  object_kind: 'push',
  ref: 'refs/heads/feature',
  project: { id: 1, default_branch: 'main', web_url: 'https://gitlab.school.edu/cs/c/p' },
};

const send = (app: FastifyInstance, token: string) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/callback/gitlab',
    headers: { 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': token },
    payload: push,
  });

describe('Gitlab webhook tokens', () => {
  beforeEach(() => {
    process.env.GITLAB_WEBHOOK_SECRET = 'shared';
    delete process.env.GITLAB_LEGACY_WEBHOOK_SECRET_UNTIL;
  });
  afterEach(() => {
    delete process.env.GITLAB_LEGACY_WEBHOOK_SECRET_UNTIL;
  });

  it("accepts the claimed instance's own token and refuses another's", async () => {
    const app = await buildApp();
    expect((await send(app, 'derived-inst-1')).statusCode).toBe(200);
    expect((await send(app, 'derived-default')).statusCode).toBe(401);
  });

  it('refuses the old shared secret outside a rollout window', async () => {
    const app = await buildApp();
    expect((await send(app, 'shared')).statusCode).toBe(401);
    process.env.GITLAB_LEGACY_WEBHOOK_SECRET_UNTIL = '2000-01-01T00:00:00Z';
    expect((await send(app, 'shared')).statusCode).toBe(401);
  });

  it('accepts the old shared secret while the rollout window is open', async () => {
    const app = await buildApp();
    process.env.GITLAB_LEGACY_WEBHOOK_SECRET_UNTIL = new Date(
      Date.now() + 86_400_000
    ).toISOString();
    expect((await send(app, 'shared')).statusCode).toBe(200);
    expect((await send(app, 'wrong')).statusCode).toBe(401);
  });
});

describe('autograde results', () => {
  const body = (repo: string) => ({
    payload: { classroomSlug: 'c1', repo, sha: 'abc', token: 't', results: { a: {} } },
  });
  const post = (app: FastifyInstance, repo: string) =>
    app.inject({ method: 'POST', url: '/webhooks/callback/autograde', payload: body(repo) });

  beforeEach(() => {
    ingestTrigger.mockClear();
    verifyToken.mockReset();
  });

  it('refuses a token that is not the repo’s own, without starting anything', async () => {
    verifyToken.mockReturnValue(false);
    const app = await buildApp();
    expect((await post(app, 'cs/c1/projects/hw1-a')).statusCode).toBe(401);
    expect(ingestTrigger).not.toHaveBeenCalled();
  });

  it('starts the ingest task for a valid token, and caps each repo per minute', async () => {
    verifyToken.mockReturnValue(true);
    const app = await buildApp();
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await post(app, 'cs/c1/projects/hw1-b')).statusCode);
    expect(codes.filter(c => c === 202)).toHaveLength(20);
    expect(codes.slice(20)).toEqual([429, 429]);
    expect(ingestTrigger).toHaveBeenCalledTimes(20);
    // Another repo has its own budget.
    expect((await post(app, 'cs/c1/projects/hw1-c')).statusCode).toBe(202);
  });

  it('rejects a report missing its fields', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/autograde',
      payload: { payload: { repo: 'x' } },
    });
    expect(res.statusCode).toBe(400);
  });
});
