/**
 * The `github-push` subscriber (githubWebhook.ts `handlePush`): which pushes
 * reach the push handler or the asset sync, and what change set they carry.
 * Ported from hook-station's github-push tests; signature checks and routing
 * by `X-GitHub-Event` now belong to Trigger.dev (the endpoint's source and the
 * subscriber's filter).
 *
 * The App sees a push for EVERY repo in the org, and in a live classroom the
 * overwhelming majority are student assignment repos pushing all day. A push
 * that isn't ours must cost one indexed read and trigger nothing; "no
 * classroom" is the ordinary case, not an error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  contentAssetsSync: vi.fn().mockResolvedValue(undefined),
  pushHandler: vi.fn().mockResolvedValue(undefined),
  findFirst: vi.fn(),
  gitRepoFindUnique: vi.fn(),
  notifyCollabOfPush: vi.fn().mockResolvedValue(undefined),
}));
const { contentAssetsSync, pushHandler, findFirst, gitRepoFindUnique } = mocks;

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  webhook: (config: unknown) => config,
  webhooks: { endpoint: { define: (config: unknown) => config }, github: () => ({}) },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@classmoji/database', () => {
  const prisma = () => ({
    classroom: { findFirst: mocks.findFirst },
    gitRepo: { findUnique: mocks.gitRepoFindUnique },
  });
  return { getPrisma: prisma, default: prisma };
});

vi.mock('../gitRepoAssignment.ts', () => ({
  repositoryAssignmentClosedHandlerTask: { trigger: vi.fn() },
  repositoryAssignmentReopenedHandlerTask: { trigger: vi.fn() },
  repositoryAssignmentDeletedHandlerTask: { trigger: vi.fn() },
  repositoryPushHandlerTask: { trigger: mocks.pushHandler },
}));
vi.mock('../organization.ts', () => ({ memberAddedHandlerTask: { trigger: vi.fn() } }));
vi.mock('../installation.ts', () => ({
  newInstallationHandlerTask: { trigger: vi.fn() },
  appUninstalledHandlerTask: { trigger: vi.fn() },
  appSuspendedHandlerTask: { trigger: vi.fn() },
  appUnsuspendedHandlerTask: { trigger: vi.fn() },
}));
vi.mock('../contentAssets.ts', () => ({
  contentAssetsSyncTask: { trigger: mocks.contentAssetsSync },
}));
// The live-editing side has its own tests (githubWebhook.pushCollab.test.ts).
vi.mock('../../helpers/collabPushNotify.ts', () => ({
  notifyCollabOfPush: mocks.notifyCollabOfPush,
  createCollabExternalTrigger: () => vi.fn(),
  createGithubCompare: () => undefined,
}));

import { handlePush, type PushEventPayload } from '../githubWebhook.ts';

interface PushOverrides {
  ref?: string;
  forced?: boolean;
  before?: string;
  after?: string;
  created?: boolean;
  deleted?: boolean;
  repo?: string;
  /** GitHub's numeric repository id; absent on the older-shaped payloads below. */
  repoId?: number;
  owner?: string;
  defaultBranch?: string;
  senderType?: string;
  commits?: { added?: string[]; modified?: string[]; removed?: string[] }[];
  /** repository.pushed_at: when GitHub received the push (epoch seconds). */
  pushedAt?: number;
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
  repoId,
  senderType = 'User',
  commits = [{ added: ['images/one.png'], modified: [], removed: [] }],
  pushedAt,
}: PushOverrides = {}): PushEventPayload =>
  ({
    ref,
    before,
    after,
    created,
    deleted,
    forced,
    commits,
    repository: {
      ...(repoId !== undefined ? { id: repoId } : {}),
      name: repo,
      default_branch: defaultBranch,
      owner: { login: owner, name: owner },
      ...(pushedAt !== undefined ? { pushed_at: pushedAt } : {}),
    },
    sender: { login: 'someone', type: senderType },
  }) as PushEventPayload;

beforeEach(() => {
  contentAssetsSync.mockClear();
  pushHandler.mockClear();
  mocks.notifyCollabOfPush.mockClear();
  findFirst.mockReset();
  gitRepoFindUnique.mockReset();
  // The default: this repo IS a classroom's content repo, and no student repo.
  findFirst.mockResolvedValue({ id: 'classroom-1' });
  gitRepoFindUnique.mockResolvedValue(null);
});

