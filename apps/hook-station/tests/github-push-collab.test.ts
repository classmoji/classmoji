import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';

/**
 * Live editing: a push to a content repo that did not come from the checkpoint
 * worker is handed to the collab service through the `collab-external`
 * Trigger.dev task, one run per changed page/deck, so the live doc merges it.
 *
 * Covered here, end to end through the route: which commits are ours (Bot
 * sender + trailer in the final paragraph; recorded pushed_commit unless
 * forced), page and deck path mapping, the payload and trigger options,
 * flagged vs unflagged classrooms (rows left = still notified), truncated and
 * forced pushes through GitHub's compare API with the every-row fallback, the
 * org lookup by GitHub id, and failures that must never stop the asset sync.
 */

const GITHUB_SECRET = 'test-gh-secret';
const BEFORE = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);

const contentAssetsSync = vi.fn().mockResolvedValue(undefined);
const findFirst = vi.fn();
const gitRepoFindUnique = vi.fn();
const pageFindMany = vi.fn();
const slideFindMany = vi.fn();
const collabDocFindMany = vi.fn();
const tasksTrigger = vi.fn();
const getInstallationToken = vi.fn();
const getGitProvider = vi.fn(() => ({ getInstallationToken }));

vi.mock('@classmoji/tasks', () => ({
  default: {
    contentAssetsSyncTask: { trigger: contentAssetsSync },
    repositoryPushHandlerTask: { trigger: vi.fn() },
  },
}));

vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger: tasksTrigger } }));
vi.mock('@classmoji/services', () => ({ getGitProvider }));

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
    before: BEFORE,
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

const BOT = { sender: { login: 'classmoji[bot]', type: 'Bot' } };

const CHECKPOINT_MESSAGE =
  'Update Intro (live editing)\n\nBefore the midterm\n\nClassmoji-Collab: run_123\nCo-authored-by: A <1+a@users.noreply.github.com>\n';

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

/** `kind/docId` of every collab-external run triggered, sorted. */
const notified = () =>
  tasksTrigger.mock.calls.map(([, payload]) => `${payload.kind}/${payload.docId}`).sort();

/** Let the detached notify promise settle (inject resolves before it). */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
};

/** Compare API responses keyed by `base...head`. */
let compareFiles: Record<
  string,
  { filename: string; status: string; previous_filename?: string }[]
>;
const fetchMock = vi.fn();

let logError: ReturnType<typeof vi.spyOn>;
let logWarn: ReturnType<typeof vi.spyOn>;
let app: FastifyInstance;

beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  compareFiles = {};
  fetchMock.mockImplementation(async (url: string) => {
    const match = /\/compare\/(.+)$/.exec(String(url));
    const files = match ? compareFiles[match[1] as string] : undefined;
    return files
      ? new Response(JSON.stringify({ files }), { status: 200 })
      : new Response('{}', { status: 404 });
  });
  tasksTrigger.mockReset();
  tasksTrigger.mockResolvedValue({ id: 'run_1' });
  getInstallationToken.mockReset();
  getInstallationToken.mockResolvedValue({ token: 'inst-token' });
  getGitProvider.mockClear();
  contentAssetsSync.mockClear();
  findFirst.mockReset();
  gitRepoFindUnique.mockReset();
  pageFindMany.mockReset();
  slideFindMany.mockReset();
  collabDocFindMany.mockReset();

  findFirst.mockResolvedValue({
    id: 'classroom-1',
    collab_enabled: true,
    git_organization: { provider: 'GITHUB', github_installation_id: '99', login: 'acme' },
  });
  gitRepoFindUnique.mockResolvedValue(null);
  pageFindMany.mockImplementation(
    async ({ where }: { where: { content_path: { in: string[] } } }) =>
      where.content_path.in
        .filter(p => ['pages/intro', 'pages/week-1', 'pages/old'].includes(p))
        .map(p => ({ id: `page-${p.split('/')[1]}`, content_path: p }))
  );
  slideFindMany.mockImplementation(
    async ({ where }: { where: { content_path: { in: string[] } } }) =>
      where.content_path.in
        .filter(p => p === 'slides/lecture-1')
        .map(p => ({ id: 'deck-lecture-1', content_path: p }))
  );
  collabDocFindMany.mockResolvedValue([]);

  vi.spyOn(console, 'info').mockImplementation(() => {});
  logWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logError = vi.spyOn(console, 'error').mockImplementation(() => {});
  app = await buildApp();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('outside pushes queue a collab-external run per changed doc', () => {
  it('maps content.json / deck.json to their rows and triggers by id with sha + before', async () => {
    const response = await post(
      app,
      pushBody([
        { message: 'Edit intro on github.com', modified: ['pages/intro/content.json'] },
        { message: 'Tweak slides', modified: ['slides/lecture-1/deck.json'] },
      ])
    );
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(tasksTrigger).toHaveBeenCalledTimes(2));

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
    const page = tasksTrigger.mock.calls.find(([, p]) => p.kind === 'page');
    expect(page).toEqual([
      'collab-external',
      { classroomId: 'classroom-1', kind: 'page', docId: 'page-intro', sha: HEAD, before: BEFORE },
      {
        // One classroom's notifications run one at a time, in order.
        concurrencyKey: 'classroom-1',
        idempotencyKey: `collab-external:page:page-intro:${BEFORE}..${HEAD}`,
        idempotencyKeyTTL: '1h',
      },
    ]);
    expect(notified()).toEqual(['deck/deck-lecture-1', 'page/page-intro']);
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
  });

  it('ignores other files, including a page asset or a deck index.html, without a query', async () => {
    await post(
      app,
      pushBody([
        { message: 'assets', added: ['pages/intro/assets/a.png', 'slides/lecture-1/index.html'] },
      ])
    );
    await settle();

    expect(tasksTrigger).not.toHaveBeenCalled();
    expect(collabDocFindMany).not.toHaveBeenCalled();
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
  });

  it('does not notify a file the push deleted', async () => {
    await post(
      app,
      pushBody([
        { message: 'edit', modified: ['pages/intro/content.json'] },
        { message: 'remove', removed: ['pages/intro/content.json'] },
      ])
    );
    await settle();

    expect(tasksTrigger).not.toHaveBeenCalled();
  });
});

describe("the checkpoint worker's own pushes", () => {
  it('skips a Bot-sent commit with the trailer in its final paragraph', async () => {
    await post(
      app,
      pushBody([{ message: CHECKPOINT_MESSAGE, modified: ['pages/intro/content.json'] }], BOT)
    );
    await settle();

    expect(tasksTrigger).not.toHaveBeenCalled();
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
  });

  it('does not trust the trailer from a User sender (e.g. typed into a web edit)', async () => {
    await post(
      app,
      pushBody([{ message: CHECKPOINT_MESSAGE, modified: ['pages/intro/content.json'] }])
    );
    await vi.waitFor(() => expect(tasksTrigger).toHaveBeenCalledTimes(1));
    expect(notified()).toEqual(['page/page-intro']);
  });

  it('does not trust a trailer outside the final paragraph', async () => {
    await post(
      app,
      pushBody(
        [
          {
            message: 'Fix intro\n\nClassmoji-Collab: run_1\n\nSigned-off-by: X <x@example.com>',
            modified: ['pages/intro/content.json'],
          },
        ],
        BOT
      )
    );
    await vi.waitFor(() => expect(tasksTrigger).toHaveBeenCalledTimes(1));
  });

  it('still notifies a doc an outside commit touched in the same push as one of ours', async () => {
    await post(
      app,
      pushBody(
        [
          { message: CHECKPOINT_MESSAGE, modified: ['pages/intro/content.json'] },
          { message: 'Fix typo in week 1', modified: ['pages/week-1/content.json'] },
        ],
        BOT
      )
    );
    await vi.waitFor(() => expect(tasksTrigger).toHaveBeenCalledTimes(1));
    await settle();

    expect(notified()).toEqual(['page/page-week-1']);
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
    await vi.waitFor(() => expect(tasksTrigger).toHaveBeenCalledTimes(1));
    await settle();

    expect(notified()).toEqual(['deck/deck-lecture-1']);
  });

  it('a force-push back to a commit we pushed is NOT skipped by pushed_commit', async () => {
    collabDocFindMany.mockResolvedValue([
      { kind: 'page', doc_id: 'page-intro', pushed_commit: HEAD },
    ]);
    compareFiles[`${BEFORE}...${HEAD}`] = [];
    compareFiles[`${HEAD}...${BEFORE}`] = [
      { filename: 'pages/intro/content.json', status: 'modified' },
    ];

    await post(app, pushBody([], { forced: true }));
    await vi.waitFor(() => expect(tasksTrigger).toHaveBeenCalledTimes(1));
    expect(notified()).toEqual(['page/page-intro']);
  });
});

