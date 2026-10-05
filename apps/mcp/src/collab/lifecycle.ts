/**
 * Deleting a page or deck that is (or was) edited live. Before the row and
 * its content folder go, the collab server must checkpoint the document and
 * close every editor's connection — otherwise open editors keep writing to a
 * document that no longer exists, and a later checkpoint could push its
 * files back into the content repo. Needed when the classroom edits live OR
 * a collab_docs row still exists (the flag was turned off since).
 */

import getPrisma from '@classmoji/database';
import type { CollabKind } from '@classmoji/collab';
import { resolveCollabEnv } from '@classmoji/collab/env';
import { ToolError } from '../mcp/errors.ts';
import { CollabRequestError, notifyMetaChanged, postClose } from './client.ts';

export async function closeLiveDocBeforeDelete(
  kind: CollabKind,
  docId: string,
  classroomId: string
): Promise<void> {
  const prisma = getPrisma();
  const [classroom, row] = await Promise.all([
    prisma.classroom.findUnique({ where: { id: classroomId }, select: { collab_enabled: true } }),
    prisma.collabDoc.findUnique({
      where: { kind_doc_id: { kind, doc_id: docId } },
      select: { kind: true },
    }),
  ]);
  const flagged = classroom?.collab_enabled === true;
  if (!flagged && !row) return;

  const what = kind === 'page' ? 'page' : 'deck';
  const env = resolveCollabEnv();
  if (!env) {
    // A leftover row with no collab service anywhere: nothing is open to close.
    if (!flagged) return;
    throw new ToolError(
      'internal',
      `This ${what} is edited live, but the live editing service is not configured here, so ` +
        'it was not deleted.',
      'LIVE_UNAVAILABLE'
    );
  }
  try {
    await postClose(env, kind, docId, 'deleted');
  } catch (error) {
    if (error instanceof CollabRequestError && error.status === 404) return;
    if (error instanceof CollabRequestError && error.unavailable) {
      throw new ToolError(
        'internal',
        `The live editing service did not answer, so the ${what} was not deleted (people ` +
          'editing it would keep writing to it). Retry shortly.',
        'LIVE_UNAVAILABLE'
      );
    }
    throw error;
  }
}

/**
 * A page's title/width or a deck's title changed (page_update, slide_update):
 * tell editors who have it open live, so their header updates at once. Only
 * for classrooms that edit live; best effort (never fails the update).
 */
export async function notifyLiveMetaChanged(
  kind: CollabKind,
  docId: string,
  classroomId: string,
  meta: { title?: string; width?: number }
): Promise<void> {
  if (meta.title === undefined && meta.width === undefined) return;
  try {
    const classroom = await getPrisma().classroom.findUnique({
      where: { id: classroomId },
      select: { collab_enabled: true },
    });
    await notifyMetaChanged(classroom, kind, docId, meta);
  } catch (error) {
    console.warn(
      `[mcp] Could not tell live editors the ${kind} changed:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}
