import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import type {
  MediaKind,
  MediaProcessing,
  MediaRecord,
  MediaStatus,
  MediaUsage,
} from '@classmoji/services';

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
  /**
   * The poster frame, signed, when the video job produced one — the row's
   * thumbnail. Null for everything else, and when the layer cannot sign.
   */
  posterUrl: string | null;
  optimise: boolean;
  keepOriginal: boolean;
  allowDownload: boolean;
  uploadedByName: string;
  createdAt: string;
}

/**
 * The classroom fields this page reads — its id, plus everything
 * `canServeSignedContent` decides on.
 *
 * Structural rather than the Prisma row for the same reason the delivery layer's
 * own predicate is: a caller holding a narrow slice still gets the same rule,
 * and one that forgot a field reads as NOT deliverable, which is the direction
 * that hides an upload button rather than offering one that cannot work.
 */
export interface MediaPageClassroom {
  id: string;
  /** The signing key version — needed to sign the poster thumbnails. */
  content_key_version?: number | null;
  content_delivery_enabled?: boolean | null;
  content_repo?: string | null;
  git_organization?: {
    login?: string | null;
    provider?: string | null;
    github_installation_id?: string | null;
  } | null;
}

export interface MediaPageData {
  classroomId: string;
  /** False when the deployment has no R2 credentials: no uploads, and we say so. */
  configured: boolean;
  /**
   * Whether this classroom's references would actually come back SIGNED, on
   * this deployment (`canServeSignedContent`: the signing secret and origin
   * are set, and the classroom is one the layer delivers).
   *
   * The service refuses `createUpload` with `DELIVERY_REQUIRED` for a classroom
   * the delivery layer cannot sign for — media has no legacy serving path, so
   * the bytes would render as a `/missing/` placeholder and nothing else. The
   * page asks the same question so the refusal arrives before the file picker
   * rather than after a 2 GB upload.
   */
  canDeliver: boolean;
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
 * Signed poster URLs for the rows that have a poster, keyed by row id.
 *
 * Only rows with a `posterKey` are signed — most have none — and a signing
 * failure is a missing thumbnail, never a failed page. The rows were read
 * scoped to this classroom, which is the proof the signer asks for.
 */
async function posterUrls(
  classroom: MediaPageClassroom,
  records: MediaRecord[]
): Promise<Map<string, string>> {
  const withPoster = records.filter(record => record.posterKey && record.status === 'READY');
  if (withPoster.length === 0) return new Map();

  // The signer's classroom shape, from the fields this page already reads. A
  // classroom missing one of them cannot be signed for, so it gets no posters
  // rather than a cast that pretends otherwise.
  const login = classroom.git_organization?.login;
  if (typeof classroom.content_key_version !== 'number' || !classroom.content_repo || !login) {
    return new Map();
  }
  const signer = {
    id: classroom.id,
    content_key_version: classroom.content_key_version,
    content_repo: classroom.content_repo,
    git_organization: { login },
    content_delivery_enabled: classroom.content_delivery_enabled === true,
  };

  const minted = await Promise.all(
    withPoster.map(async record => {
      try {
        const url = await ClassmojiService.contentDelivery.mediaPosterUrl({
          classroom: signer,
          record,
        });
        return url ? ([record.id, url] as const) : null;
      } catch {
        return null;
      }
    })
  );
  return new Map(minted.filter((entry): entry is readonly [string, string] => entry !== null));
}

/**
 * Usage and the list, for a classroom.
 *
 * Both are read even when media is unconfigured: they are plain database reads
 * with no R2 in them, and a deployment that loses its credentials should still
 * show an owner what it is holding rather than an empty page. `configured` only
 * decides whether anything new can be added.
 */
export async function loadMediaPage(classroom: MediaPageClassroom): Promise<MediaPageData> {
  const [usage, records] = await Promise.all([
    ClassmojiService.media.usage(classroom),
    ClassmojiService.media.listMedia(classroom),
  ]);

  const [names, posters] = await Promise.all([
    uploaderNames(records.map(record => record.uploadedBy)),
    posterUrls(classroom, records),
  ]);

  return {
    classroomId: classroom.id,
    configured: ClassmojiService.media.isMediaConfigured(),
    // The delivery layer's own predicate, not a copy of it — BOTH halves, the
    // deployment's signing setup and the classroom: the service refuses an
    // upload on exactly this answer, so the button and the refusal cannot
    // drift apart.
    canDeliver: ClassmojiService.contentDelivery.canServeSignedContent(classroom),
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
      posterUrl: posters.get(record.id) ?? null,
      optimise: record.optimise,
      keepOriginal: record.keepOriginal,
      allowDownload: record.allowDownload,
      uploadedByName: names.get(record.uploadedBy) ?? 'Unknown',
      createdAt: record.createdAt.toISOString(),
    })),
  };
}
