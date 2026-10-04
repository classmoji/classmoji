/**
 * Live collaborative editing — the slides app's server half.
 *
 * The loader asks `deckCollabData` whether this editor works on the live deck
 * and which room to join; the action asks for a checkpoint ("Save version")
 * and applies an accepted preview to the live deck. Everything goes through
 * the collab server's internal API: this app never writes a live deck's
 * state itself, and in live mode it never writes deck.json either — the git
 * worker does.
 */
import getPrisma from '@classmoji/database';
import { ContentService } from '@classmoji/content';
import {
  discardDeckPreview,
  parseDeckHtml,
  previewBranchName,
  resolveSlideRepoContext,
  type DeckJson,
  type DeckMergeConflict,
  type DeckOp,
  type MergeResolution,
} from '@classmoji/services/slides';
import {
  type CheckpointRequest,
  type CollabActor,
  type CollabLoaderData,
  type OpsRequest,
  type OpsResponse,
  type SlideLockedError,
  type SnapshotResponse,
} from '@classmoji/collab';

import {
  CollabRequestError,
  buildDeckCollabLoaderData,
  collabEnv,
  collabInternalRequest,
  deckInternalPath,
  type CollabEnv,
} from './env.server.ts';
import { changedSlideIds } from './previewHighlight.ts';

/** The classroom flag, read defensively (absent on an older row = off). */
export function classroomCollabEnabled(classroom: unknown): boolean {
  return Boolean(
    classroom &&
    typeof classroom === 'object' &&
    (classroom as { collab_enabled?: unknown }).collab_enabled === true
  );
}

/**
 * The env when this classroom edits decks live, else null. The ONE predicate
 * the loader and the action share, so a deck the loader opened live is also
 * one whose git-writing save intents the action refuses.
 */
export function liveEditingEnv(classroom: unknown): CollabEnv | null {
  if (!classroomCollabEnabled(classroom)) return null;
  return collabEnv();
}

export async function readDeckEpoch(slideId: string): Promise<number> {
  const row = await getPrisma().collabDoc.findUnique({
    where: { kind_doc_id: { kind: 'deck', doc_id: slideId } },
    select: { epoch: true },
  });
  return row?.epoch ?? 1;
}

/** The name peers see: the user's name, else a placeholder. */
export async function readEditorName(userId: string): Promise<string> {
  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { name: true },
  });
  return user?.name?.trim() || 'Teacher';
}

export async function deckCollabData({
  env,
  slideId,
  userId,
}: {
  env: CollabEnv;
  slideId: string;
  userId: string;
}): Promise<CollabLoaderData> {
  const [epoch, name] = await Promise.all([readDeckEpoch(slideId), readEditorName(userId)]);
  return buildDeckCollabLoaderData({ env, slideId, epoch, user: { id: userId, name } });
}

// ─── Internal API calls ──────────────────────────────────────────────────────

export function fetchLiveDeck(env: CollabEnv, slideId: string) {
  return collabInternalRequest<SnapshotResponse<'deck'>>(
    env,
    'GET',
    deckInternalPath(slideId, 'snapshot')
  );
}

export function applyLiveDeckOps(
  env: CollabEnv,
  slideId: string,
  ops: DeckOp[],
  actor: CollabActor
) {
  const body: OpsRequest<DeckOp> = { ops, actor };
  return collabInternalRequest<OpsResponse>(env, 'POST', deckInternalPath(slideId, 'ops'), body);
}

export function requestDeckCheckpoint(env: CollabEnv, slideId: string, actor: CollabActor) {
  const body: CheckpointRequest = { actor };
  return collabInternalRequest<unknown>(env, 'POST', deckInternalPath(slideId, 'checkpoint'), body);
}

// ─── Preview accept, live ────────────────────────────────────────────────────

type SlideTarget = Parameters<typeof resolveSlideRepoContext>[0] & { id: string; title: string };

