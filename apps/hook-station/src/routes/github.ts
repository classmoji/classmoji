import { Webhooks } from '@octokit/webhooks';
import type { WebhookEvent } from '@octokit/webhooks-types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Tasks from '@classmoji/tasks';
import getPrisma from '@classmoji/database';

const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
if (!githubWebhookSecret) {
  throw new Error('GITHUB_WEBHOOK_SECRET is required');
}

const webhooks = new Webhooks({
  secret: githubWebhookSecret,
});

/**
 * Handlers keyed `${X-GitHub-Event}.${action}`.
 *
 * `action` alone does not identify a webhook: GitHub reuses the same words
 * across unrelated events. `created` is sent for an installation, a repository,
 * a project card, an issue comment and more; `deleted` likewise. Dispatching on
 * it alone made this router's job to *guess* which event it was looking at from
 * the payload's shape — and one wrong guess writes or clears an org's GitHub
 * App installation id. The event name is in the header; use it.
 *
 * The payload guards that remain answer a different question — "does this
 * delivery carry the object the task needs" — and are not a substitute for the
 * event name.
 *
 * Every Trigger.dev run is billed, and the App is installed on organizations
 * that never made a classroom, or made one and moved on. GitHub keeps sending
 * their events regardless: every issue closed in any of their repos, every
 * member they add. So each handler that can decide from the database whether
 * the payload is ours does so HERE, with one indexed read, and triggers
 * nothing when it is not. The tasks repeat the same lookup as a second line
 * of defense; the point of doing it here first is that a miss costs a query
 * instead of a run.
 */

