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

import { idempotencyKeys, logger, task, tasks } from '@trigger.dev/sdk';
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

import { commitFilesToRemote } from '../helpers/gitCheckpoint.ts';
import {
  runContentCheckpoint,
  type CheckpointClassroom,
  type CheckpointDeps,
  type CheckpointPayload,
  type CheckpointPrisma,
  type DeckLike,
  type DeckRenderer,
  type PageRenderer,
  type PageTarget,
} from '../helpers/contentCheckpointCore.ts';

/** = CONTENT_CHECKPOINT_TASK / CONTENT_CHECKPOINT_QUEUE in @classmoji/collab. */
export const CHECKPOINT_TASK_ID = 'content-checkpoint';
export const CHECKPOINT_QUEUE_NAME = 'content-checkpoint';
/** The outside-edit notification task (packages/tasks/src/workflows/collabExternal.ts). */
export const COLLAB_EXTERNAL_TASK_ID = 'collab-external';

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
    notifyOutsideEdit: async ({ classroomId, kind, docId, sha }) => {
      // Once per (doc, head) across this run's retries and later runs: the
      // same unmerged outside edit seen again is the same notification.
      const idempotencyKey = await idempotencyKeys.create(
        `collab-external:${kind}:${docId}:${sha}`,
        { scope: 'global' }
      );
      await tasks.trigger(
        COLLAB_EXTERNAL_TASK_ID,
        { classroomId, kind, docId, sha },
        { idempotencyKey, idempotencyKeyTTL: '1h' }
      );
    },
    author: { name: 'Classmoji Bot', email: CLASSMOJI_BOT_EMAIL },
    log: {
      info: (m, d) => logger.info(m, d),
      warn: (m, d) => logger.warn(m, d),
      error: (m, d) => logger.error(m, d),
    },
  };
}

export const contentCheckpoint = task({
  id: CHECKPOINT_TASK_ID,
  /**
   * One run at a time per classroom (the trigger passes
   * `concurrencyKey: classroomId`): two runs on one classroom would race each
   * other's pushes and rows. Different classrooms run side by side.
   */
  queue: { name: CHECKPOINT_QUEUE_NAME, concurrencyLimit: 1 },
  /** Git plus a BlockNote server editor (jsdom) holding every dirty doc of a classroom. */
  machine: 'small-2x',
  maxDuration: 300,
  /**
   * Safe to repeat: a run re-reads the rows and pushes whatever is still
   * unpushed. A transient GitHub failure therefore retries rather than waiting
   * for the next edit to trigger another run.
   */
  retry: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 20000, factor: 2 },
  run: async (payload: CheckpointPayload, { ctx }) => {
    return runContentCheckpoint(payload, { runId: ctx.run.id }, realCheckpointDeps());
  },
});
