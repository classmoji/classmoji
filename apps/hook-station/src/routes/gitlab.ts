import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Tasks from '@classmoji/tasks';
import getPrisma from '@classmoji/database';

/**
 * GitLab webhooks: the counterpart of routes/github.ts for GitLab classrooms.
 *
 * Classmoji registers a project hook on each student project after creating it
 * (group hooks need a paid plan on gitlab.com), with GITLAB_WEBHOOK_SECRET as
 * its token. GitLab sends that token back in `X-Gitlab-Token`.
 *
 * Two events matter, each handled by the same task its Github counterpart uses:
 *  - Push Hook: a push to a student project's default branch is a REPO-mode
 *    submission. The hook is registered after the template setup pushes, so
 *    those never arrive here.
 *  - Issue Hook: closing an ISSUE-mode assignment's issue submits it, and
 *    reopening un-submits. The issue's global id is the submission row's
 *    provider id. GitLab sends no event when an issue is deleted.
 *
 * The secret is read per request: an unconfigured deployment answers 503 on
 * this path instead of failing to boot and taking the other webhooks down.
 */

interface GitLabPushPayload {
  object_kind?: string;
  ref?: string;
  after?: string;
  project?: { id?: number; default_branch?: string };
}

interface GitLabIssuePayload {
  object_kind?: string;
  object_attributes?: { id?: number; action?: string; closed_at?: string | null };
}

/** A deleted branch reports an all-zero `after`. */
const NULL_SHA = /^0+$/;

function tokenMatches(received: unknown, expected: string): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handlePush(data: GitLabPushPayload): Promise<void> {
  const projectId = data.project?.id;
  const defaultBranch = data.project?.default_branch;
  if (projectId == null || !defaultBranch) return;
  if (data.ref !== `refs/heads/${defaultBranch}`) return;
  if (!data.after || NULL_SHA.test(data.after)) return;

  const gitRepo = await getPrisma().gitRepo.findUnique({
    where: { provider_provider_id: { provider: 'GITLAB', provider_id: String(projectId) } },
    select: { id: true },
  });
  if (!gitRepo) return;

  await Tasks.repositoryPushHandlerTask.trigger(
    { gitRepoId: gitRepo.id, pushedAt: new Date().toISOString() },
    // One submission update per student repo at a time, in delivery order.
    { concurrencyKey: gitRepo.id }
  );
}

/** GitLab's timestamps look like "2026-09-26 02:10:04 UTC"; normalise to ISO. */
function toIso(value: string | null | undefined): string {
  const parsed = value ? new Date(value.replace(' UTC', 'Z').replace(' ', 'T')) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toISOString()
    : new Date().toISOString();
}

async function handleIssue(data: GitLabIssuePayload): Promise<void> {
  const attrs = data.object_attributes;
  const action = attrs?.action;
  if (attrs?.id == null || (action !== 'close' && action !== 'reopen')) return;

  // Only issues Classmoji opened for an ISSUE-mode assignment are ours.
  const row = await getPrisma().gitRepoAssignment.findUnique({
    where: { provider_provider_id: { provider: 'GITLAB', provider_id: String(attrs.id) } },
    select: { id: true },
  });
  if (!row) return;

  const payload = {
    provider: 'GITLAB' as const,
    issue: { id: attrs.id, closed_at: action === 'close' ? toIso(attrs.closed_at) : null },
  };
  if (action === 'close') {
    await Tasks.repositoryAssignmentClosedHandlerTask.trigger(payload);
  } else {
    await Tasks.repositoryAssignmentReopenedHandlerTask.trigger(payload);
  }
}

export default async function gitlabRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/gitlab', {
    preHandler: async function handler(request: FastifyRequest, reply: FastifyReply) {
      const secret = process.env.GITLAB_WEBHOOK_SECRET;
      if (!secret) {
        request.log.warn('GITLAB_WEBHOOK_SECRET is not set; refusing GitLab webhook');
        reply.status(503).send('GitLab webhooks are not configured');
        return;
      }
      if (!tokenMatches(request.headers['x-gitlab-token'], secret)) {
        reply.status(401).send('Unauthorized');
        return;
      }
    },
    handler: async function handler(request: FastifyRequest, reply: FastifyReply) {
      const event = request.headers['x-gitlab-event'];
      if (event === 'Push Hook') {
        await handlePush(request.body as GitLabPushPayload);
      } else if (event === 'Issue Hook') {
        await handleIssue(request.body as GitLabIssuePayload);
      }
      return reply.status(200).send({ success: true });
    },
  });
}