function parseDeckFile(content: string | null | undefined): DeckJson | null {
  if (!content) return null;
  try {
    const deck = JSON.parse(content) as DeckJson;
    if (deck?.version === 1 && Array.isArray(deck.slides)) return deck;
  } catch {
    // fall through to the legacy parser
  }
  try {
    return parseDeckHtml(content).deck;
  } catch {
    return null;
  }
}

/** The preview branch's deck and its merge base with main (null when unreadable). */
async function readPreviewDecks(slide: SlideTarget) {
  const { gitOrganization, repo } = resolveSlideRepoContext(slide);
  const branch = previewBranchName(slide.content_path);
  const deckPath = `${slide.content_path}/deck.json`;
  const comparison = await ContentService.compareBranches({
    gitOrganization,
    repo,
    base: 'main',
    head: branch,
  });
  const [theirs, base] = await Promise.all([
    ContentService.getContent({ gitOrganization, repo, path: deckPath, ref: branch }),
    comparison?.merge_base_sha
      ? ContentService.getContent({
          gitOrganization,
          repo,
          path: deckPath,
          ref: comparison.merge_base_sha,
        })
      : Promise.resolve(null),
  ]);
  return { theirs: parseDeckFile(theirs?.content), base: parseDeckFile(base?.content) };
}

export type LiveAcceptResult =
  | { ok: true }
  | { ok: false; conflicts: DeckMergeConflict[] }
  | { ok: false; status: number; error: string };

/**
 * Accept a deck preview into the LIVE deck. The collab server runs the 3-way
 * merge inside the live transaction (base = where the preview branched,
 * ours = the live deck, theirs = the preview), so people editing other slides
 * keep their work. Conflicts come back unapplied for the chooser; the chooser
 * re-submits with `resolutions`. The branch is deleted only once applied.
 */
export async function acceptDeckPreviewLive({
  env,
  slide,
  actor,
  resolutions,
}: {
  env: CollabEnv;
  slide: SlideTarget;
  actor: CollabActor;
  resolutions?: MergeResolution[] | null;
}): Promise<LiveAcceptResult> {
  const { theirs, base } = await readPreviewDecks(slide);
  if (!theirs) return { ok: false, status: 404, error: 'No pending preview to accept' };
  if (!base) {
    return {
      ok: false,
      status: 409,
      error: "This preview can't be merged. Discard it and ask for the change again.",
    };
  }

  try {
    await collabInternalRequest<{ applied: boolean; version: number }>(
      env,
      'POST',
      deckInternalPath(slide.id, 'merge-preview'),
      { base, theirs, ...(resolutions?.length ? { resolutions } : {}), actor },
      { timeoutMs: 20_000 }
    );
  } catch (error) {
    if (error instanceof CollabRequestError && error.status === 409) {
      const body = error.body as {
        error?: string;
        conflicts?: DeckMergeConflict[];
        holder?: SlideLockedError['holder'];
      } | null;
      if (body?.error === 'conflicts' && Array.isArray(body.conflicts)) {
        return { ok: false, conflicts: body.conflicts };
      }
      if (body?.error === 'slide-locked') {
        const who = body.holder?.name ?? 'Someone';
        return {
          ok: false,
          status: 409,
          error: `${who} is editing a slide this preview changes. Merge it once they are done.`,
        };
      }
    }
    if (error instanceof CollabRequestError && error.status === 400) {
      return { ok: false, status: 400, error: 'Those choices no longer match. Merge again.' };
    }
    throw error;
  }
  await discardDeckPreview(slide as never);
  return { ok: true };
}

/**
 * Slides the preview adds or changes compared with where it branched from
 * (its merge base with main) — what the preview itself changed, not what
 * others have changed in the live deck since. For the rendered preview's
 * outline. Best effort: an unreadable base outlines nothing.
 */
export async function previewChangedSlides({
  slide,
  preview,
}: {
  slide: SlideTarget;
  preview: DeckJson;
}): Promise<string[]> {
  try {
    const { base } = await readPreviewDecks(slide);
    return base ? changedSlideIds(base, preview) : [];
  } catch (error) {
    console.warn('[slides] preview base unavailable for the highlight:', error);
    return [];
  }
}
