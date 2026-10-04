/**
 * Preview branches on a live-edited page (server half).
 *
 * - `livePageBlocks` reads the page as it is NOW for the preview's change
 *   highlighting: the live document when the classroom edits live, main's
 *   content.json otherwise.
 * - `acceptPreviewLive` merges the preview into the live document through the
 *   collab server (see `collabAccept.ts` for the plan), then deletes the
 *   preview branch.
 *
 * Both sides of every comparison go through the page schema first, so a block
 * written by the agent without BlockNote's default props does not read as a
 * change against the same block in the live document, which always has them.
 */

import { ContentService } from '@classmoji/services';
import { blocksToYDoc, yDocToBlocks } from '@classmoji/page-schema/server';
import type { CollabActor } from '@classmoji/collab';
import { ClassmojiService } from '~/utils/db.server.ts';
import { loadPageContent } from '~/utils/content.server.ts';
import type { PageForContent } from '~/types/pages.ts';
import type { CollabEnv } from '~/utils/collabEnv.server.ts';
import { applyLiveOps, fetchLiveSnapshot, setLiveCover } from '~/utils/collab.server.ts';
import {
  planCollabAccept,
  resolutionMap,
  type CoverValue,
  type MergeConflictUnit,
  type MergeFn,
} from '~/utils/collabAccept.ts';

/** Blocks as the page schema stores them (defaults filled in); raw on failure. */
export function normalizePageBlocks(blocks: unknown[]): unknown[] {
  try {
    return yDocToBlocks(blocksToYDoc(blocks));
  } catch (error) {
    console.warn('[pages] Could not normalize blocks through the page schema:', error);
    return blocks;
  }
}

const asBlocks = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asCover = (value: unknown): CoverValue | null => {
  if (!value || typeof value !== 'object') return null;
  const { url, position } = value as { url?: unknown; position?: unknown };
  return typeof url === 'string' && url
    ? { url, position: typeof position === 'number' ? position : 50 }
    : null;
};

/**
 * The page's current blocks for highlighting a preview against: the live
 * document when `env` is set (falling back to main if the collab server does
 * not answer), else main's content.json. Null when neither can be read.
 */
type LivePage = PageForContent & { id: string };

export async function livePageBlocks(
  page: LivePage,
  env: CollabEnv | null
): Promise<unknown[] | null> {
  if (env) {
    try {
      const snapshot = await fetchLiveSnapshot(env, page.id);
      return asBlocks(snapshot.content?.blocks);
    } catch (error) {
      console.warn('[pages] Live snapshot unavailable for preview highlighting:', error);
    }
  }
  try {
    const main = await loadPageContent(page, { skipCache: true });
    return main.format === 'json' ? normalizePageBlocks(asBlocks(main.content)) : null;
  } catch (error) {
    console.warn('[pages] Main content unavailable for preview highlighting:', error);
    return null;
  }
}

export type LiveAcceptResult =
  | { merged: true; autoMerged: number }
  | {
      merged: false;
      conflict: true;
      units: MergeConflictUnit[];
      autoMerged: number;
      oursSha: string;
      theirsSha: string | null;
    }
  | { merged: false; conflict: false; status: number; error: string };

/**
 * Merge the page's preview branch into the live document.
 *
 * `resolutions` are the chooser's picks; they are matched against a FRESH
 * merge (the live document keeps moving), and a conflict set that changed
 * since the report comes back as a new report rather than an error.
 */
export async function acceptPreviewLive({
  page,
  env,
  actor,
  resolutions,
}: {
  page: LivePage;
  env: CollabEnv;
  actor: CollabActor;
  resolutions?: Array<{ id?: unknown; choose?: unknown }> | null;
}): Promise<LiveAcceptResult> {
  const pageContent = ClassmojiService.pageContent;
  const gitOrganization = page.classroom.git_organization;
  const repo = page.classroom.content_repo;
  if (!gitOrganization?.login || !repo) {
    return {
      merged: false,
      conflict: false,
      status: 400,
      error: 'This classroom has no content repository.',
    };
  }
  const branch = pageContent.previewBranchName(page.content_path);

  const comparison = await ContentService.compareBranches({
    gitOrganization: gitOrganization as never,
    repo,
    base: 'main',
    head: branch,
  });
  if (!comparison) {
    return { merged: false, conflict: false, status: 400, error: 'There is no preview to merge.' };
  }

  const [theirs, base, live] = await Promise.all([
    loadPageContent(page, { ref: branch, skipCache: true }),
    comparison.merge_base_sha
      ? loadPageContent(page, { ref: comparison.merge_base_sha })
      : Promise.resolve(null),
    fetchLiveSnapshot(env, page.id),
  ]);
  if (theirs.format !== 'json') {
    return {
      merged: false,
      conflict: false,
      status: 400,
      error: 'The preview has no page content.',
    };
  }

  if (base?.format !== 'json') {
    // Without the page as it was when the preview started there is no telling
    // the preview's own edits from what the live page has gained since, and
    // guessing would delete live work.
    return {
      merged: false,
      conflict: false,
      status: 409,
      error: 'This preview can no longer be merged. Discard it and make the change again.',
    };
  }

  const plan = planCollabAccept(
    {
      base: normalizePageBlocks(asBlocks(base.content)),
      ours: asBlocks(live.content?.blocks),
      theirs: normalizePageBlocks(asBlocks(theirs.content)),
      baseCover: asCover(base?.coverImage),
      oursCover: asCover(live.content?.coverImage),
      theirsCover: asCover(theirs.coverImage),
      resolutions: resolutionMap(resolutions),
    },
    pageContent.merge3Blocks as unknown as MergeFn
  );

  if (plan.kind === 'conflict') {
    return {
      merged: false,
      conflict: true,
      units: plan.units,
      autoMerged: plan.autoMerged,
      oursSha: `live:${live.version}`,
      theirsSha: theirs.sha ?? null,
    };
  }

  if (plan.ops.length > 0) await applyLiveOps(env, page.id, plan.ops, actor);
  if (plan.cover) await setLiveCover(env, page.id, plan.cover.value, actor);

  // Only after the live document took the changes: a failed apply keeps the
  // preview to try again.
  await pageContent.discardPreview(
    page as unknown as Parameters<typeof pageContent.discardPreview>[0]
  );
  return { merged: true, autoMerged: plan.autoMerged };
}
