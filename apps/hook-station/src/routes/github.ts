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
 */
const githubWebhookHandlers: Record<string, (data: WebhookEvent) => Promise<void>> = {
  // Assignment repos are tracked as issues in the classroom's org.
  'issues.closed': async (data: WebhookEvent) => {
    if ('issue' in data && data.issue) {
      await Tasks.repositoryAssignmentClosedHandlerTask.trigger(data);
    }
  },

  'issues.deleted': async (data: WebhookEvent) => {
    if ('issue' in data && data.issue) {
      await Tasks.repositoryAssignmentDeletedHandlerTask.trigger(data);
    }
  },

  // A brand-new member of a classroom's GitHub org.
  'organization.member_added': async (data: WebhookEvent) => {
    await Tasks.memberAddedHandlerTask.trigger(
      data as unknown as Parameters<typeof Tasks.memberAddedHandlerTask.trigger>[0]
    );
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
  /** The commit the branch pointed at BEFORE this push. */
  before?: string;
  /** The commit it points at now. */
  after?: string;
  commits?: PushCommit[];
  repository?: {
    name?: string;
    default_branch?: string;
    owner?: { login?: string; name?: string };
  };
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
 * A push to a classroom's CONTENT repo refreshes that classroom's asset map.
 *
 * This runs on every push the App can see, and the overwhelming majority of
 * those are student assignment repos pushing constantly — so the fast exits
 * come first, and a push that isn't a content repo costs one indexed read and
 * nothing else. No classroom simply means "not ours to care about", which is
 * the normal case and never an error.
 *
 * Only the repo's DEFAULT branch is synced: the map describes what pages
 * render from, and pages render from the default branch. A push to a feature
 * branch changes nothing anybody can see.
 */
async function handlePush(data: PushEventPayload): Promise<void> {
  const repo = data.repository?.name;
  const owner = data.repository?.owner?.login;
  const defaultBranch = data.repository?.default_branch;

  if (!repo || !owner || !defaultBranch) return;
  if (data.ref !== `refs/heads/${defaultBranch}`) return;

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
