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
 * `@classmoji/tasks`, and this file imports `@classmoji/page-schema/server`
 * (BlockNote's server editor, React and jsdom). Trigger.dev discovers it
 * through `dirs`, and the collab server triggers it by string id.
 *
 * Editors (co-author trailers) arrive in the payload: the collab server keeps,
 * per doc, who edited since the last push, and sends the whole classroom's set
 * with every trigger — a trailing debounce runs with the LAST payload.
 */

import { logger, task } from '@trigger.dev/sdk';
import * as Y from 'yjs';
import getPrisma from '@classmoji/database';
import { ClassmojiService, getGitProvider } from '@classmoji/services';
import {
  prepareDeckForSave,
  recordDeckCommit,
  resolveSharedThemeUrls,
  type DeckJson,
  type DeckThemeUrls,
  type SlideContentTarget,
} from '@classmoji/services/slides'; // eslint-disable-line import/no-unresolved
import { CONTENT_CHECKPOINT_QUEUE, CONTENT_CHECKPOINT_TASK } from '@classmoji/collab'; // eslint-disable-line import/no-unresolved
import { FRAGMENT } from '@classmoji/page-schema'; // eslint-disable-line import/no-unresolved
import { yDocToPageContent } from '@classmoji/page-schema/server'; // eslint-disable-line import/no-unresolved

import { authedRemote } from '../helpers/createRepository.ts';
import { commitFilesToRemote } from '../helpers/gitCheckpoint.ts';
import {
  runContentCheckpoint,
  type CheckpointClassroom,
  type CheckpointDeps,
  type CheckpointPayload,
  type CheckpointPrisma,
  type DeckLike,
  type PageTarget,
} from '../helpers/contentCheckpointCore.ts';

type PageContentTarget = Parameters<typeof ClassmojiService.pageContent.preparePageContent>[0];

/**
 * The deck Y.Doc -> Deck converter from `@classmoji/collab` (slice D), loaded
 * lazily and feature-detected: until it exists, deck rows are reported and
 * left dirty rather than failing the run's pages.
 */
async function loadDeckRenderer(): Promise<((doc: Y.Doc) => DeckLike) | null> {
  try {
    // eslint-disable-next-line import/no-unresolved
    const mod = (await import('@classmoji/collab')) as Record<string, unknown>;
    const convert = mod.yDocToDeck;
    return typeof convert === 'function' ? (convert as (doc: Y.Doc) => DeckLike) : null;
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

/** Where the content repo lives: the org on GitHub, the class subgroup on GitLab. */
function contentRepoPath(classroom: CheckpointClassroom): string {
  const org = gitOrgOf(classroom);
  const owner =
    org.provider === 'GITLAB' && classroom.git_namespace ? classroom.git_namespace : org.login;
  return `${owner}/${classroom.content_repo}`;
}

export function realCheckpointDeps(): CheckpointDeps {
  const pageContent = ClassmojiService.pageContent;
  return {
    prisma: getPrisma() as unknown as CheckpointPrisma,
    pageFragment: FRAGMENT,
    renderPage: doc => {
      const content = yDocToPageContent(doc);
      return { blocks: content.blocks, coverImage: content.coverImage ?? null };
    },
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
    remoteUrl: async classroom => {
      const org = gitOrgOf(classroom);
      if (org.provider === 'GITLAB') {
        await ClassmojiService.gitlabInstance.assertPublicGitlabHost(
          (org.base_url as string | null) || ClassmojiService.gitlabInstance.defaultHost()
        );
      }
      // Minted per run: an installation token lasts an hour, and the URL lives
      // only in the run's temp clone.
      const token = await getGitProvider(
        org as Parameters<typeof getGitProvider>[0]
      ).getAccessToken();
      return authedRemote(
        org as Parameters<typeof authedRemote>[0],
        token,
        contentRepoPath(classroom)
      );
    },
    ensureContentRepo: async classroomId => {
      await ClassmojiService.page.ensureContentRepo(classroomId);
    },
    commitFiles: commitFilesToRemote,
    log: {
      info: (m, d) => logger.info(m, d),
      warn: (m, d) => logger.warn(m, d),
      error: (m, d) => logger.error(m, d),
    },
  };
}

export const contentCheckpoint = task({
  id: CONTENT_CHECKPOINT_TASK,
  /**
   * One run at a time per classroom (the trigger passes
   * `concurrencyKey: classroomId`): two runs on one classroom would race each
   * other's pushes and rows. Different classrooms run side by side.
   */
  queue: { name: CONTENT_CHECKPOINT_QUEUE, concurrencyLimit: 1 },
  /** Git and a BlockNote server editor; no browser. */
  machine: 'small-1x',
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
