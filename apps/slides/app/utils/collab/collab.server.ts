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
  applyDeckOps,
  discardDeckPreview,
  merge3Units,
  parseDeckHtml,
  previewBranchName,
  resolveSlideRepoContext,
  slideService,
  type DeckJson,
  type DeckOp,
  type MergeChoice,
} from '@classmoji/services/slides';
import {
  deckOpsBetween,
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
  | { ok: true; applied: number; conflicts: number }
  | { ok: false; status: number; error: string };

/**
 * Accept a deck preview into the LIVE deck: 3-way merge (base = where the
 * preview branched, ours = the live deck, theirs = the preview; a slide both
 * sides changed takes the preview — that is what the reviewer accepted), then
 * the difference applied as id-aware ops through the collab server, so people
 * editing other slides keep their work. The branch is deleted once applied.
 */
export async function acceptDeckPreviewLive({
  env,
  slide,
  actor,
}: {
  env: CollabEnv;
  slide: SlideTarget;
  actor: CollabActor;
}): Promise<LiveAcceptResult> {
  const { theirs, base } = await readPreviewDecks(slide);
  if (!theirs) return { ok: false, status: 404, error: 'No pending preview to accept' };

  const live = await fetchLiveDeck(env, slide.id);
  const ours = live.content;
  const first = merge3Units(base ?? ours, ours, theirs);
  let merged = first.merged;
  if (first.conflicts.length > 0) {
    const resolutions: Record<string, MergeChoice> = {};
    for (const conflict of first.conflicts) resolutions[conflict.id] = 'theirs';
    merged = merge3Units(base ?? ours, ours, theirs, { resolutions }).merged;
  }

  const ops = deckOpsBetween(ours, merged, {
    verify: (deck, plan) =>
      applyDeckOps(deck, plan, { starterCustomCss: slideService.STARTER_CUSTOM_CSS }).deck,
  });
  if (!ops) {
    return {
      ok: false,
      status: 422,
      error:
        "This preview can't be merged into the live deck. Discard it and ask for the change again.",
    };
  }

  if (ops.length > 0) {
    try {
      await applyLiveDeckOps(env, slide.id, ops, actor);
    } catch (error) {
      if (error instanceof CollabRequestError && error.status === 409) {
        const body = error.body as Partial<SlideLockedError> | null;
        const who = body?.holder?.name ?? 'Someone';
        return {
          ok: false,
          status: 409,
          error: `${who} is editing a slide this preview changes. Accept it once they are done.`,
        };
      }
      if (error instanceof CollabRequestError && error.status === 422) {
        return {
          ok: false,
          status: 409,
          error: 'The deck changed while accepting. Try again.',
        };
      }
      throw error;
    }
  }
  await discardDeckPreview(slide as never);
  return { ok: true, applied: ops.length, conflicts: first.conflicts.length };
}

/**
 * Slides the preview adds or changes compared with the live deck (or main),
 * for the preview view's highlight. Best effort: an unreachable collab server
 * falls back to `fallback` (main's deck).
 */
export async function previewChangedSlides({
  env,
  slideId,
  preview,
  fallback,
}: {
  env: CollabEnv | null;
  slideId: string;
  preview: DeckJson;
  fallback: DeckJson | null;
}): Promise<string[]> {
  let reference: DeckJson | null = fallback;
  if (env) {
    try {
      reference = (await fetchLiveDeck(env, slideId)).content;
    } catch (error) {
      console.warn('[slides] live deck unavailable for the preview highlight:', error);
    }
  }
  return reference ? changedSlideIds(reference, preview) : [];
}
