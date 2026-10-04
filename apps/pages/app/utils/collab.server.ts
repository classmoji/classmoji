/**
 * Live collaborative editing — the page app's server half.
 *
 * The loader asks `collabEditorData` whether this editor works on the live
 * document and, if so, which room to join; the action reads the live
 * document (`fetchLiveSnapshot`), merges a preview into it (`mergePreviewLive`)
 * and asks for an immediate checkpoint (`requestCheckpoint`).
 * All of it goes through the collab server's internal API — this app never
 * writes the live document's state itself.
 */

import type {
  CheckpointRequest,
  CloseRequest,
  CollabActor,
  CollabLoaderData,
  PageSnapshotContent,
  SnapshotResponse,
} from '@classmoji/collab';
import { resolveCollabEnv } from '@classmoji/collab/env';
import { liveEditingBlocked } from '~/utils/liveGates.ts';
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

/** Whether the page has live edits not yet saved to GitHub (a dirty buffer row). */
export async function readLiveBufferDirty(pageId: string): Promise<boolean> {
  const row = await prisma.collabDoc.findUnique({
    where: { kind_doc_id: { kind: 'page', doc_id: pageId } },
    select: { version: true, pushed_version: true },
  });
  return Boolean(row && row.version > row.pushed_version);
}

/**
 * Live editing is switched on for the classroom but unreachable (no env) and
 * the page has unsaved live edits: the page stays read-only (`liveEditingBlocked`).
 */
export async function liveEditingBlockedFor(page: {
  id: string;
  classroom: unknown;
}): Promise<boolean> {
  const flagged = classroomCollabEnabled(page.classroom);
  if (!flagged || collabEnv()) return false;
  return liveEditingBlocked({
    flagged,
    envAvailable: false,
    bufferDirty: await readLiveBufferDirty(page.id),
  });
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
export function fetchLiveSnapshot(
  env: CollabEnv,
  pageId: string,
  options: { timeoutMs?: number } = {}
) {
  return collabInternalRequest<SnapshotResponse<'page'>>(
    env,
    'GET',
    pageInternalPath(pageId, 'snapshot'),
    undefined,
    options
  );
}

/**
 * Merge a preview into the live document, server-side and atomically
 * (`merge-preview`): base = the page when the preview started, theirs = the
 * preview, ours = the live document at the moment of the merge. Conflicts come
 * back as 409 `{ error: 'conflicts', conflicts }` with nothing applied.
 */
export function mergePreviewLive(
  env: CollabEnv,
  pageId: string,
  body: {
    base: PageSnapshotContent;
    theirs: PageSnapshotContent;
    resolutions?: Array<{ id: string; choose: 'ours' | 'theirs' }>;
    actor: CollabActor;
  }
) {
  return collabInternalRequest<{ applied: true; version: number }>(
    env,
    'POST',
    pageInternalPath(pageId, 'merge-preview'),
    body,
    // The merge runs inside the live transaction; give it longer than a read.
    { timeoutMs: 30_000 }
  );
}

/**
 * Tell the room the page's title or width changed (best effort): every open
 * editor applies it without reloading. A failure is logged, never surfaced —
 * the change itself is already saved.
 */
export async function notifyPageMeta(
  env: CollabEnv,
  pageId: string,
  meta: { title?: string; width?: number }
): Promise<void> {
  try {
    await collabInternalRequest<unknown>(
      env,
      'POST',
      pageInternalPath(pageId, 'meta-changed'),
      meta,
      { timeoutMs: 3000 }
    );
  } catch (error) {
    console.warn('[pages] Could not tell the live room about a title/width change:', error);
  }
}

/** "Save version": ask for a checkpoint now. */
export function requestCheckpoint(env: CollabEnv, pageId: string, actor: CollabActor) {
  const body: CheckpointRequest = { actor };
  return collabInternalRequest<unknown>(env, 'POST', pageInternalPath(pageId, 'checkpoint'), body);
}

// ─── Page delete ─────────────────────────────────────────────────────────────

/** Whether a page's live room must be closed before the page is deleted. */
export function closeBeforeDelete({
  classroomFlagged,
  hasCollabDoc,
}: {
  classroomFlagged: boolean;
  hasCollabDoc: boolean;
}): boolean {
  return classroomFlagged || hasCollabDoc;
}

/**
 * Close a page's live room before the page is deleted: the collab server
 * checkpoints what it holds, then disconnects every editor (they reload and
 * find the page gone). Needed when the classroom edits live or a buffered
 * document exists (the flag may have been turned off since).
 *
 * `ok: false` means the room could not be closed — the delete should wait,
 * or a buffered document could be pushed back after the page is gone. A 404
 * (no such room or document on the server) is fine.
 */
export async function closeLivePageForDelete(
  page: { id: string; classroom: unknown },
  reason: 'deleted' = 'deleted'
): Promise<{ ok: boolean }> {
  const row = await prisma.collabDoc.findUnique({
    where: { kind_doc_id: { kind: 'page', doc_id: page.id } },
    select: { epoch: true },
  });
  if (
    !closeBeforeDelete({
      classroomFlagged: classroomCollabEnabled(page.classroom),
      hasCollabDoc: Boolean(row),
    })
  ) {
    return { ok: true };
  }
  // Server-to-server only, so the browser's WebSocket URL is not required.
  const env = resolveCollabEnv();
  if (!env) {
    console.error('[pages] Cannot close the live room before deleting page', page.id);
    return { ok: false };
  }
  try {
    const body: CloseRequest = { reason };
    await collabInternalRequest(env, 'POST', pageInternalPath(page.id, 'close'), body);
    return { ok: true };
  } catch (error) {
    if ((error as { status?: number }).status === 404) return { ok: true };
    console.error('[pages] Closing the live room before delete failed:', error);
    return { ok: false };
  }
}