/** The GitRepoAssignment row an ISSUE-mode issue submits through, if any. */
async function isTrackedIssue(data: WebhookEvent): Promise<boolean> {
  if (!('issue' in data) || !data.issue) return false;
  const row = await getPrisma().gitRepoAssignment.findUnique({
    where: { provider_provider_id: { provider: 'GITHUB', provider_id: String(data.issue.id) } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Whether the organization in the payload has at least one classroom.
 *
 * A GitOrganization row alone is not enough: installing the App creates one,
 * and plenty of orgs stop there. The member-added task activates the joiner's
 * classroom memberships on this org, so with no classroom it has nothing to
 * do; gating on the classroom, through the org's provider id in one joined
 * read, is what turns those installs' joiners into a query instead of a run.
 */
async function isTrackedOrganization(data: WebhookEvent): Promise<boolean> {
  if (!('organization' in data) || !data.organization) return false;
  const row = await getPrisma().classroom.findFirst({
    where: {
      git_organization: { provider: 'GITHUB', provider_id: String(data.organization.id) },
    },
    select: { id: true },
  });
  return row !== null;
}

const githubWebhookHandlers: Record<string, (data: WebhookEvent) => Promise<void>> = {
  // ISSUE-mode submissions: the issue id is the GitRepoAssignment's provider
  // id. Any other issue in the org (a REPO-mode student repo, a content repo,
  // a repo that has nothing to do with Classmoji) is not ours.
  'issues.closed': async (data: WebhookEvent) => {
    if ('issue' in data && data.issue && (await isTrackedIssue(data))) {
      await Tasks.repositoryAssignmentClosedHandlerTask.trigger(data);
    }
  },

  'issues.reopened': async (data: WebhookEvent) => {
    if ('issue' in data && data.issue && (await isTrackedIssue(data))) {
      await Tasks.repositoryAssignmentReopenedHandlerTask.trigger(data);
    }
  },

  'issues.deleted': async (data: WebhookEvent) => {
    if ('issue' in data && data.issue && (await isTrackedIssue(data))) {
      await Tasks.repositoryAssignmentDeletedHandlerTask.trigger(data);
    }
  },

  // A brand-new member of a GitHub org that has a classroom. An org that
  // installed the App and never created one has joiners with nothing to
  // activate.
  'organization.member_added': async (data: WebhookEvent) => {
    if (await isTrackedOrganization(data)) {
      await Tasks.memberAddedHandlerTask.trigger(
        data as unknown as Parameters<typeof Tasks.memberAddedHandlerTask.trigger>[0]
      );
    }
  },

  'installation.created': async (data: WebhookEvent) => {
    if ('installation' in data && data.installation) {
      await Tasks.newInstallationHandlerTask.trigger(
        data as unknown as Parameters<typeof Tasks.newInstallationHandlerTask.trigger>[0]
      );
    }
  },

  'installation.deleted': async (data: WebhookEvent) => {
    if ('installation' in data && data.installation) {
      await Tasks.appUninstalledHandlerTask.trigger(
        data as unknown as Parameters<typeof Tasks.appUninstalledHandlerTask.trigger>[0]
      );
    }
  },

  // A suspended installation still exists but mints no tokens, so the org has
  // to stop claiming it is connected — and `unsuspend` has to put the id back,
  // or a suspend/unsuspend round trip silently leaves the org disconnected
  // forever with nothing in the log to say why.
  'installation.suspend': async (data: WebhookEvent) => {
    if ('installation' in data && data.installation) {
      await Tasks.appSuspendedHandlerTask.trigger(
        data as unknown as Parameters<typeof Tasks.appSuspendedHandlerTask.trigger>[0]
      );
    }
  },

  'installation.unsuspend': async (data: WebhookEvent) => {
    if ('installation' in data && data.installation) {
      await Tasks.appUnsuspendedHandlerTask.trigger(
        data as unknown as Parameters<typeof Tasks.appUnsuspendedHandlerTask.trigger>[0]
      );
    }
  },
};

/**
 * GitHub caps a push payload's `commits[]` at 20, silently.
 *
 * A push of 20 or more commits therefore has a diff we cannot see the whole
 * of, and applying the visible part would leave the map holding rows for paths
 * the invisible commits changed or deleted. That case escalates to a full
 * re-read on the task side; `complete` is how it gets told.
 */
const GITHUB_COMMIT_CAP = 20;

interface PushCommit {
  added?: string[];
  modified?: string[];
  removed?: string[];
}

interface PushEventPayload {
  ref?: string;
  forced?: boolean;
  /** True when the push deleted the ref (then `after` is all zeros). */
  deleted?: boolean;
  /** The commit the branch pointed at BEFORE this push. */
  before?: string;
  /** The commit it points at now. */
  after?: string;
  commits?: PushCommit[];
  repository?: {
    /** GitHub's numeric repository id; GitRepo.provider_id holds it as a string. */
    id?: number | string;
    name?: string;
    default_branch?: string;
    owner?: { login?: string; name?: string };
  };
  sender?: { login?: string; type?: string };
}

type PathStatus = 'added' | 'modified' | 'removed';

/**
 * Flatten a push's commits into one net change set.
 *
 * The commits arrive oldest-first, and a single push routinely touches the
 * same path more than once — a file added in one commit and deleted in the
 * next, or written repeatedly. Only the LAST word on a path describes the tree
 * the push actually left behind, so later commits overwrite earlier ones. A
 * path added and then removed in the same push comes out as `removed`, which
 * is the state of the repo now.
 */
function aggregateChanges(commits: PushCommit[]): {
  added: string[];
  modified: string[];
  removed: string[];
} {
  const statuses = new Map<string, PathStatus>();

  for (const commit of commits) {
    for (const path of commit.added ?? []) statuses.set(path, 'added');
    for (const path of commit.modified ?? []) statuses.set(path, 'modified');
    for (const path of commit.removed ?? []) statuses.set(path, 'removed');
  }

  const changes = { added: [] as string[], modified: [] as string[], removed: [] as string[] };
  for (const [path, status] of statuses) {
    changes[status].push(path);
  }

  return changes;
}

/**
 * A push is two things, checked in the order they are likely.
 *
 * To a STUDENT repo (the overwhelming majority of pushes the App sees) it is
 * the submission for every published REPO-mode assignment that submits
 * through that repo. The time recorded is the delivery time, never the
 * commit's own timestamp, which is the author's clock and trivially
 * back-dated. Branch deletions and pushes by bots are ignored: Classmoji's
 * own autograde workflow commits to every student repo whenever tests change,
 * and those must not count as anyone submitting.
 *
 * To a classroom's CONTENT repo it refreshes that classroom's asset map. No
 * classroom simply means "not ours to care about", never an error.
 *
 * Only the repo's DEFAULT branch counts for either: pages render from it, and
 * a feature branch is not a submission until it lands.
 */
async function handlePush(data: PushEventPayload): Promise<void> {
  const repo = data.repository?.name;
  const owner = data.repository?.owner?.login;
  const defaultBranch = data.repository?.default_branch;

  if (!repo || !owner || !defaultBranch) return;
  if (data.ref !== `refs/heads/${defaultBranch}`) return;

  // A branch deletion is not a submission (the content sync below still wants
  // to hear about it, since it tracks the branch's state).
  const providerRepoId = data.repository?.id;
  if (providerRepoId != null && !data.deleted && data.sender?.type !== 'Bot') {
    const gitRepo = await getPrisma().gitRepo.findUnique({
      where: { provider_provider_id: { provider: 'GITHUB', provider_id: String(providerRepoId) } },
      select: { id: true },
    });
    if (gitRepo) {
      await Tasks.repositoryPushHandlerTask.trigger(
        { gitRepoId: gitRepo.id, pushedAt: new Date().toISOString() },
        // One submission update per student repo at a time, in delivery order.
        { concurrencyKey: gitRepo.id }
      );
      return;
    }
  }

  const classroom = await getPrisma().classroom.findFirst({
    where: { content_repo: repo, git_organization: { login: owner } },
    select: { id: true },
  });

  if (!classroom) return;

  const commits = data.commits ?? [];

  await Tasks.contentAssetsSyncTask.trigger(
    {
      classroomId: classroom.id,
      reason: 'push' as const,
      changes: aggregateChanges(commits),
      // A force-push rewrites history, so the commits listed are not a diff
      // against what we last synced and cannot be applied incrementally.
      forced: Boolean(data.forced),
      complete: commits.length < GITHUB_COMMIT_CAP,
      // The commits this push spans. `before` is the only way the sync can tell
      // that an EARLIER delivery went missing: a push whose parent is not the
      // commit the map is level with proves the repo moved unseen, and that run
      // has to re-read the whole tree rather than apply a diff against a state
      // nobody holds. `after` is what the map records once it has.
      before: data.before,
      after: data.after,
    },
    {
      // One sync per classroom at a time. Two deliveries for one repo applied
      // concurrently can record their commits in either order, moving the map's
      // recorded commit backwards and hiding the gap `before` exists to expose.
      concurrencyKey: classroom.id,
    }
  );
}

export default async function githubRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/github', {
    config: { rawBody: true },
    preHandler: async function handler(request: FastifyRequest, reply: FastifyReply) {
      const signature = request.headers['x-hub-signature-256'];
      if (typeof signature !== 'string') {
        reply.status(401).send('Unauthorized');
        return;
      }

      const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;
      if (typeof rawBody !== 'string') {
        reply.status(401).send('Unauthorized');
        return;
      }

      if (!(await webhooks.verify(rawBody, signature))) {
        reply.status(401).send('Unauthorized');
        return;
      }
    },
    handler: async function handler(request: FastifyRequest, reply: FastifyReply) {
      const data = request.body as WebhookEvent;
      const event = request.headers['x-github-event'];

      // `push` has no `action` field, so the handler map below can never see
      // it — the event name lives in the header instead.
      if (event === 'push') {
        await handlePush(data as PushEventPayload);
        return reply.status(200).send({ success: true });
      }

      const action = 'action' in data ? data.action : undefined;
      const handler =
        typeof event === 'string' && action
          ? githubWebhookHandlers[`${event}.${action}`]
          : undefined;

      if (handler) {
        await handler(data);
      }

      return reply.status(200).send({ success: true });
    },
  });
}
