import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import type { MediaKind, MediaProcessing, MediaStatus, MediaUsage } from '@classmoji/services';

/**
 * What the media settings tab reads.
 *
 * Kept out of `route.tsx` because two things here are easy to get wrong in a
 * loader and easy to see in isolation: the uploader names, which are an N+1
 * waiting to happen, and the SIZE a row is shown at, which has to be the same
 * number the quota counted or the meter and the table will disagree in front
 * of the person deciding what to delete.
 */

/** A media row as the table renders it. Dates are ISO; the client formats them. */
export interface MediaListItem {
  id: string;
  filename: string;
  kind: MediaKind;
  ext: string;
  /** The bytes this row currently costs the classroom. See `billedBytes`. */
  billedBytes: number;
  status: MediaStatus;
  processing: MediaProcessing;
  processingError: string | null;
  optimise: boolean;
  keepOriginal: boolean;
  allowDownload: boolean;
  uploadedByName: string;
  createdAt: string;
}

export interface MediaPageData {
  classroomId: string;
  /** False when the deployment has no R2 credentials: no uploads, and we say so. */
  configured: boolean;
  usage: MediaUsage;
  /**
   * What Pro would give this classroom. Sent from the loader rather than read
   * from the constant in the component, because importing the services barrel
   * into component code would drag Prisma and the S3 client into the browser
   * bundle — the same rule `SlideKindChip` is written to.
   */
  proQuotaBytes: number;
  items: MediaListItem[];
}

/**
 * What one row costs.
 *
 * Mirrors the service's own accounting: while the original is there it is what
 * is stored and therefore what is billed; once the rendition has replaced it,
 * the rendition is. Showing `size_bytes` unconditionally would tell an owner a
 * 2 GB screen recording is still costing them 2 GB after processing shrank it
 * to 300 MB, and the meter would say otherwise on the same screen.
 */
function billedBytes(record: {
  sizeBytes: number;
  renditionBytes: number | null;
  originalDeletedAt: Date | null;
}): number {
  if (record.originalDeletedAt) return record.renditionBytes ?? record.sizeBytes;
  return record.sizeBytes;
}

/**
 * Uploader ids → a display name, in ONE query.
 *
 * A `findById` per row would be a query per file on a page whose whole job is
 * to list files. The set is tiny — every uploader is on the teaching team — so
 * the distinct ids go in a single `IN`.
 */
async function uploaderNames(userIds: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(userIds)].filter(Boolean);
  if (wanted.length === 0) return new Map();

  const users = await getPrisma().user.findMany({
    where: { id: { in: wanted } },
    select: { id: true, name: true, login: true },
  });

  return new Map(users.map(user => [user.id, user.name || user.login || 'Unknown']));
}

/**
 * Usage and the list, for a classroom.
 *
 * Both are read even when media is unconfigured: they are plain database reads
 * with no R2 in them, and a deployment that loses its credentials should still
 * show an owner what it is holding rather than an empty page. `configured` only
 * decides whether anything new can be added.
 */
export async function loadMediaPage(classroom: { id: string }): Promise<MediaPageData> {
  const [usage, records] = await Promise.all([
    ClassmojiService.media.usage(classroom),
    ClassmojiService.media.listMedia(classroom),
  ]);

  const names = await uploaderNames(records.map(record => record.uploadedBy));

  return {
    classroomId: classroom.id,
    configured: ClassmojiService.media.isMediaConfigured(),
    usage,
    proQuotaBytes: ClassmojiService.media.PRO_QUOTA_BYTES,
    items: records.map(record => ({
      id: record.id,
      filename: record.filename,
      kind: record.kind,
      ext: record.ext,
      billedBytes: billedBytes(record),
      status: record.status,
      processing: record.processing,
      processingError: record.processingError,
      optimise: record.optimise,
      keepOriginal: record.keepOriginal,
      allowDownload: record.allowDownload,
      uploadedByName: names.get(record.uploadedBy) ?? 'Unknown',
      createdAt: record.createdAt.toISOString(),
    })),
  };
}