describe('which classrooms', () => {
  it('leaves a classroom with the flag off and no collab_docs rows untouched', async () => {
    findFirst.mockResolvedValue({
      id: 'classroom-1',
      collab_enabled: false,
      git_organization: null,
    });

    await post(app, pushBody([{ message: 'edit', modified: ['pages/intro/content.json'] }]));
    await settle();

    expect(collabDocFindMany).toHaveBeenCalledTimes(1);
    expect(pageFindMany).not.toHaveBeenCalled();
    expect(tasksTrigger).not.toHaveBeenCalled();
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
  });

  it('with the flag off but rows left, notifies the changed docs that have a row', async () => {
    findFirst.mockResolvedValue({
      id: 'classroom-1',
      collab_enabled: false,
      git_organization: null,
    });
    collabDocFindMany.mockResolvedValue([
      { kind: 'page', doc_id: 'page-intro', pushed_commit: 'e'.repeat(40) },
    ]);

    await post(
      app,
      pushBody([
        { message: 'edit', modified: ['pages/intro/content.json', 'pages/week-1/content.json'] },
      ])
    );
    await vi.waitFor(() => expect(tasksTrigger).toHaveBeenCalledTimes(1));
    await settle();

    expect(notified()).toEqual(['page/page-intro']);
  });

  it("finds the classroom by the org's GitHub id when the payload carries it", async () => {
    await post(
      app,
      pushBody([{ message: 'x', added: ['images/a.png'] }], {
        repository: {
          name: 'content-cs101',
          default_branch: 'main',
          owner: { id: 31337, login: 'renamed-org', name: 'renamed-org' },
        },
      })
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          content_repo: 'content-cs101',
          git_organization: { provider: 'GITHUB', provider_id: '31337' },
        },
      })
    );
  });
});

