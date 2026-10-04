import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';

/**
 * Live editing: a push to a collab-enabled classroom's content repo that did
 * not come from the checkpoint worker is handed to the collab service
 * (`POST /internal/:kind/:id/external { sha }`) so the live doc merges it in.
 *
 * Covered here: the worker's own pushes (trailer, recorded pushed_commit) are
 * skipped; page and deck files map to their rows by `content_path`; an
 * unflagged classroom never talks to collab; a truncated or forced push
 * notifies every live doc; collab being down is logged and never stops the
 * content-asset sync.
 */

const GITHUB_SECRET = 'test-gh-secret';
const HEAD = 'c'.repeat(40);
const COLLAB = 'http://collab.test';

const contentAssetsSync = vi.fn().mockResolvedValue(undefined);
const findFirst = vi.fn();
const gitRepoFindUnique = vi.fn();
const pageFindMany = vi.fn();
const slideFindMany = vi.fn();
const collabDocFindMany = vi.fn();

vi.mock('@classmoji/tasks', () => ({
  default: {
    contentAssetsSyncTask: { trigger: contentAssetsSync },
    repositoryPushHandlerTask: { trigger: vi.fn() },
  },
}));

const prisma = () => ({
  classroom: { findFirst },
  gitRepo: { findUnique: gitRepoFindUnique },
  page: { findMany: pageFindMany },
  slide: { findMany: slideFindMany },
  collabDoc: { findMany: collabDocFindMany },
});

vi.mock('@classmoji/database', () => ({ getPrisma: prisma, default: prisma }));

const sign = (body: string): string =>
  `sha256=${crypto.createHmac('sha256', GITHUB_SECRET).update(body).digest('hex')}`;

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

interface Commit {
  id?: string;
  message?: string;
  added?: string[];
  modified?: string[];
  removed?: string[];
}

const pushBody = (commits: Commit[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ref: 'refs/heads/main',
    before: 'a'.repeat(40),
    after: HEAD,
    created: false,
    deleted: false,
    forced: false,
    commits,
    repository: {
      name: 'content-cs101',
      default_branch: 'main',
      owner: { login: 'acme', name: 'acme' },
    },
    sender: { login: 'someone', type: 'User' },
    ...extra,
  });

const post = (app: FastifyInstance, body: string) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/callback/github',
    headers: {
      'x-hub-signature-256': sign(body),
      'x-github-event': 'push',
      'content-type': 'application/json',
    },
    payload: body,
  });

const fetchMock = vi.fn();
const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** The `/external` calls fetch saw, as `kind/id` → sha. */
const externalCalls = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    sha: JSON.parse(String((init as RequestInit).body)).sha as string,
    secret: ((init as RequestInit).headers as Record<string, string>)['x-collab-secret'],
  }));

/** Let the detached notify promise settle (inject resolves before it). */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};