/**
 * A push to a STUDENT repo is a submission (REPO-mode assignments). The
 * lookup is by GitHub's repository id, checked before the content-repo path
 * because student pushes are the common case.
 */
describe('a push to a student repo is a submission', () => {
  const STUDENT = { repo: 'cs101-lab-1-alice', repoId: 4242 };

  it("records GitHub's server-side push time, even when the webhook arrives late", async () => {
    gitRepoFindUnique.mockResolvedValue({ id: 'gitrepo-1' });
    const pushedAtSeconds = Math.floor(Date.now() / 1000) - 3 * 3600; // 3h ago

    await handlePush(pushBody({ ...STUDENT, pushedAt: pushedAtSeconds }));

    const [payload] = pushHandler.mock.calls[0] as [{ pushedAt: string }];
    expect(new Date(payload.pushedAt).getTime()).toBe(pushedAtSeconds * 1000);
  });

  it('ignores a pushed_at in the future and uses the delivery time', async () => {
    gitRepoFindUnique.mockResolvedValue({ id: 'gitrepo-1' });
    const before = Date.now();

    await handlePush(pushBody({ ...STUDENT, pushedAt: Math.floor(Date.now() / 1000) + 86400 }));

    const [payload] = pushHandler.mock.calls[0] as [{ pushedAt: string }];
    const recorded = new Date(payload.pushedAt).getTime();
    expect(recorded).toBeGreaterThanOrEqual(before);
    expect(recorded).toBeLessThanOrEqual(Date.now());
  });

  it('hands a default-branch push to the push handler with the delivery time', async () => {
    gitRepoFindUnique.mockResolvedValue({ id: 'gitrepo-1' });
    const before = Date.now();

    await handlePush(pushBody(STUDENT));
    expect(gitRepoFindUnique).toHaveBeenCalledWith({
      where: { provider_provider_id: { provider: 'GITHUB', provider_id: '4242' } },
      select: { id: true },
    });
    expect(pushHandler).toHaveBeenCalledTimes(1);
    const [payload, options] = pushHandler.mock.calls[0] as [
      { gitRepoId: string; pushedAt: string },
      { concurrencyKey: string },
    ];
    expect(payload.gitRepoId).toBe('gitrepo-1');
    // Delivery time, never the commit's own timestamp.
    expect(new Date(payload.pushedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(options.concurrencyKey).toBe('gitrepo-1');
    // A student repo is never also a content repo; the sync is not consulted.
    expect(findFirst).not.toHaveBeenCalled();
    expect(contentAssetsSync).not.toHaveBeenCalled();
  });

  it('ignores a push to a branch other than the default', async () => {
    gitRepoFindUnique.mockResolvedValue({ id: 'gitrepo-1' });

    await handlePush(pushBody({ ...STUDENT, ref: 'refs/heads/feature' }));

    expect(pushHandler).not.toHaveBeenCalled();
    expect(gitRepoFindUnique).not.toHaveBeenCalled();
  });

  it('ignores a branch deletion', async () => {
    gitRepoFindUnique.mockResolvedValue({ id: 'gitrepo-1' });

    await handlePush(pushBody({ ...STUDENT, deleted: true, after: '0'.repeat(40), commits: [] }));

    expect(pushHandler).not.toHaveBeenCalled();
  });

  it("ignores a bot's push (Classmoji's own workflow commits)", async () => {
    gitRepoFindUnique.mockResolvedValue({ id: 'gitrepo-1' });

    await handlePush(pushBody({ ...STUDENT, senderType: 'Bot' }));

    expect(pushHandler).not.toHaveBeenCalled();
    expect(gitRepoFindUnique).not.toHaveBeenCalled();
  });

  it('falls through to the content-repo path when no student repo matches', async () => {
    gitRepoFindUnique.mockResolvedValue(null);

    await handlePush(pushBody({ repoId: 7, repo: 'content-cs101' }));

    expect(pushHandler).not.toHaveBeenCalled();
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
  });
});

describe('which pushes are ours', () => {
  it('triggers the sync for a push to a content repo, with the paths aggregated', async () => {
    const body = pushBody({
      commits: [
        { added: ['images/one.png'], modified: [], removed: [] },
        { added: [], modified: ['pages/intro.md'], removed: ['images/old.png'] },
      ],
    });

    await handlePush(body);
    expect(findFirst).toHaveBeenCalledWith({
      where: { content_repo: 'content-cs101', git_organization: { login: 'acme' } },
      select: {
        id: true,
        collab_enabled: true,
        git_organization: {
          select: { provider: true, github_installation_id: true, login: true },
        },
      },
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
    await handlePush(pushBody({ before: 'c'.repeat(40), after: 'd'.repeat(40) }));

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
    await handlePush(pushBody({ before: '0'.repeat(40), created: true }));

    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
    expect(contentAssetsSync.mock.calls[0][0].before).toBe('0'.repeat(40));
  });

  /**
   * `created` and `deleted` are fields the handler has no opinion about. It
   * must not choke on them — a push it fails to answer is a delivery GitHub
   * records as failed and a map that silently stops converging.
   */
  it('handles created/deleted push flags without breaking', async () => {
    await handlePush(pushBody({ created: true, before: '0'.repeat(40) }));
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);

    contentAssetsSync.mockClear();

    await handlePush(pushBody({ deleted: true, after: '0'.repeat(40), commits: [] }));
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
    expect(contentAssetsSync.mock.calls[0][0].after).toBe('0'.repeat(40));
  });

  /**
   * The load-bearing exit. Student repos push constantly and none of them are
   * content repos, so this path must stop at the classroom lookup.
   */
  it('ignores a push to a repo no classroom claims as its content repo', async () => {
    findFirst.mockResolvedValue(null);

    await handlePush(pushBody({ repo: 'cs101-assignment-1-alice' }));
    expect(contentAssetsSync).not.toHaveBeenCalled();
  });

  /**
   * Pages render from the default branch, so a feature branch changes nothing
   * anybody can see — and must not cost even the classroom lookup.
   */
  it('ignores a push to a branch that is not the default one', async () => {
    await handlePush(pushBody({ ref: 'refs/heads/draft-week-3' }));
    expect(findFirst).not.toHaveBeenCalled();
    expect(contentAssetsSync).not.toHaveBeenCalled();
  });

  it('follows the repo default branch rather than assuming main', async () => {
    await handlePush(pushBody({ ref: 'refs/heads/trunk', defaultBranch: 'trunk' }));
    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
  });
});

describe('what the task is told about the push', () => {
  /**
   * A force-push rewrites history: the commits listed are not a diff against
   * what we last synced, so the task has to re-read the whole tree.
   */
  it('reports a force-push as forced', async () => {
    await handlePush(pushBody({ forced: true }));

    expect(contentAssetsSync.mock.calls[0][0].forced).toBe(true);
  });

  /**
   * The sync applies a push incrementally only below 20 commits; at 20 or
   * more it is `complete: false`, the task's cue to re-read the whole tree.
   */
  it('reports a capped 20-commit payload as incomplete', async () => {
    const commits = Array.from({ length: 20 }, (_unused, index) => ({
      added: [`images/${index}.png`],
      modified: [],
      removed: [],
    }));

    await handlePush(pushBody({ commits }));

    expect(contentAssetsSync.mock.calls[0][0].complete).toBe(false);
  });

  it('reports a 19-commit payload as complete', async () => {
    const commits = Array.from({ length: 19 }, (_unused, index) => ({
      added: [`images/${index}.png`],
      modified: [],
      removed: [],
    }));

    await handlePush(pushBody({ commits }));

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

    await handlePush(body);

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

    await handlePush(body);

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

    await handlePush(body);

    expect(contentAssetsSync.mock.calls[0][0].changes.modified).toEqual(['pages/intro.md']);
  });

  it('still triggers on a push whose commits touched no files', async () => {
    await handlePush(pushBody({ commits: [] }));

    expect(contentAssetsSync).toHaveBeenCalledTimes(1);
    expect(contentAssetsSync.mock.calls[0][0].changes).toEqual({
      added: [],
      modified: [],
      removed: [],
    });
  });
});
