import { ClassmojiService } from '~/utils/db.server.ts';
import {
  TEACHING_TEAM_ROLES,
  collectMediaDownloadRefs,
  downloadableByRef,
  type MediaDownloads,
} from './mediaDownloads.ts';
import { parseMediaRef } from './mediaRefs.ts';

/** Roles that download any media file, whatever its uploader chose for students. */
export { TEACHING_TEAM_ROLES };

/** Whether this role downloads under the student rule (`allow_download` on videos). */
export const downloadsAsStudent = (role: string): boolean => !TEACHING_TEAM_ROLES.has(role);

/**
 * `ref → downloadable` for the media files a page's blocks hold, for a member
 * with `role`. One READY-row lookup, scoped to the classroom in SQL.
 *
 * Only ever called for a signed-in MEMBER — an anonymous reader of a public
 * page gets no button, so the caller does not ask. A lookup failure degrades
 * to no buttons rather than failing the page: the button is a convenience,
 * the page is the thing.
 */
export async function loadMediaDownloads(
  classroomId: string,
  blocks: unknown,
  role: string
): Promise<MediaDownloads> {
  const refs = collectMediaDownloadRefs(blocks);
  if (refs.length === 0) return {};
  try {
    const ids = refs.map(ref => parseMediaRef(ref)).filter((id): id is string => Boolean(id));
    const records = await ClassmojiService.media.lookupReadyMedia(classroomId, ids);
    return downloadableByRef(refs, records, downloadsAsStudent(role));
  } catch (error) {
    console.warn('[pages] media download lookup failed, showing no download buttons:', error);
    return {};
  }
}