let app: FastifyInstance;
let logInfo: ReturnType<typeof vi.spyOn>;
let logError: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.stubEnv('COLLAB_URL', COLLAB);
  vi.stubEnv('COLLAB_INTERNAL_SECRET', 'sekrit');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    okResponse({ action: 'merged', version: 3, conflicts: [] })
  );
  contentAssetsSync.mockClear();
  findFirst.mockReset();
  gitRepoFindUnique.mockReset();
  pageFindMany.mockReset();
  slideFindMany.mockReset();
  collabDocFindMany.mockReset();

  findFirst.mockResolvedValue({ id: 'classroom-1', collab_enabled: true });
  gitRepoFindUnique.mockResolvedValue(null);
  pageFindMany.mockImplementation(
    async ({ where }: { where: { content_path: { in: string[] } } }) =>
      where.content_path.in
        .filter(p => p === 'pages/intro' || p === 'pages/week-1')
        .map(p => ({ id: `page-${p.split('/')[1]}`, content_path: p }))
  );
  slideFindMany.mockImplementation(
    async ({ where }: { where: { content_path: { in: string[] } } }) =>
      where.content_path.in
        .filter(p => p === 'slides/lecture-1')
        .map(p => ({ id: 'deck-lecture-1', content_path: p }))
  );
  collabDocFindMany.mockResolvedValue([]);

  logInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
  logError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  app = await buildApp();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('outside pushes reach the collab service', () => {
  it('maps a page content.json and a deck deck.json to their rows and posts the head commit', async () => {
    const response = await post(
      app,
      pushBody([
        { id: '1', message: 'Edit intro on github.com', modified: ['pages/intro/content.json'] },
        { id: '2', message: 'Tweak slides', modified: ['slides/lecture-1/deck.json'] },
      ])
    );
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(pageFindMany).toHaveBeenCalledWith({
      where: { classroom_id: 'classroom-1', content_path: { in: ['pages/intro'] } },
      select: { id: true, content_path: true },
    });
    expect(slideFindMany).toHaveBeenCalledWith({
      where: {
        classroom_id: 'classroom-1',
        kind: 'DECK',
        content_path: { in: ['slides/lecture-1'] },
      },
      select: { id: true, content_path: true },
    });
    const calls = externalCalls().sort((a, b) => a.url.localeCompare(b.url));
    expect(calls).toEqual([
      { url: `${COLLAB}/internal/deck/deck-lecture-1/external`, sha: HEAD, secret: 'sekrit' },
      { url: `${COLLAB}/internal/page/page-intro/external`, sha: HEAD, secret: 'sekrit' },
    ]);
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
  });

  it('ignores other files, including a page asset or a deck index.html', async () => {
    await post(
      app,
      pushBody([
        {
          message: 'assets',
          added: ['pages/intro/assets/a.png', 'slides/lecture-1/index.html', 'README.md'],
        },
      ])
    );
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(collabDocFindMany).not.toHaveBeenCalled();
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
  });

  it("skips the checkpoint worker's own commits (Classmoji-Collab trailer)", async () => {
    await post(
      app,
      pushBody([
        {
          message:
            'Update Intro (live editing)\n\nClassmoji-Collab: run_123\nCo-authored-by: A <1+a@users.noreply.github.com>',
          modified: ['pages/intro/content.json', 'slides/lecture-1/deck.json'],
        },
      ])
    );
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
  });

  it('still notifies a doc an outside commit touched in the same push as one of ours', async () => {
    await post(
      app,
      pushBody([
        {
          message: 'Update Intro (live editing)\n\nClassmoji-Collab: run_1',
          modified: ['pages/intro/content.json'],
        },
        { message: 'Fix typo in week 1', modified: ['pages/week-1/content.json'] },
      ])
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();

    expect(externalCalls().map(c => c.url)).toEqual([
      `${COLLAB}/internal/page/page-week-1/external`,
    ]);
  });

  it("skips a doc whose recorded pushed_commit is this push's head", async () => {
    collabDocFindMany.mockResolvedValue([
      { kind: 'page', doc_id: 'page-intro', pushed_commit: HEAD },
      { kind: 'deck', doc_id: 'deck-lecture-1', pushed_commit: 'd'.repeat(40) },
    ]);

    await post(
      app,
      pushBody([
        {
          message: 'no trailer',
          modified: ['pages/intro/content.json', 'slides/lecture-1/deck.json'],
        },
      ])
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();

    expect(externalCalls().map(c => c.url)).toEqual([
      `${COLLAB}/internal/deck/deck-lecture-1/external`,
    ]);
  });

  it('does not post a file the push deleted', async () => {
    await post(
      app,
      pushBody([
        { message: 'edit', modified: ['pages/intro/content.json'] },
        { message: 'remove', removed: ['pages/intro/content.json'] },
      ])
    );
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves a classroom without collab_enabled untouched', async () => {
    findFirst.mockResolvedValue({ id: 'classroom-1', collab_enabled: false });

    await post(app, pushBody([{ message: 'edit', modified: ['pages/intro/content.json'] }]));
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(pageFindMany).not.toHaveBeenCalled();
    expect(collabDocFindMany).not.toHaveBeenCalled();
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
  });

  it('logs and carries on when collab is unreachable; the asset sync still runs', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const response = await post(
      app,
      pushBody([{ message: 'edit', modified: ['pages/intro/content.json'] }])
    );
    expect(response.statusCode).toBe(200);
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('page/page-intro'),
        expect.any(TypeError)
      )
    );
  });

  it('logs a collab error response', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'legacy-html' }), { status: 422 })
    );

    await post(app, pushBody([{ message: 'edit', modified: ['pages/intro/content.json'] }]));
    await vi.waitFor(() =>
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('HTTP 422'))
    );
  });

  it('a database failure in the collab lookup does not stop the asset sync', async () => {
    pageFindMany.mockRejectedValue(new Error('db down'));

    const response = await post(
      app,
      pushBody([{ message: 'edit', modified: ['pages/intro/content.json'] }])
    );
    expect(response.statusCode).toBe(200);
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('notify failed'),
        expect.any(Error)
      )
    );
  });

  it('logs the action collab took for each doc', async () => {
    await post(app, pushBody([{ message: 'edit', modified: ['pages/intro/content.json'] }]));
    await vi.waitFor(() =>
      expect(logInfo).toHaveBeenCalledWith(
        `[collab:external] page/page-intro @ ${HEAD}: merged conflicts=0`
      )
    );
  });
});

describe('pushes whose full diff we cannot see', () => {
  const rows = [
    { kind: 'page', doc_id: 'page-live', pushed_commit: 'e'.repeat(40) },
    { kind: 'deck', doc_id: 'deck-live', pushed_commit: null },
    { kind: 'page', doc_id: 'page-ours', pushed_commit: HEAD },
  ];

  it('a truncated push (20 commits) notifies every live doc plus the visible ones', async () => {
    collabDocFindMany.mockResolvedValue(rows);
    const commits = Array.from({ length: 20 }, (_, i) => ({
      message: `c${i}`,
      modified: i === 0 ? ['pages/intro/content.json'] : ['images/x.png'],
    }));

    await post(app, pushBody(commits));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await settle();

    expect(
      externalCalls()
        .map(c => c.url)
        .sort()
    ).toEqual([
      `${COLLAB}/internal/deck/deck-live/external`,
      `${COLLAB}/internal/page/page-intro/external`,
      `${COLLAB}/internal/page/page-live/external`,
    ]);
    // The sync side sees the same truncation.
    expect(contentAssetsSync.mock.calls[0][0]).toMatchObject({ complete: false });
  });

  it('a force-push notifies every live doc', async () => {
    collabDocFindMany.mockResolvedValue(rows);

    await post(app, pushBody([], { forced: true }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await settle();

    expect(
      externalCalls()
        .map(c => c.url)
        .sort()
    ).toEqual([
      `${COLLAB}/internal/deck/deck-live/external`,
      `${COLLAB}/internal/page/page-live/external`,
    ]);
  });

  it('a branch deletion never reaches collab', async () => {
    collabDocFindMany.mockResolvedValue(rows);

    await post(app, pushBody([], { deleted: true, forced: true, after: '0'.repeat(40) }));
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
  });
});
