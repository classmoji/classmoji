import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Tasks from '@classmoji/tasks';
import getPrisma from '@classmoji/database';
import { CLASSMOJI_BOT_EMAIL, ClassmojiService } from '@classmoji/services';
import { scopeGitlabId } from '@classmoji/utils';

/**
 * GitLab webhooks: the counterpart of routes/github.ts for GitLab classrooms.
 *
 * Classmoji registers a project hook on each student project after creating it
 * (group hooks need a paid plan on gitlab.com), with a token derived for its
 * instance from GITLAB_WEBHOOK_SECRET (gitlabInstance.webhookSecret). GitLab
 * sends that token back in `X-Gitlab-Token`.
 *
 * Two events matter, each handled by the same task its Github counterpart uses:
 *  - Push Hook: a push to a student project's default branch is a REPO-mode
 *    submission. The hook is registered after the template setup pushes, so
 *    those never arrive here. A push to a classroom's content project
 *    refreshes its asset map instead.
 *  - Issue Hook: closing an ISSUE-mode assignment's issue submits it, and
 *    reopening un-submits. The issue's global id is the submission row's
 *    provider id. GitLab sends no event when an issue is deleted.
 *
 * The secret is read per request: an unconfigured deployment answers 503 on
 * this path instead of failing to boot and taking the other webhooks down.
 *
 * Every instance's hooks share one URL. Project and issue ids are only unique
 * per instance, so the instance is read from the payload's project URL (the
 * payload is trusted once the secret token matched) and ids are scoped by it
 * before any lookup. `/gitlab/:instanceId` still names the instance for hooks
 * registered with it in the path.
 */

interface GitLabPushPayload {
  object_kind?: string;
  ref?: string;
  before?: string;
  after?: string;
  total_commits_count?: number;
  commits?: Array<{
    added?: string[];
    modified?: string[];
    removed?: string[];
    author?: { email?: string };
  }>;
  project?: {
    id?: number;
    default_branch?: string;
    path_with_namespace?: string;
    web_url?: string;
  };
}

/** Gitlab lists at most 20 commits in a push payload, like Github. */
const GITLAB_COMMIT_CAP = 20;

/** One net change set for a push, the last word on each path winning. */
function aggregateChanges(commits: NonNullable<GitLabPushPayload['commits']>) {
  const statuses = new Map<string, 'added' | 'modified' | 'removed'>();
  for (const commit of commits) {
    for (const path of commit.added ?? []) statuses.set(path, 'added');
    for (const path of commit.modified ?? []) statuses.set(path, 'modified');
    for (const path of commit.removed ?? []) statuses.set(path, 'removed');
  }
  const changes = { added: [] as string[], modified: [] as string[], removed: [] as string[] };
  for (const [path, status] of statuses) changes[status].push(path);
  return changes;
}

interface GitLabIssuePayload {
  object_kind?: string;
  object_attributes?: { id?: number; action?: string; closed_at?: string | null };
  project?: { web_url?: string };
}

/**
 * The instance an event came from, by its project's host: null for the default
 * instance, undefined for a GitLab Classmoji doesn't know (ignored).
 */
async function instanceFromPayload(webUrl: string | undefined): Promise<string | null | undefined> {
  if (!webUrl) return null;
  const svc = ClassmojiService.gitlabInstance;
  let host: string | null;
  try {
    host = svc.normalizeHost(new URL(webUrl).origin);
  } catch {
    return undefined;
  }
  if (!host) return undefined;
  if (host === svc.defaultHost()) return null;
  const found = await svc.findByHost(host);
  // A pending instance has no classrooms; nothing from it is trusted.
  if (!found || found.pending) return undefined;
  return found.id ?? undefined;
}

/** A deleted branch reports an all-zero `after`. */
const NULL_SHA = /^0+$/;

function tokenMatches(received: unknown, expected: string): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handlePush(data: GitLabPushPayload, instanceId: string | null): Promise<void> {
  const projectId = data.project?.id;
  const defaultBranch = data.project?.default_branch;
  if (projectId == null || !defaultBranch) return;
  if (data.ref !== `refs/heads/${defaultBranch}`) return;
  const deleted = !data.after || NULL_SHA.test(data.after);
  // Classmoji's own commits (the autograding CI file) are never a student
  // submitting; GitHub skips its bot's pushes the same way.
  const pushCommits = data.commits ?? [];
  const onlyClassmoji =
    pushCommits.length > 0 && pushCommits.every(c => c.author?.email === CLASSMOJI_BOT_EMAIL);

  if (!deleted && !onlyClassmoji) {
    const gitRepo = await getPrisma().gitRepo.findUnique({
      where: {
        provider_provider_id: {
          provider: 'GITLAB',
          provider_id: scopeGitlabId(instanceId, projectId),
        },
      },
      select: { id: true },
    });
    if (gitRepo) {
      await Tasks.repositoryPushHandlerTask.trigger(
        // GitLab's payload has no server push time; the task looks the push
        // up by its commit (GitLab's events API) and falls back to this.
        { gitRepoId: gitRepo.id, pushedAt: new Date().toISOString(), sha: data.after },
        // One submission update per student repo at a time, in delivery order.
        { concurrencyKey: gitRepo.id }
      );
      return;
    }
  }

  // Otherwise it may be a classroom's content project, which lives in the
  // class subgroup (`<class subgroup>/<content_repo>`; older ones at the group
  // root, until moved).
  const fullPath = data.project?.path_with_namespace;
  if (!fullPath || !fullPath.includes('/')) return;
  const group = fullPath.slice(0, fullPath.lastIndexOf('/'));
  const repo = fullPath.slice(fullPath.lastIndexOf('/') + 1);
  const classroom = await getPrisma().classroom.findFirst({
    where: {
      content_repo: repo,
      git_organization: { provider: 'GITLAB', gitlab_instance_id: instanceId },
      OR: [{ git_namespace: group }, { git_organization: { login: group } }],
    },
    select: { id: true },
  });
  if (!classroom) return;

  const commits = data.commits ?? [];
  const total = data.total_commits_count ?? commits.length;
  await Tasks.contentAssetsSyncTask.trigger(
    {
      classroomId: classroom.id,
      reason: 'push' as const,
      changes: aggregateChanges(commits),
      // Gitlab does not flag force-pushes; `before` not matching the map's
      // recorded commit is what exposes one, and the task re-reads the tree.
      forced: false,
      complete: total < GITLAB_COMMIT_CAP && commits.length === total,
      before: data.before,
      after: data.after,
    },
    { concurrencyKey: classroom.id }
  );
}

