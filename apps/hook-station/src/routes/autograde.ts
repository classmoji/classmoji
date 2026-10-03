import type { FastifyInstance } from 'fastify';
import Tasks from '@classmoji/tasks';
import { verifyAutogradeCallbackToken } from '@classmoji/services';

/**
 * Autograding results from a student repo's CI (Github Actions or Gitlab CI).
 *
 * The generated workflow posts here instead of straight to Trigger.dev, so it
 * carries no Trigger credentials at all: only its own repo's callback token,
 * checked here before anything runs. A request without a valid token for the
 * repo it names never reaches Trigger, and each repo gets a small budget so a
 * student can't turn their own workflow into a flood.
 *
 * Results stay advisory (a student can edit their own workflow), exactly as
 * before; the ingest task checks the token again.
 */

interface AutogradeBody {
  payload?: {
    classroomSlug?: string;
    repo?: string;
    sha?: string;
    run_id?: string;
    actor?: string;
    token?: string;
    results?: Record<string, { name?: string; result?: string }>;
  };
}

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const MAX_BODY_BYTES = 256 * 1024;
const recent = new Map<string, number[]>();

/** Whether this repo may report again now (sliding one-minute window). */
function withinBudget(repo: string, now = Date.now()): boolean {
  const times = (recent.get(repo) ?? []).filter(t => now - t < WINDOW_MS);
  if (times.length >= MAX_PER_WINDOW) {
    recent.set(repo, times);
    return false;
  }
  times.push(now);
  recent.set(repo, times);
  if (recent.size > 10_000) recent.clear();
  return true;
}

export default async function autogradeRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/autograde', { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
    const payload = (request.body as AutogradeBody | undefined)?.payload;
    const repo = payload?.repo;
    if (!payload?.classroomSlug || !repo || !payload.sha || !payload.results) {
      return reply.status(400).send({ error: 'missing fields' });
    }
    if (
      !verifyAutogradeCallbackToken(payload.classroomSlug, payload.token ?? null, {
        repoPath: repo,
      })
    ) {
      return reply.status(401).send({ error: 'invalid token' });
    }
    if (!withinBudget(repo.toLowerCase())) {
      return reply.status(429).send({ error: 'too many reports; try again in a minute' });
    }
    await Tasks.ingestAutogradeResultTask.trigger({
      ...payload,
      classroomSlug: payload.classroomSlug,
      repo,
      sha: payload.sha,
    });
    return reply.status(202).send({ accepted: true });
  });
}
