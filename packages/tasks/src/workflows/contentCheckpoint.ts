/**
 * content-checkpoint — push a classroom's live (collaboratively edited) pages
 * and decks to its content repo. Triggered by the collab server, debounced per
 * classroom (spec "Worker trigger contract"):
 *
 *   tasks.trigger('content-checkpoint', { classroomId, reason?, editors?, message? }, {
 *     concurrencyKey: classroomId,
 *     debounce: { key: 'checkpoint:' + classroomId, delay, maxDelay, mode: 'trailing' },
 *   })
 *
 * and, while someone has a live doc of the classroom open, a warm-up at most
 * once a minute: `{ classroomId, warm: true }` with NO concurrencyKey and no
 * debounce (see `run` below and apps/collab/src/warm.ts).
 *
 * The body lives in `helpers/contentCheckpointCore.ts`; this file wires the
 * real Prisma, services, renderers and git.
 *
 * NOT in `src/index.ts`, on purpose (same as team-set-solve/apply): anything
 * in that object is pulled into every app bundle that imports
 * `@classmoji/tasks`. Trigger.dev discovers it through `dirs`, and the collab
 * server triggers it by string id.
 *
 * The renderers — `@classmoji/page-schema/server` (BlockNote's server editor,
 * React, jsdom) and the deck converter in `@classmoji/collab` — are imported
 * INSIDE the run, never at module load: Trigger.dev imports every task file to
 * index the worker, and a jsdom problem here must not stop the other tasks
 * from being indexed. The ids below are literals for the same reason (a test
 * pins them to the `@classmoji/collab` constants).
 *
 * Editors (co-author trailers) arrive in the payload: the collab server keeps,
 * per doc, who edited since the last push, and sends the whole classroom's set
 * with every trigger — a trailing debounce runs with the LAST payload.
 */

import { AbortTaskRunError, idempotencyKeys, logger, task, tasks } from '@trigger.dev/sdk';
import type * as Y from 'yjs';
import getPrisma from '@classmoji/database';
import { CLASSMOJI_BOT_EMAIL, ClassmojiService, getGitProvider } from '@classmoji/services';
import {
  prepareDeckForSave,
  recordDeckCommit,
  resolveSharedThemeUrls,
  type DeckJson,
  type DeckThemeUrls,
  type SlideContentTarget,
} from '@classmoji/services/slides'; // eslint-disable-line import/no-unresolved

import { resolveCollabEnv } from '@classmoji/collab/env'; // eslint-disable-line import/no-unresolved

import { commitFilesToRemote } from '../helpers/gitCheckpoint.ts';
import {
  runContentCheckpoint,
  type CheckpointClassroom,
  type CheckpointDeps,
  type CheckpointResultDoc,
  type CheckpointPayload,
  type CheckpointPrisma,
  type CheckpointReport,
  type CheckpointWarmReport,
  type DeckLike,
  type DeckRenderer,
  type PageRenderer,
  type PageTarget,
  warmCheckpointWorker,
} from '../helpers/contentCheckpointCore.ts';

/** = CONTENT_CHECKPOINT_TASK / CONTENT_CHECKPOINT_QUEUE in @classmoji/collab. */
export const CHECKPOINT_TASK_ID = 'content-checkpoint';
export const CHECKPOINT_QUEUE_NAME = 'content-checkpoint';
/** The outside-edit notification task (packages/tasks/src/workflows/collabExternal.ts). */
export const COLLAB_EXTERNAL_TASK_ID = 'collab-external';

const CHECKPOINT_MAX_ATTEMPTS = 3;

type PageContentTarget = Parameters<typeof ClassmojiService.pageContent.preparePageContent>[0];

async function loadPageRenderer(): Promise<PageRenderer> {
  const [schema, server] = await Promise.all([
    import('@classmoji/page-schema'), // eslint-disable-line import/no-unresolved
    import('@classmoji/page-schema/server'), // eslint-disable-line import/no-unresolved
  ]);
  return {
    fragment: schema.FRAGMENT,
    schemaVersion: schema.SCHEMA_VERSION,
    render: doc => {
      const content = server.yDocToPageContent(doc);
      return { blocks: content.blocks, coverImage: content.coverImage ?? null };
    },
  };
}

/**
 * The deck Y.Doc -> Deck converter from `@classmoji/collab`, feature-detected:
 * if it is missing, deck rows are reported and left dirty rather than failing
 * the run's pages.
 */
