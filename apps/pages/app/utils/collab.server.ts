/**
 * Live collaborative editing — the page app's server half.
 *
 * The loader asks `collabEditorData` whether this editor works on the live
 * document and, if so, which room to join; the action reads the live
 * document (`fetchLiveSnapshot`), applies merged preview changes (`applyLiveOps`,
 * `setLiveCover`) and asks for an immediate checkpoint (`requestCheckpoint`).
 * All of it goes through the collab server's internal API — this app never
 * writes the live document's state itself.
 */

import type {
  CheckpointRequest,
  CollabActor,
  CollabLoaderData,
  CoverRequest,
  OpsRequest,
  OpsResponse,
  PageCoverImage,
  SnapshotResponse,
} from '@classmoji/collab';
import { prisma } from '~/utils/db.server.ts';
import {
  buildCollabLoaderData,
  collabEnv,
  collabInternalRequest,
  pageInternalPath,
  type CollabEnv,
} from '~/utils/collabEnv.server.ts';

/** The classroom flag, read defensively (absent on an older client row = off). */
export function classroomCollabEnabled(classroom: unknown): boolean {
  return Boolean(
    classroom &&
    typeof classroom === 'object' &&
    (classroom as { collab_enabled?: unknown }).collab_enabled === true
  );
}

/**
 * The env when this classroom edits pages live, else null. The ONE predicate
 * the loader and the action share, so a page the loader opened in the live
 * editor is also one whose git-writing intents the action refuses.
 */
export function liveEditingEnv(classroom: unknown): CollabEnv | null {
  if (!classroomCollabEnabled(classroom)) return null;
  return collabEnv();
}

/** The room's epoch: the collab_docs row's, or 1 before the first open. */
export async function readPageEpoch(pageId: string): Promise<number> {
  const row = await prisma.collabDoc.findUnique({
    where: { kind_doc_id: { kind: 'page', doc_id: pageId } },
    select: { epoch: true },
  });
  return row?.epoch ?? 1;
}

/** The name peers see: the user's name, else their login, else a placeholder. */
export async function readEditorName(userId: string, login?: string | null): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const name = user?.name?.trim();
  if (name) return name;
  if (login) return login;
  return 'Teacher';
}

/** The loader's `collab` payload for an editor of a live-edited page. */
export async function collabEditorData({
  env,
  pageId,
  userId,
  userLogin,
}: {
  env: CollabEnv;
  pageId: string;
  userId: string;
  userLogin?: string | null;
}): Promise<CollabLoaderData> {
  const [epoch, name] = await Promise.all([
    readPageEpoch(pageId),
    readEditorName(userId, userLogin),
  ]);
  return buildCollabLoaderData({ env, pageId, epoch, user: { id: userId, name } });
}

// ─── Internal API calls ──────────────────────────────────────────────────────

/** The live document (read from a clone on the server): blocks + cover. */
export function fetchLiveSnapshot(env: CollabEnv, pageId: string) {
  return collabInternalRequest<SnapshotResponse<'page'>>(
    env,
    'GET',
    pageInternalPath(pageId, 'snapshot')
  );
}

/** Apply id-aware block ops to the live document as `actor`. */
export function applyLiveOps(env: CollabEnv, pageId: string, ops: unknown[], actor: CollabActor) {
  const body: OpsRequest = { ops, actor };
  return collabInternalRequest<OpsResponse>(env, 'POST', pageInternalPath(pageId, 'ops'), body);
}

/** Set (or clear) the live document's cover. */
export function setLiveCover(
  env: CollabEnv,
  pageId: string,
  coverImage: PageCoverImage | null,
  actor: CollabActor
) {
  const body: CoverRequest = { coverImage, actor };
  return collabInternalRequest<unknown>(env, 'POST', pageInternalPath(pageId, 'cover'), body);
}

/** "Save version": ask for a checkpoint now. */
export function requestCheckpoint(env: CollabEnv, pageId: string, actor: CollabActor) {
  const body: CheckpointRequest = { actor };
  return collabInternalRequest<unknown>(env, 'POST', pageInternalPath(pageId, 'checkpoint'), body);
}
