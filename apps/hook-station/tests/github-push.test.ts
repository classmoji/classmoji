import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';

/**
 * The `push` branch of the GitHub webhook: which pushes reach the sync task,
 * and what change set they carry.
 *
 * ── Why this is its own file ───────────────────────────────────────────────
 * Every other GitHub event dispatches off `payload.action`. A push has no
 * `action` at all — it is identified by the `x-github-event` header — so this
 * branch runs before the handler map and shares none of its logic.
 *
 * ── What must not happen here ──────────────────────────────────────────────
 * The App sees a push for EVERY repo in the org, and in a live classroom the
 * overwhelming majority are student assignment repos pushing all day. A push
 * that isn't a content repo must cost one indexed read and trigger nothing;
 * "no classroom" is the ordinary case, not an error.
 */

// Must match the secret set in tests/setup.ts before any route import.
const GITHUB_SECRET = 'test-gh-secret';

const contentAssetsSync = vi.fn().mockResolvedValue(undefined);
const findFirst = vi.fn();

vi.mock('@classmoji/tasks', () => ({
  default: {
    contentAssetsSyncTask: { trigger: contentAssetsSync },
  },
}));

vi.mock('@classmoji/database', () => ({
  getPrisma: () => ({ classroom: { findFirst } }),
  default: () => ({ classroom: { findFirst } }),
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

interface PushOverrides {
  ref?: string;
  forced?: boolean;
  before?: string;
  after?: string;
  created?: boolean;
  deleted?: boolean;
  repo?: string;
  owner?: string;
  defaultBranch?: string;
  commits?: { added?: string[]; modified?: string[]; removed?: string[] }[];
}

const pushBody = ({
  ref = 'refs/heads/main',
  forced = false,
  repo = 'content-cs101',
  owner = 'acme',
  defaultBranch = 'main',
  before = 'a'.repeat(40),
  after = 'b'.repeat(40),
  created = false,
  deleted = false,
  commits = [{ added: ['images/one.png'], modified: [], removed: [] }],
}: PushOverrides = {}): string =>
  JSON.stringify({
    ref,
    before,
    after,
    created,
    deleted,
    forced,
    commits,
    repository: {
      name: repo,
      default_branch: defaultBranch,
      owner: { login: owner, name: owner },
    },
  });

const post = async (app: FastifyInstance, body: string) =>
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

let app: FastifyInstance;

beforeEach(async () => {
  contentAssetsSync.mockClear();
  findFirst.mockReset();
  // The default: this repo IS a classroom's content repo.
  findFirst.mockResolvedValue({ id: 'classroom-1' });
  app = await buildApp();
});

describe('which pushes are ours', () => {
  it('triggers the sync for a push to a content repo, with the paths aggregated', async () => {
    const body = pushBody({
      commits: [
        { added: ['images/one.png'], modified: [], removed: [] },
        { added: [], modified: ['pages/intro.md'], removed: ['images/old.png'] },
      ],
    });

    const response = await post(app, body);

    expect(response.statusCode).toBe(200);
    expect(findFirst).toHaveBeenCalledWith({
      where: { content_repo: 'content-cs101', git_organization: { login: 'acme' } },
      select: { id: true },
    });
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
    expect(contentAssetsSync).toHaveBeenCalledWith(
      {
        classroomId: 'classroom-1',
        reason: 'push',
        changes: {
          added: ['images/one.png'],
          modified: ['pages/intro.md'],
          removed: ['images/old.png'],
        },
        forced: false,
        complete: true,
        before: 'a'.repeat(40),
        after: 'b'.repeat(40),
      },
      // One sync per classroom at a time: two deliveries for one repo applied
      // concurrently can record their commits in either order, moving the map's
      // recorded commit backwards and hiding the gap `before` exists to expose.
      { concurrencyKey: 'classroom-1' }
    );
  });

  /**
   * `before` is the only way the sync can tell an EARLIER delivery went
   * missing: a push whose parent is not the commit the map is level with proves
   * the repo moved unseen, and that run has to re-read the whole tree instead of
   * applying a diff against a state nobody holds. `after` is the commit the map
   * records once it has applied this one.
   */
  it('reports the commits the push spans, so a dropped delivery is detectable', async () => {
    await post(app, pushBody({ before: 'c'.repeat(40), after: 'd'.repeat(40) }));

    const payload = contentAssetsSync.mock.calls[0][0];
    expect(payload.before).toBe('c'.repeat(40));
    expect(payload.after).toBe('d'.repeat(40));
  });

  /**
   * GitHub sends 40 zeros as `before` when a ref is CREATED. Forwarded as-is:
   * it is not the commit any map is level with, so the sync treats it as the
   * gap it is and re-reads the whole tree rather than applying a diff against
   * a state nobody holds.
   */
  it('forwards the all-zero before of a branch-creation push', async () => {
    await post(app, pushBody({ before: '0'.repeat(40), created: true }));

    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
    expect(contentAssetsSync.mock.calls[0][0].before).toBe('0'.repeat(40));
  });

  /**
   * `created` and `deleted` are fields the handler has no opinion about. It
   * must not choke on them — a push it fails to answer is a delivery GitHub
   * records as failed and a map that silently stops converging.
   */
  it('handles created/deleted push flags without breaking', async () => {
    const created = await post(app, pushBody({ created: true, before: '0'.repeat(40) }));
    expect(created.statusCode).toBe(200);

    contentAssetsSync.mockClear();

    const deleted = await post(
      app,
      pushBody({ deleted: true, after: '0'.repeat(40), commits: [] })
    );
    expect(deleted.statusCode).toBe(200);
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
    expect(contentAssetsSync.mock.calls[0][0].after).toBe('0'.repeat(40));
  });

  /**
   * The load-bearing exit. Student repos push constantly and none of them are
   * content repos, so this path must stop at the classroom lookup.
   */
  it('ignores a push to a repo no classroom claims as its content repo', async () => {
    findFirst.mockResolvedValue(null);

    const response = await post(app, pushBody({ repo: 'cs101-assignment-1-alice' }));

    expect(response.statusCode).toBe(200);
    expect(contentAssetsSync).not.toHaveBeenCalled();
  });

  /**
   * Pages render from the default branch, so a feature branch changes nothing
   * anybody can see — and must not cost even the classroom lookup.
   */
  it('ignores a push to a branch that is not the default one', async () => {
    const response = await post(app, pushBody({ ref: 'refs/heads/draft-week-3' }));

    expect(response.statusCode).toBe(200);
    expect(findFirst).not.toHaveBeenCalled();
    expect(contentAssetsSync).not.toHaveBeenCalled();
  });

  it('follows the repo default branch rather than assuming main', async () => {
    const response = await post(app, pushBody({ ref: 'refs/heads/trunk', defaultBranch: 'trunk' }));

    expect(response.statusCode).toBe(200);
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
  });

  it('does not route a non-push event through the push handler', async () => {
    const body = JSON.stringify({ action: 'totally_unknown_action_xyz' });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'issues',
        'content-type': 'application/json',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(findFirst).not.toHaveBeenCalled();
    expect(contentAssetsSync).not.toHaveBeenCalled();
  });
});

describe('what the task is told about the push', () => {
  /**
   * A force-push rewrites history: the commits listed are not a diff against
   * what we last synced, so the task has to re-read the whole tree.
   */
  it('reports a force-push as forced', async () => {
    await post(app, pushBody({ forced: true }));

    expect(contentAssetsSync.mock.calls[0][0].forced).toBe(true);
  });

  /**
   * GitHub caps `commits[]` at 20 and says nothing about it. At the cap the
   * diff may be missing paths entirely, which is `complete: false` — the
   * task's cue to fall back to a full sync.
   */
  it('reports a capped 20-commit payload as incomplete', async () => {
    const commits = Array.from({ length: 20 }, (_unused, index) => ({
      added: [`images/${index}.png`],
      modified: [],
      removed: [],
    }));

    await post(app, pushBody({ commits }));

    expect(contentAssetsSync.mock.calls[0][0].complete).toBe(false);
  });

  it('reports a 19-commit payload as complete', async () => {
    const commits = Array.from({ length: 19 }, (_unused, index) => ({
      added: [`images/${index}.png`],
      modified: [],
      removed: [],
    }));

    await post(app, pushBody({ commits }));

    expect(contentAssetsSync.mock.calls[0][0].complete).toBe(true);
  });

  /**
   * Last word on a path wins. A file added and then deleted in the same push
   * is GONE from the repo now, and reporting it as added would leave the map
   * signing URLs for a SHA that no longer resolves.
   */
  it('reports a path added then removed in the same push as removed', async () => {
    const body = pushBody({
      commits: [
        { added: ['images/temp.png'], modified: [], removed: [] },
        { added: [], modified: [], removed: ['images/temp.png'] },
      ],
    });

    await post(app, body);

    expect(contentAssetsSync.mock.calls[0][0].changes).toEqual({
      added: [],
      modified: [],
      removed: ['images/temp.png'],
    });
  });

  it('reports a path removed then re-added in the same push as added', async () => {
    const body = pushBody({
      commits: [
        { added: [], modified: [], removed: ['images/logo.png'] },
        { added: ['images/logo.png'], modified: [], removed: [] },
      ],
    });

    await post(app, body);

    expect(contentAssetsSync.mock.calls[0][0].changes).toEqual({
      added: ['images/logo.png'],
      modified: [],
      removed: [],
    });
  });

  it('does not report the same path twice when several commits touch it', async () => {
    const body = pushBody({
      commits: [
        { added: [], modified: ['pages/intro.md'], removed: [] },
        { added: [], modified: ['pages/intro.md'], removed: [] },
      ],
    });

    await post(app, body);

    expect(contentAssetsSync.mock.calls[0][0].changes.modified).toEqual(['pages/intro.md']);
  });

  it('still triggers on a push whose commits touched no files', async () => {
    await post(app, pushBody({ commits: [] }));

    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
    expect(contentAssetsSync.mock.calls[0][0].changes).toEqual({
      added: [],
      modified: [],
      removed: [],
    });
  });
});

describe('the signature still guards the push branch', () => {
  it('refuses an unsigned push without looking anything up', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/callback/github',
      headers: { 'x-github-event': 'push', 'content-type': 'application/json' },
      payload: pushBody(),
    });

    expect(response.statusCode).toBe(401);
    expect(findFirst).not.toHaveBeenCalled();
    expect(contentAssetsSync).not.toHaveBeenCalled();
  });
});
