import getPrisma from '@classmoji/database';
import type { MediaKind } from './mediaKinds.ts';
import { origVariant } from './mediaKeys.ts';
import { RESERVATION_WINDOW_MS } from './mediaQuota.ts';

/**
 * Reading media rows, and the shape everything outside this folder sees them in.
 *
 * Split from `media.service.ts` so the RENDER path can have it without the
 * write path. The resolver in `contentDelivery.service.ts` needs exactly two
 * things — the rows for a batch of refs, and which variant each one serves —
 * and neither of those has any business pulling an S3 client and its transitive
 * AWS packages into a module that every page render imports.
 *
 * ## BigInt at the boundary
 *
 * `size_bytes` and `rendition_bytes` are BIGINT, so Prisma hands back `bigint`,
 * which `JSON.stringify` refuses. `toMediaRecord` converts both to `number`:
 * the per-file ceiling is 2 GiB and the quota 10 GiB, both an order of
 * magnitude under `Number.MAX_SAFE_INTEGER`, so nothing is lost. The column
 * keeps the wider type because it outlives this phase's limits.
 */

/** The classroom fields a media operation needs. Narrow on purpose. */
export interface MediaClassroom {
  id: string;
}

export type MediaStatus = 'UPLOADING' | 'READY' | 'DELETED';
export type MediaProcessing = 'NONE' | 'PENDING' | 'DONE' | 'FAILED';

/** The raw row shape this folder reads. A Prisma row satisfies it structurally. */
export interface MediaRow {
  id: string;
  classroom_id: string;
  kind: MediaKind;
  filename: string;
  ext: string;
  content_type: string;
  size_bytes: bigint;
  status: MediaStatus;
  upload_id: string | null;
  uploaded_by: string;
  optimise: boolean;
  keep_original: boolean;
  allow_download: boolean;
  processing: MediaProcessing;
  processing_error: string | null;
  rendition_key: string | null;
  rendition_bytes: bigint | null;
  poster_key: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  created_at: Date;
  ready_at: Date | null;
  original_deleted_at: Date | null;
}

/** A media row as everything outside this folder sees it. Numbers, not bigints. */
export interface MediaRecord {
  id: string;
  classroomId: string;
  kind: MediaKind;
  filename: string;
  ext: string;
  contentType: string;
  sizeBytes: number;
  status: MediaStatus;
  uploadedBy: string;
  optimise: boolean;
  keepOriginal: boolean;
  allowDownload: boolean;
  processing: MediaProcessing;
  processingError: string | null;
  renditionKey: string | null;
  renditionBytes: number | null;
  posterKey: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  createdAt: Date;
  readyAt: Date | null;
  originalDeletedAt: Date | null;
  /** The reference content stores for this object. */
  ref: string;
}

/** `media://{uuid}` — the reference content.json and deck.json store. */
export function mediaRef(mediaId: string): string {
  return `media://${mediaId}`;
}

export function toMediaRecord(row: MediaRow): MediaRecord {
  return {
    id: row.id,
    classroomId: row.classroom_id,
    kind: row.kind,
    filename: row.filename,
    ext: row.ext,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    uploadedBy: row.uploaded_by,
    optimise: row.optimise,
    keepOriginal: row.keep_original,
    allowDownload: row.allow_download,
    processing: row.processing,
    processingError: row.processing_error,
    renditionKey: row.rendition_key,
    renditionBytes: row.rendition_bytes === null ? null : Number(row.rendition_bytes),
    posterKey: row.poster_key,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    readyAt: row.ready_at,
    originalDeletedAt: row.original_deleted_at,
    ref: mediaRef(row.id),
  };
}

/**
 * Which variant a row is SERVED as.
 *
 * The rendition's presence is the switch, and there is deliberately no
 * override: a `web.mp4` exists only once the job has verified it, so preferring
 * it is always right, and a per-object toggle would be a second source of truth
 * for something the job already knows. A row with no rendition serves what was
 * uploaded.
 */
export function servedVariant(row: { ext: string; renditionKey?: string | null }): string {
  if (row.renditionKey) return 'web.mp4';
  // The ext was validated against the allowlist at create time, so the fallback
  // is unreachable for a row this codebase wrote — and if it ever is reached,
  // an unsignable variant is better than one the Worker would 404 on silently.
  return origVariant(row.ext) ?? `orig.${row.ext}`;
}

/** The cutoff an UPLOADING row must be newer than to count, and to be listed. */
export function reservationCutoff(now: number = Date.now()): Date {
  return new Date(now - RESERVATION_WINDOW_MS);
}

/**
 * Every row that currently costs the classroom something: READY, plus the
 * reservations still inside their window.
 *
 * ONE query — the usage sum and the media list want the same set, and splitting
 * them into per-status aggregates would be three round trips for arithmetic
 * over a few hundred small rows. It also means the meter and the list can never
 * disagree about what a classroom is holding.
 */
export async function liveRows(classroomId: string): Promise<MediaRow[]> {
  return (await getPrisma().mediaObject.findMany({
    where: {
      classroom_id: classroomId,
      OR: [{ status: 'READY' }, { status: 'UPLOADING', created_at: { gte: reservationCutoff() } }],
    },
    orderBy: { created_at: 'desc' },
  })) as MediaRow[];
}

/**
 * One row, scoped to the classroom asking for it.
 *
 * `classroom_id` is in the WHERE clause rather than checked afterwards, so a
 * foreign id and an unknown id produce the same absence. That equivalence is
 * the point: a caller cannot tell "this exists somewhere else" from "this does
 * not exist", and there is nothing to probe for.
 */
export async function findMediaRow(classroomId: string, mediaId: string): Promise<MediaRow | null> {
  if (typeof mediaId !== 'string' || mediaId.length === 0) return null;
  return (await getPrisma().mediaObject.findFirst({
    where: { id: mediaId, classroom_id: classroomId },
  })) as MediaRow | null;
}

/**
 * READY rows for a batch of ids, in ONE query, keyed by id.
 *
 * The render-time resolver's read, and the reason this module exists. Scoped to
 * the classroom and filtered to READY in the query itself, for the same reason
 * as `findMediaRow`: a ref naming another classroom's object simply is not in
 * the result, and the resolver turns that absence into the same `/missing/`
 * placeholder a deleted or unknown id gets. There is no branch where a foreign
 * row is in hand and then rejected, so there is no branch to get wrong.
 */
export async function lookupReadyMedia(
  classroomId: string,
  mediaIds: string[]
): Promise<Map<string, MediaRecord>> {
  const wanted = [...new Set(mediaIds.filter(id => typeof id === 'string' && id.length > 0))];
  if (wanted.length === 0) return new Map();

  const rows = (await getPrisma().mediaObject.findMany({
    where: { classroom_id: classroomId, status: 'READY', id: { in: wanted } },
  })) as MediaRow[];

  return new Map(rows.map(row => [row.id, toMediaRecord(row)]));
}