async function loadDeckRenderer(): Promise<DeckRenderer | null> {
  try {
    // eslint-disable-next-line import/no-unresolved
    const mod = (await import('@classmoji/collab')) as Record<string, unknown>;
    const convert = mod.yDocToDeck;
    const schemaVersion = mod.DECK_SCHEMA_VERSION;
    if (typeof convert !== 'function' || typeof schemaVersion !== 'number') return null;
    return { schemaVersion, render: convert as (doc: Y.Doc) => DeckLike };
  } catch (error) {
    logger.warn('content-checkpoint: could not load the deck converter', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function gitOrgOf(classroom: CheckpointClassroom) {
  const org = classroom.git_organization;
  if (!org?.login) throw new Error(`Classroom ${classroom.id} has no git organization`);
  return org;
}

/**
 * The content repo's URL without credentials, and the credentials apart.
 * Content lives in the org on GitHub, in the class subgroup on GitLab.
 * GitHub installation tokens authenticate as `x-access-token`, GitLab OAuth
 * tokens as `oauth2`.
 */
async function contentRemote(classroom: CheckpointClassroom) {
  const org = gitOrgOf(classroom);
  const isGitLab = org.provider === 'GITLAB';
  const owner = isGitLab && classroom.git_namespace ? classroom.git_namespace : org.login;
  let origin = 'https://github.com';
  if (isGitLab) {
    const host = (org.base_url as string | null) || ClassmojiService.gitlabInstance.defaultHost();
    await ClassmojiService.gitlabInstance.assertPublicGitlabHost(host);
    const url = new URL(host);
    origin = `${url.protocol}//${url.host}`;
  }
  // Minted per run: an installation token lasts an hour.
  const token = await getGitProvider(org as Parameters<typeof getGitProvider>[0]).getAccessToken();
  return {
    url: `${origin}/${owner}/${classroom.content_repo}.git`,
    auth: { username: isGitLab ? 'oauth2' : 'x-access-token', password: token },
  };
}

/**
 * Collab `POST /internal/checkpoint-result`: the Saved-to-GitHub signal for
 * the listed docs' live rooms. Best effort — a collab that is down or not
 * configured only means the header updates on the next snapshot instead.
 */
async function postCheckpointResult(result: {
  classroomId: string;
  docs: CheckpointResultDoc[];
}): Promise<void> {
  const env = resolveCollabEnv();
  if (!env) return;
  const response = await fetch(`${env.httpUrl}/internal/checkpoint-result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-collab-secret': env.secret },
    body: JSON.stringify(result),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`checkpoint-result answered ${response.status}`);
}

export function realCheckpointDeps(): CheckpointDeps {
  const pageContent = ClassmojiService.pageContent;
  return {
    prisma: getPrisma() as unknown as CheckpointPrisma,
    loadPageRenderer,
    loadDeckRenderer,
    preparePageContent: (page: PageTarget, blocks, options) =>
      pageContent.preparePageContent(page as unknown as PageContentTarget, blocks, options),
    recordPageFile: (page: PageTarget, path, sha, content, options) =>
      pageContent.recordPageFile(page as unknown as PageContentTarget, path, sha, content, options),
    resolveDeckThemeUrls: (slide, deck) =>
      resolveSharedThemeUrls(slide as unknown as SlideContentTarget, deck as unknown as DeckJson),
    prepareDeckForSave: (slide, deck, { themeUrls }) =>
      prepareDeckForSave(slide as unknown as SlideContentTarget, deck as unknown as DeckJson, {
        ...(themeUrls ? { themeUrls: themeUrls as DeckThemeUrls } : {}),
      }),
    recordDeckCommit: (slide, committed, written, options) =>
      recordDeckCommit(slide as unknown as SlideContentTarget, committed, written, options),
    remote: contentRemote,
    ensureContentRepo: async classroomId => {
      await ClassmojiService.page.ensureContentRepo(classroomId);
    },
    commitFiles: commitFilesToRemote,
    notifyOutsideEdit: async payload => {
      // Same key shape and concurrency as hook-station's trigger, so the same
      // outside edit seen by both (or by this run's retries) is one run.
      const idempotencyKey = await idempotencyKeys.create(
        `collab-external:${payload.kind}:${payload.docId}:${payload.before ?? ''}..${payload.sha}`,
        { scope: 'global' }
      );
      await tasks.trigger(COLLAB_EXTERNAL_TASK_ID, payload, {
        concurrencyKey: payload.classroomId,
        idempotencyKey,
        idempotencyKeyTTL: '1h',
      });
    },
    notifyCheckpointResult: postCheckpointResult,
    audit: async ({ classroomId, userId, kind, docId, commit, version, runId }) => {
      const membership = await getPrisma().classroomMembership.findFirst({
        where: { classroom_id: classroomId, user_id: userId },
        select: { role: true },
      });
      if (!membership) return;
      await ClassmojiService.audit.create({
        classroom_id: classroomId,
        user_id: userId,
        role: membership.role,
        action: 'COLLAB_CHECKPOINT',
        // = COLLAB_AUDIT_RESOURCE in @classmoji/collab (what joins and the MCP tools write).
        resource_type: kind === 'deck' ? 'SLIDES' : 'PAGES',
        resource_id: docId,
        data: { commit, version, runId },
      });
    },
    repoSizeKb: async classroom => {
      const org = classroom.git_organization;
      if (!org?.login || org.provider === 'GITLAB') return null;
      const provider = getGitProvider(org as Parameters<typeof getGitProvider>[0]) as {
        getRepositorySizeKb?: (owner: string, repo: string) => Promise<number | null>;
      };
      return (await provider.getRepositorySizeKb?.(org.login, classroom.content_repo)) ?? null;
    },
    author: { name: 'Classmoji Bot', email: CLASSMOJI_BOT_EMAIL },
    log: taskLog,
  };
}

const taskLog: CheckpointDeps['log'] = {
  info: (m, d) => logger.info(m, d),
  warn: (m, d) => logger.warn(m, d),
  error: (m, d) => logger.error(m, d),
};

/**
 * The task's body. A warm-up (`payload.warm`: collab, at most once a minute
 * per classroom while someone has a live doc open) branches off before the
 * real deps exist, so it never reaches Prisma or git. It is this same task on
 * purpose: same deployment and machine preset as the checkpoint it prepares
 * for, so the machine Trigger.dev keeps warm after it is one a checkpoint can
 * start on, and — with `processKeepAlive` (trigger.config.js) — a process
 * that already has the renderers loaded. `makeDeps` / `warmLoaders` are seams
 * for tests.
 */
export async function contentCheckpointRun(
  payload: CheckpointPayload,
  ctx: { runId: string; attemptNumber: number },
  {
    makeDeps = realCheckpointDeps,
    warmLoaders = { loadPageRenderer, loadDeckRenderer },
  }: {
    makeDeps?: () => CheckpointDeps;
    warmLoaders?: Pick<CheckpointDeps, 'loadPageRenderer' | 'loadDeckRenderer'>;
  } = {}
): Promise<CheckpointReport | CheckpointWarmReport> {
  if (payload.warm === true) {
    const report = await warmCheckpointWorker(payload, { ...warmLoaders, log: taskLog });
    taskLog.info('content-checkpoint: warm', { ...report });
    return report;
  }
  const report = await runContentCheckpoint(
    payload,
    // Save-version requests are answered with a retryable failure only on
    // the last attempt (`retry.maxAttempts` below).
    { runId: ctx.runId, finalAttempt: ctx.attemptNumber >= CHECKPOINT_MAX_ATTEMPTS },
    makeDeps()
  );
  // Everything that succeeded is committed and recorded by now; a refused
  // or failed doc still marks the run failed, so dashboards and alerts see
  // it. A refusal is deterministic (no retry); a failure may be transient.
  if (report.failure) {
    const { failure, ...rest } = report;
    logger.error('content-checkpoint: run failed', { ...rest, failure: failure.message });
    if (failure.kind === 'abort') throw new AbortTaskRunError(failure.message);
    throw failure.error instanceof Error ? failure.error : new Error(failure.message);
  }
  return report;
}

export const contentCheckpoint = task({
  id: CHECKPOINT_TASK_ID,
  /**
   * One run at a time per classroom (the trigger passes
   * `concurrencyKey: classroomId`): two runs on one classroom would race each
   * other's pushes and rows. Different classrooms run side by side.
   * Warm-ups carry no key: on this queue model the limit applies per key to
   * keyed runs and to the un-keyed runs as one pool of their own, so a
   * warm-up never holds a classroom's slot, and warm-ups run one at a time.
   */
  queue: { name: CHECKPOINT_QUEUE_NAME, concurrencyLimit: 1 },
  /**
   * Git plus a BlockNote server editor (jsdom) holding every dirty doc of a
   * classroom. Its own size (the project default is small-2x) so its warm
   * machines only take checkpoint runs: a collab warm-up keeps a machine warm
   * for the next Present/Save version instead of for an unrelated task, and
   * the renderers never sit in other tasks' kept-alive processes.
   */
  machine: 'medium-1x',
  maxDuration: 300,
  /**
   * Safe to repeat: a run re-reads the rows and pushes whatever is still
   * unpushed. A transient GitHub failure therefore retries rather than waiting
   * for the next edit to trigger another run.
   */
  retry: {
    maxAttempts: CHECKPOINT_MAX_ATTEMPTS,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 20000,
    factor: 2,
  },
  run: async (payload: CheckpointPayload, { ctx }) =>
    contentCheckpointRun(payload, {
      runId: ctx.run.id,
      attemptNumber: ctx.attempt.number,
    }),
});