/** GitLab's timestamps look like "2026-09-26 02:10:04 UTC"; normalise to ISO. */
function toIso(value: string | null | undefined): string {
  const parsed = value ? new Date(value.replace(' UTC', 'Z').replace(' ', 'T')) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toISOString()
    : new Date().toISOString();
}

async function handleIssue(data: GitLabIssuePayload, instanceId: string | null): Promise<void> {
  const attrs = data.object_attributes;
  const action = attrs?.action;
  if (attrs?.id == null || (action !== 'close' && action !== 'reopen')) return;

  // Only issues Classmoji opened for an ISSUE-mode assignment are ours.
  const issueId = scopeGitlabId(instanceId, attrs.id);
  const row = await getPrisma().gitRepoAssignment.findUnique({
    where: { provider_provider_id: { provider: 'GITLAB', provider_id: issueId } },
    select: { id: true },
  });
  if (!row) return;

  const payload = {
    provider: 'GITLAB' as const,
    issue: { id: issueId, closed_at: action === 'close' ? toIso(attrs.closed_at) : null },
  };
  if (action === 'close') {
    await Tasks.repositoryAssignmentClosedHandlerTask.trigger(payload);
  } else {
    await Tasks.repositoryAssignmentReopenedHandlerTask.trigger(payload);
  }
}

const INSTANCE_ID = /^[0-9a-f-]{36}$/i;

export default async function gitlabRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { instanceId?: string } }>('/gitlab/:instanceId?', {
    preHandler: async function handler(request: FastifyRequest, reply: FastifyReply) {
      if (!process.env.GITLAB_WEBHOOK_SECRET) {
        request.log.warn('GITLAB_WEBHOOK_SECRET is not set; refusing GitLab webhook');
        reply.status(503).send('GitLab webhooks are not configured');
        return;
      }
    },
    handler: async function handler(request, reply) {
      const fromPath = (request.params as { instanceId?: string }).instanceId;
      if (fromPath !== undefined && !INSTANCE_ID.test(fromPath)) {
        return reply.status(404).send('Unknown Gitlab instance');
      }
      const body = request.body as { project?: { web_url?: string } };
      const instanceId = fromPath ?? (await instanceFromPayload(body?.project?.web_url));
      // A GitLab Classmoji has no instance for: nothing here can be ours.
      if (instanceId === undefined) return reply.status(200).send({ success: true });
      // Each instance's hooks carry that instance's own token, so an event
      // claiming to come from one Gitlab must carry that Gitlab's token: one
      // instance can't speak for another.
      const expected = ClassmojiService.gitlabInstance.webhookSecret(instanceId);
      const received = request.headers['x-gitlab-token'];
      if (!expected || !tokenMatches(received, expected)) {
        // Hooks made before per-instance tokens carry the shared secret until
        // the webhook repair rewrites them. Accepted only while
        // GITLAB_LEGACY_WEBHOOK_SECRET_UNTIL (an ISO date) is in the future:
        // set it for the rollout, run the repair, and let it lapse.
        const until = Date.parse(process.env.GITLAB_LEGACY_WEBHOOK_SECRET_UNTIL ?? '');
        const legacy = process.env.GITLAB_WEBHOOK_SECRET;
        if (!(until > Date.now() && legacy && tokenMatches(received, legacy))) {
          return reply.status(401).send('Unauthorized');
        }
        request.log.warn({ instanceId }, 'Gitlab webhook with the legacy shared secret');
      }
      const event = request.headers['x-gitlab-event'];
      if (event === 'Push Hook') {
        await handlePush(request.body as GitLabPushPayload, instanceId);
      } else if (event === 'Issue Hook') {
        await handleIssue(request.body as GitLabIssuePayload, instanceId);
      }
      return reply.status(200).send({ success: true });
    },
  });
}
