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
  type CloseRequest,
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
import { checkpointFromRow } from './collab.ts';
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

/**
 * The last checkpoint covering the deck, for the header's "saved to GitHub"
 * line until the room's own messages take over. A deck with nothing unpushed
 * but no recorded run (pushed before runs were recorded, or never opened
 * live) is saved too, time unknown (`at: ''`). Null while there are unpushed
 * edits and no run on record.
 */
export async function readDeckCheckpoint(
  slideId: string
): Promise<{ at: string; commit?: string; error?: string } | null> {
  const row = await getPrisma().collabDoc.findUnique({
    where: { kind_doc_id: { kind: 'deck', doc_id: slideId } },
    select: {
      last_checkpoint_at: true,
      last_checkpoint_error: true,
      pushed_commit: true,
      version: true,
      pushed_version: true,
    },
  });
  return checkpointFromRow(row);
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

/**
 * Tell the room a preview of the deck appeared, changed or went away, so open
 * editors refresh their preview banner. Best effort: never fails the caller.
 */
export async function notifyPreviewChanged(env: CollabEnv, slideId: string): Promise<void> {
  try {
    await collabInternalRequest<unknown>(
      env,
      'POST',
      deckInternalPath(slideId, 'preview-changed'),
      {},
      { timeoutMs: 3000 }
    );
  } catch (error) {
    console.warn('[slides] Could not tell the live deck about a preview change:', error);
  }
}

/**
 * Close the live deck before it is deleted: the collab server flushes it and
 * disconnects every editor (they reload onto a deck that no longer exists).
 */
export function closeLiveDeck(env: CollabEnv, slideId: string) {
  const body: CloseRequest = { reason: 'deleted' };
  return collabInternalRequest<unknown>(env, 'POST', deckInternalPath(slideId, 'close'), body);
}

/** A Save-version request id (the collab contract's `CHECKPOINT_REQUEST_ID`). */
export const DECK_CHECKPOINT_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The `/checkpoint` reply: the doc's version after the flush; `alreadySaved`
 * when nothing was unpushed (no run, no broadcast follows).
 */
export interface DeckCheckpointReply {
  version?: number;
  requestId?: string;
  alreadySaved?: boolean;
}

export function requestDeckCheckpoint(
  env: CollabEnv,
  slideId: string,
  actor: CollabActor,
  message?: string,
  requestId?: string
): Promise<DeckCheckpointReply | null> {
  const body: CheckpointRequest & { requestId?: string } = {
    actor,
    ...(message ? { message } : {}),
    ...(requestId ? { requestId } : {}),
  };
  return collabInternalRequest<DeckCheckpointReply | null>(
    env,
    'POST',
    deckInternalPath(slideId, 'checkpoint'),
    body
  );
}

export type PresentCheckpointOutcome = 'saved' | 'timeout' | 'error' | 'not-live';

/**
 * Save before presenting: the presenter, speaker view and followers read
 * git, so a live deck's latest edits are checkpointed first. Asks collab for
 * a checkpoint (it flushes the live doc first) and waits until the deck's row
 * says that version is pushed — bounded; on `timeout` / `error` the caller
 * presents what git has. `not-live` for a classroom that does not edit live.
 */
export async function checkpointBeforePresenting(
  slide: { id: string; classroom: unknown },
  actor: CollabActor,
  { timeoutMs = 20_000, pollMs = 750 }: { timeoutMs?: number; pollMs?: number } = {}
): Promise<PresentCheckpointOutcome> {
  const env = liveEditingEnv(slide.classroom);
  if (!env) return 'not-live';
  const started = Date.now();
  let reply: DeckCheckpointReply | null;
  try {
    reply = await requestDeckCheckpoint(env, slide.id, actor);
  } catch (error) {
    console.warn(`[slides] checkpoint before presenting ${slide.id} failed:`, error);
    return 'error';
  }
  if (reply?.alreadySaved) return 'saved';
  const target = typeof reply?.version === 'number' ? reply.version : null;
  const prisma = getPrisma();
  for (;;) {
    const row = await prisma.collabDoc.findUnique({
      where: { kind_doc_id: { kind: 'deck', doc_id: slide.id } },
      select: {
        version: true,
        pushed_version: true,
        last_checkpoint_at: true,
        last_checkpoint_error: true,
      },
    });
    // Never live: git has the deck.
    if (!row) return 'saved';
    if (row.pushed_version >= (target ?? row.version)) return 'saved';
    // A run that failed meanwhile may be retried (or overtaken by the next):
    // keep waiting; only at the deadline does it say why it gave up.
    if (Date.now() + pollMs > started + timeoutMs) {
      const failed =
        row.last_checkpoint_error &&
        row.last_checkpoint_at &&
        row.last_checkpoint_at.getTime() >= started;
      return failed ? 'error' : 'timeout';
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

/**
 * Tell the deck's room its title changed (best effort): open editors show
 * it without reloading. A failure is logged, never surfaced — the rename
 * itself is saved.
 */
export async function notifyDeckMeta(
  env: CollabEnv,
  slideId: string,
  meta: { title?: string }
): Promise<void> {
  try {
    await collabInternalRequest<unknown>(
      env,
      'POST',
      deckInternalPath(slideId, 'meta-changed'),
      meta,
      { timeoutMs: 3000 }
    );
  } catch (error) {
    console.warn('[slides] Could not tell the live room about a title change:', error);
  }
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
  await notifyPreviewChanged(env, slide.id);
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
