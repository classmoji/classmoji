/**
 * Preview branches on a live-edited page (server half).
 *
 * - `previewBaseBlocks` reads the page as it was when the preview started (its
 *   merge-base with main), which the rendered preview is compared against to
 *   highlight the changes the preview makes.
 * - `acceptPreviewLive` hands the merge-base and the preview to the collab
 *   server's `merge-preview`, which merges them into the live document
 *   atomically, then deletes the preview branch.
 *
 * Only for classrooms that edit pages live; unflagged classrooms keep the git
 * accept and get no highlighting.
 *
 * Both sides go through the page schema first, so a block written by the
 * agent without BlockNote's default props does not read as a change against
 * the same block written by the editor, which always has them.
 */

import { ContentService } from '@classmoji/services';
import { blocksToYDoc, yDocToBlocks } from '@classmoji/page-schema/server';
import type { CollabActor } from '@classmoji/collab';
import { ClassmojiService } from '~/utils/db.server.ts';
import { loadPageContent } from '~/utils/content.server.ts';
import type { PageForContent } from '~/types/pages.ts';
import type { CollabEnv } from '~/utils/collabEnv.server.ts';
import { fetchLiveSnapshot, mergePreviewLive } from '~/utils/collab.server.ts';
import {
  mergePreviewFailure,
  orderUnitPreviews,
  resolutionList,
  type MergeConflictUnit,
  type PageContentBody,
} from '~/utils/collabAccept.server.ts';

type LivePage = PageForContent & { id: string };

/**
 * Blocks as the page schema stores them (defaults filled in); raw on failure.
 *
 * Ids first, the way the collab server seeds a document: the schema mints a
 * RANDOM id for an id-less block, which could then never line up with the
 * same block in the live document (seeded with the derived id).
 */
export function normalizePageBlocks(blocks: unknown[]): unknown[] {
  const withIds = ClassmojiService.pageContent.ensureBlockIds(blocks);
  try {
    return yDocToBlocks(blocksToYDoc(withIds));
  } catch (error) {
    console.warn('[pages] Could not normalize blocks through the page schema:', error);
    return withIds;
  }
}

const asBlocks = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asCover = (value: unknown): PageContentBody['coverImage'] => {
  if (!value || typeof value !== 'object') return null;
  const { url, position } = value as { url?: unknown; position?: unknown };
  return typeof url === 'string' && url
    ? { url, position: typeof position === 'number' ? position : 50 }
    : null;
};

/** The preview branch and the commit it started from, or null when there is none. */
async function previewBranchState(page: LivePage) {
  const gitOrganization = page.classroom.git_organization;
  const repo = page.classroom.content_repo;
  if (!gitOrganization?.login || !repo) return null;
  const branch = ClassmojiService.pageContent.previewBranchName(page.content_path);
  const comparison = await ContentService.compareBranches({
    gitOrganization: gitOrganization as never,
    repo,
    base: 'main',
    head: branch,
  });
  if (!comparison) return null;
  return { branch, mergeBaseSha: comparison.merge_base_sha ?? null };
}

/** The page at `ref` in the snapshot shape, normalized; null when it has no content.json. */
async function contentAt(page: LivePage, ref: string): Promise<PageContentBody | null> {
  const read = await loadPageContent(page, { ref, skipCache: true });
  if (read.format !== 'json') return null;
  return {
    blocks: normalizePageBlocks(asBlocks(read.content)),
    coverImage: asCover(read.coverImage),
  };
}

/**
 * The page as it was when its preview started (normalized blocks and its
 * cover), or null when that cannot be read — the preview then renders
 * without highlights.
 */
export async function previewBaseContent(page: LivePage): Promise<PageContentBody | null> {
  try {
    const state = await previewBranchState(page);
    if (!state?.mergeBaseSha) return null;
    return await contentAt(page, state.mergeBaseSha);
  } catch (error) {
    console.warn('[pages] Preview merge-base unavailable for highlighting:', error);
    return null;
  }
}

export type LiveAcceptResult =
  | { merged: true; previewKept: boolean }
  | {
      merged: false;
      conflict: true;
      units: MergeConflictUnit[];
      unitPreviews: Record<string, { index: number; summary: string }> | null;
    }
  | { merged: false; conflict: false; status: number; error: string };

/**
 * Merge the page's preview branch into the live document.
 *
 * `resolutions` are the chooser's picks. The collab server matches them
 * against a fresh merge (the live document keeps moving); a conflict set that
 * changed since the report comes back as a new report.
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
  const state = await previewBranchState(page);
  if (!state) {
    return { merged: false, conflict: false, status: 400, error: 'There is no preview to merge.' };
  }
  if (!state.mergeBaseSha) {
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

  const [theirs, base] = await Promise.all([
    contentAt(page, state.branch),
    contentAt(page, state.mergeBaseSha),
  ]);
  if (!theirs) {
    return {
      merged: false,
      conflict: false,
      status: 400,
      error: 'The preview has no page content.',
    };
  }
  if (!base) {
    return {
      merged: false,
      conflict: false,
      status: 409,
      error: 'This preview can no longer be merged. Discard it and make the change again.',
    };
  }

  const picks = resolutionList(resolutions);
  try {
    await mergePreviewLive(env, page.id, {
      base,
      theirs,
      ...(picks.length > 0 ? { resolutions: picks } : {}),
      actor,
    });
  } catch (error) {
    const failure = mergePreviewFailure(error);
    if (failure.kind === 'conflict') {
      // An order conflict lists block ids; the chooser shows them as text.
      // The live page is read for blocks only it has (best effort).
      let live: unknown[] = [];
      if (failure.units.some(unit => unit.reason === 'order')) {
        try {
          const snapshot = await fetchLiveSnapshot(env, page.id, { timeoutMs: 3000 });
          live = Array.isArray(snapshot.content?.blocks) ? snapshot.content.blocks : [];
        } catch {
          live = [];
        }
      }
      return {
        merged: false,
        conflict: true,
        units: failure.units,
        unitPreviews: orderUnitPreviews(failure.units, [live, theirs.blocks, base.blocks]),
      };
    }
    return { merged: false, conflict: false, status: failure.status, error: failure.message };
  }

  // The live document has the changes. Deleting the branch is housekeeping: if
  // it fails, the accept still succeeded and the person is told the preview is
  // still there.
  try {
    await ClassmojiService.pageContent.discardPreview(
      page as unknown as Parameters<typeof ClassmojiService.pageContent.discardPreview>[0]
    );
    return { merged: true, previewKept: false };
  } catch (error) {
    console.error('[pages] Preview merged live but its branch could not be deleted:', error);
    return { merged: true, previewKept: true };
  }
}