describe('pushes whose full diff the payload does not show', () => {
  const many = (n: number, first: Commit) =>
    Array.from({ length: n }, (_, i) =>
      i === 0 ? first : { message: `c${i}`, modified: ['images/x.png'] }
    );

  it('a 20-commit push is complete for collab (the payload holds 2048), still a full re-read for assets', async () => {
    await post(
      app,
      pushBody(many(20, { message: 'edit', modified: ['pages/intro/content.json'] }))
    );
    await vi.waitFor(() => expect(tasksTrigger).toHaveBeenCalledTimes(1));

    expect(fetchMock).not.toHaveBeenCalled(); // no compare needed
    expect(contentAssetsSync.mock.calls[0][0]).toMatchObject({ complete: false });
  });

  it('a truncated push (2048 commits) takes its files from the compare API', async () => {
    collabDocFindMany.mockResolvedValue([
      { kind: 'page', doc_id: 'page-unrelated', pushed_commit: null },
    ]);
    compareFiles[`${BEFORE}...${HEAD}`] = [
      { filename: 'pages/week-1/content.json', status: 'modified' },
      { filename: 'slides/lecture-1/deck.json', status: 'added' },
      { filename: 'pages/intro/content.json', status: 'removed' },
    ];

    await post(app, pushBody(many(2048, { message: 'x', modified: ['images/y.png'] })));
    await vi.waitFor(() => expect(tasksTrigger).toHaveBeenCalledTimes(2));
    await settle();

    expect(notified()).toEqual(['deck/deck-lecture-1', 'page/page-week-1']);
    expect(getGitProvider).toHaveBeenCalledWith({
      provider: 'GITHUB',
      github_installation_id: '99',
      login: 'acme',
    });
    expect(getInstallationToken).toHaveBeenCalledWith({
      repositories: ['content-cs101'],
      permissions: { contents: 'read' },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/acme/content-cs101/compare/${BEFORE}...${HEAD}`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer inst-token');
  });

  it('a force-push compares both ways from the merge base', async () => {
    compareFiles[`${BEFORE}...${HEAD}`] = [
      { filename: 'pages/week-1/content.json', status: 'modified' },
    ];
    compareFiles[`${HEAD}...${BEFORE}`] = [
      // The rewrite dropped an edit to intro: at HEAD it is back at the base.
      { filename: 'pages/intro/content.json', status: 'modified' },
      // The dropped commits added this page; at HEAD it does not exist.
      { filename: 'pages/old/content.json', status: 'added' },
    ];

    await post(app, pushBody([], { forced: true }));
    await vi.waitFor(() => expect(tasksTrigger).toHaveBeenCalledTimes(2));
    await settle();

    expect(notified()).toEqual(['page/page-intro', 'page/page-week-1']);
  });

  it('falls back to every collab_docs row when compare is unavailable', async () => {
    collabDocFindMany.mockResolvedValue([
      { kind: 'page', doc_id: 'page-live', pushed_commit: 'e'.repeat(40) },
      { kind: 'deck', doc_id: 'deck-live', pushed_commit: null },
      { kind: 'page', doc_id: 'page-ours', pushed_commit: HEAD },
    ]);
    // No compareFiles registered: the API answers 404.

    await post(app, pushBody(many(2048, { message: 'x', modified: ['images/y.png'] })));
    await vi.waitFor(() => expect(tasksTrigger).toHaveBeenCalledTimes(2));
    await settle();

    expect(notified()).toEqual(['deck/deck-live', 'page/page-live']);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('HTTP 404'));
  });

  it('falls back when the compare lists 300+ files (GitHub truncates the list)', async () => {
    collabDocFindMany.mockResolvedValue([
      { kind: 'page', doc_id: 'page-live', pushed_commit: null },
    ]);
    compareFiles[`${BEFORE}...${HEAD}`] = Array.from({ length: 300 }, (_, i) => ({
      filename: `images/${i}.png`,
      status: 'added',
    }));

    await post(app, pushBody([], { forced: true }));
    await vi.waitFor(() => expect(tasksTrigger).toHaveBeenCalledTimes(1));
    expect(notified()).toEqual(['page/page-live']);
  });

  it('falls back without calling GitHub when the org has no installation', async () => {
    findFirst.mockResolvedValue({
      id: 'classroom-1',
      collab_enabled: true,
      git_organization: { provider: 'GITHUB', github_installation_id: null, login: 'acme' },
    });
    collabDocFindMany.mockResolvedValue([
      { kind: 'page', doc_id: 'page-live', pushed_commit: null },
    ]);

    await post(app, pushBody([], { forced: true }));
    await vi.waitFor(() => expect(tasksTrigger).toHaveBeenCalledTimes(1));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a branch deletion never reaches collab', async () => {
    collabDocFindMany.mockResolvedValue([
      { kind: 'page', doc_id: 'page-live', pushed_commit: null },
    ]);

    await post(app, pushBody([], { deleted: true, forced: true, after: '0'.repeat(40) }));
    await settle();

    expect(tasksTrigger).not.toHaveBeenCalled();
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
  });
});

describe('failures never stop the asset sync', () => {
  it('a trigger failure is logged per doc', async () => {
    tasksTrigger.mockRejectedValue(new Error('trigger.dev down'));

    const response = await post(
      app,
      pushBody([{ message: 'edit', modified: ['pages/intro/content.json'] }])
    );
    expect(response.statusCode).toBe(200);
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('page/page-intro'),
        expect.any(Error)
      )
    );
  });

  it('a database failure in the collab lookup is logged', async () => {
    collabDocFindMany.mockRejectedValue(new Error('db down'));

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
});
