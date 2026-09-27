import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { tasks } from '@trigger.dev/sdk';
import { randomUUID } from 'node:crypto';
import getPrisma from '@classmoji/database';
import { REPO_REST_MAX_BYTES } from '@classmoji/utils';
import { ContentService } from '../content/ContentService.ts';
import { recordContentAsset } from '../classmoji/contentAssets.service.ts';
import { uploadFileTypes } from '../classmoji/contentDelivery.service.ts';
import { uploadPageAsset, type PageWithContentRepo } from '../classmoji/pageContent.service.ts';
import { MediaError } from './MediaError.ts';
import {
  abortQuietly,
  deleteObjectsQuietly,
  markDeleted,
  onMediaReady,
  refuseIfExpired,
  requireClient,
  verifiedSize,
} from './media.service.ts';
import { mediaKey, stageKey } from './mediaKeys.ts';
import { contentTypeForExt, extensionOf } from './mediaKinds.ts';
import {
  billedBytes,
  findMediaRow,
  liveRowsWhere,
  mediaRef,
  reservationCutoff,
  toMediaRecord,
  type MediaRow,
} from './mediaLookup.ts';
import { PER_FILE_MAX_BYTES, quotaBytesFor } from './mediaQuota.ts';
import { assertRepoTarget, uploadCapabilityFor, type CapabilityClassroom } from './uploadCapability.ts';
import { kindOfFilename, storageTargetFor } from './storageRouter.ts';

/**
 * Agent uploads: bytes that reach a page or a deck without passing through the
 * model (MCP `file_upload_start` / `file_upload_finish`, `file_import_url`).
 *
 * Base64 through a tool call costs the model ~1.4M characters per megabyte, so
 * anything but a small image is impractical that way. Instead the agent is
 * handed ONE presigned PUT for a staging key in the media bucket and runs
 * `curl -T`; or, without a shell, it names a URL and a Trigger task fetches it.
 * Either way the bytes land under `stage/{classroomId}/{mediaId}` first and are
 * then PLACED where the storage router sends them: committed to the content
 * repo (Free, and small non-video files everywhere) or copied into media (Pro
 * video, and anything over the repository's cap on Pro).
 *
 * ## The row is a `media_objects` row in STAGING
 *
 * No second table. A STAGING row holds a quota reservation exactly like a
 * browser's UPLOADING one (`liveRowsWhere`), ages out on the same 24 h window,
 * and carries the five staging columns (see the schema). Its lifecycle, which
 * `file_upload_status` reads back:
 *
 *   STAGING, processing NONE     → awaiting upload (the PUT URL was handed out)
 *   STAGING, processing PENDING  → placing (a placement or import job is queued)
 *   READY,   placed_ref media://  → placed into media — it IS the media object now
 *   DELETED, placed_ref <path>    → placed into the content repo; the row no
 *                                   longer holds bytes, so it stops costing quota
 *   DELETED, placement_error      → failed, with the reason
 *   DELETED, neither              → cancelled or expired
 *
 * A repo placement TOMBSTONES the row rather than leaving it STAGING, so a Pro
 * classroom's quota is not charged for a day for a file that went to git.
 *
 * ## Admission control
 *
 * The bucket's lifecycle rule deletes stale `stage/` objects after a day, but
 * that is cleanup, not a limit. So opening a stage takes the same classroom row
 * lock `createUpload` does and refuses when the classroom already has
 * `STAGE_OUTSTANDING_MAX_BYTES` (or `STAGE_OUTSTANDING_MAX_COUNT` rows) waiting,
 * and — for a media destination — when the file would not fit the quota.
 *
 * ## Bound to the caller
 *
 * Every read and write below is scoped to the classroom in its WHERE clause and
 * to the user who opened the stage: another teacher in the same class cannot
 * finish, poll or place someone else's upload. A mismatch is NOT_FOUND, the
 * same answer as an id that does not exist.
 */

/** How long the staged PUT URL lives. Short: it is a reusable write until it expires. */
export const STAGE_URL_TTL_SECONDS = 15 * 60;

const GIB = 1024 * 1024 * 1024;

/** The most bytes one classroom may have waiting under `stage/` at once. */
export const STAGE_OUTSTANDING_MAX_BYTES = 4 * GIB;

/** The most agent uploads one classroom may have waiting at once (URL imports reserve 0 bytes). */
export const STAGE_OUTSTANDING_MAX_COUNT = 50;

/** The Trigger task that commits a staged file into the content repo. */
export const PLACE_STAGED_TASK_ID = 'media-place-staged';

/** The Trigger task that fetches a URL into a staging object and then places it. */
export const IMPORT_URL_TASK_ID = 'media-import-url';

/** Multipart part size for a URL import streamed into `stage/`. R2's floor is 5 MiB. */
export const STAGE_PART_SIZE_BYTES = 16 * 1024 * 1024;

export type StageTargetType = 'page' | 'slide';

export interface StageTarget {
  type: StageTargetType;
  /** The page's or slide's id. The CALLER proves it belongs to the classroom. */
  id: string;
}

export type StagedStatus =
  | { status: 'awaiting_upload'; uploadId: string; filename: string; destination: string }
  | { status: 'placing'; uploadId: string; filename: string; destination: string }
  | { status: 'placed'; uploadId: string; filename: string; destination: string; ref: string }
  | { status: 'failed'; uploadId: string; filename: string; destination: string; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Opening a stage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route a file for an agent upload, or refuse it with the router's sentence.
 *
 * The same `storageTargetFor` every other upload entry runs, from the classroom
 * the server loaded — so an agent is told up front, before it uploads a byte,
 * that a Free class cannot take a 200 MB file.
 */
async function routeAgentFile(
  classroom: CapabilityClassroom,
  filename: string,
  sizeBytes: number
): Promise<'repo' | 'media'> {
  const capability = await uploadCapabilityFor(classroom);
  const target = storageTargetFor(capability, { name: filename, size: sizeBytes });
  if (target.kind === 'refused') throw new MediaError('STORAGE_REFUSED', target.message);
  return target.kind;
}

/**
 * The fixed fields of a new STAGING row, from the filename.
 *
 * The video options mirror `createUpload`'s defaults: optimise on, keep the
 * original, downloads off for video and on for everything else.
 */
function stagingRowFields(filename: string) {
  const ext = extensionOf(filename) ?? '';
  const kind = kindOfFilename(filename);
  const isVideo = kind === 'VIDEO';
  return {
    kind,
    filename,
    ext,
    content_type: contentTypeForExt(ext),
    optimise: isVideo,
    keep_original: true,
    allow_download: !isVideo,
  };
}

/**
 * Insert a STAGING row behind the classroom lock, after the admission checks.
 *
 * One transaction, like `createUpload`'s: the SUMs and the INSERT they
 * authorize see the same state, so two stages opened a millisecond apart
 * serialize and the second one counts the first.
 */
async function insertStagingRow(args: {
  classroomId: string;
  userId: string;
  mediaId: string;
  filename: string;
  sizeBytes: number;
  destination: 'repo' | 'media';
  target: StageTarget;
  processing: 'NONE' | 'PENDING';
}): Promise<void> {
  await getPrisma().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM classrooms WHERE id = ${args.classroomId} FOR UPDATE`;

    const live = (await tx.mediaObject.findMany({
      where: liveRowsWhere(args.classroomId),
    })) as MediaRow[];

    const staged = live.filter(row => row.status === 'STAGING');
    const stagedBytes = staged.reduce((total, row) => total + Number(row.size_bytes), 0);
    if (
      staged.length >= STAGE_OUTSTANDING_MAX_COUNT ||
      stagedBytes + args.sizeBytes > STAGE_OUTSTANDING_MAX_BYTES
    ) {
      throw new MediaError(
        'STAGE_LIMIT',
        'This class already has too many unfinished agent uploads. Finish or cancel some, ' +
          'or wait for them to expire (24 hours), then try again.'
      );
    }

    if (args.destination === 'media') {
      const usedBytes = live.reduce((total, row) => total + billedBytes(row), 0);
      const quotaBytes = quotaBytesFor(true);
      if (usedBytes + args.sizeBytes > quotaBytes) {
        throw new MediaError(
          'QUOTA_EXCEEDED',
          'This file would put the class over its storage quota',
          { usedBytes, quotaBytes }
        );
      }
    }

    await tx.mediaObject.create({
      data: {
        id: args.mediaId,
        classroom_id: args.classroomId,
        ...stagingRowFields(args.filename),
        size_bytes: BigInt(args.sizeBytes),
        status: 'STAGING',
        uploaded_by: args.userId,
        processing: args.processing,
        destination: args.destination,
        stage_target_type: args.target.type,
        stage_target_id: args.target.id,
      },
    });
  });
}

/**
 * `file_upload_start`: route the declared file, reserve it, and hand back one
 * presigned PUT for its staging key.
 *
 * The PUT is signed for an exact `Content-Length`, so R2 refuses a body of any
 * other size before storing it (the same rule `signParts` relies on).
 * `Content-Type` is deliberately NOT signed: `curl -T` sends none, and the type
 * the object is finally served with is decided at placement from the extension,
 * never from the uploader.
 *
 * The URL can be reused until it expires — a retry of a failed curl just works —
 * which is why its life is short.
 */
export async function startStagedUpload({
  classroom,
  userId,
  filename,
  sizeBytes,
  target,
}: {
  classroom: CapabilityClassroom;
  userId: string;
  filename: string;
  sizeBytes: number;
  target: StageTarget;
}): Promise<{
  uploadId: string;
  uploadUrl: string;
  expiresAt: string;
  destination: 'repo' | 'media';
  sizeBytes: number;
}> {
  const { client, bucket } = requireClient();

  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new MediaError('FILE_TOO_LARGE', 'A file size in bytes (greater than 0) is required');
  }
  if (sizeBytes > PER_FILE_MAX_BYTES) {
    throw new MediaError('FILE_TOO_LARGE', 'This file is larger than the 2 GB limit for one file.');
  }

  const destination = await routeAgentFile(classroom, filename, sizeBytes);
  const mediaId = randomUUID();
  const key = stageKey(classroom.id, mediaId);

  await insertStagingRow({
    classroomId: classroom.id,
    userId,
    mediaId,
    filename,
    sizeBytes,
    destination,
    target,
    processing: 'NONE',
  });

  const expiresAt = new Date(Date.now() + STAGE_URL_TTL_SECONDS * 1000).toISOString();
  let uploadUrl: string;
  try {
    uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentLength: sizeBytes }),
      { expiresIn: STAGE_URL_TTL_SECONDS, signableHeaders: new Set(['content-length']) }
    );
  } catch (error) {
    await markDeleted(mediaId, 'STAGING');
    throw error;
  }

  return { uploadId: mediaId, uploadUrl, expiresAt, destination, sizeBytes };
}

/**
 * Light validation of an import URL at the door. The task re-validates it fully
 * (DNS, every address, the connection itself) — this only refuses what can be
 * refused without the network, so an agent hears "https only" at once rather
 * than from a failed job.
 */
function assertImportUrlShape(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MediaError('STORAGE_REFUSED', 'That is not a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw new MediaError('STORAGE_REFUSED', 'Only https:// URLs can be imported.');
  }
  if (url.username || url.password) {
    throw new MediaError('STORAGE_REFUSED', 'A URL carrying a username or password cannot be imported.');
  }
  if (url.port && url.port !== '443') {
    throw new MediaError('STORAGE_REFUSED', 'Only URLs on the standard https port (443) can be imported.');
  }
  return url;
}

/** The last segment of a URL's path, decoded, or null when there is none. */
export function filenameFromUrl(url: URL): string | null {
  const segment = url.pathname.split('/').filter(Boolean).pop();
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The most bytes a URL import for this classroom may stream: the repository's
 * cap when there is no media, media's per-file ceiling when there is.
 */
export async function importByteCapFor(classroom: CapabilityClassroom): Promise<number> {
  const capability = await uploadCapabilityFor(classroom);
  return capability.media ? capability.media.perFileMaxBytes : capability.repoMaxBytes;
}

/**
 * `file_import_url`: open a stage for a URL and queue the job that fetches it.
 *
 * The size is unknown until the bytes arrive, so the row reserves NOTHING here
 * (size 0) and the destination written now is provisional — from the name
 * alone. The job enforces the byte cap on the stream, then settles the real
 * size, destination and quota under the lock (`settleStagedImport`) before
 * anything is placed. What bounds a classroom meanwhile is the outstanding-count
 * cap and the job queue's per-classroom concurrency.
 */
export async function startUrlImport({
  classroom,
  userId,
  url,
  filename,
  target,
}: {
  classroom: CapabilityClassroom;
  userId: string;
  url: string;
  filename?: string | null;
  target: StageTarget;
}): Promise<{ uploadId: string; filename: string; maxBytes: number }> {
  requireClient();
  const parsed = assertImportUrlShape(url);
  const name = (filename ?? '').trim() || filenameFromUrl(parsed) || '';
  if (!extensionOf(name)) {
    throw new MediaError(
      'STORAGE_REFUSED',
      'Pass a filename with an extension (e.g. lecture.mp4) — the URL does not end in one.'
    );
  }

  // A 1-byte probe: the type and name rules, before any fetch. The size rule is
  // the job's, on the real bytes.
  const destination = await routeAgentFile(classroom, name, 1);
  const maxBytes = await importByteCapFor(classroom);
  const mediaId = randomUUID();

  await insertStagingRow({
    classroomId: classroom.id,
    userId,
    mediaId,
    filename: name,
    sizeBytes: 0,
    destination,
    target,
    processing: 'PENDING',
  });

  try {
    await tasks.trigger(
      IMPORT_URL_TASK_ID,
      { mediaId, url: parsed.toString() },
      { idempotencyKey: `media-import:${mediaId}`, concurrencyKey: classroom.id }
    );
  } catch (error) {
    await failStagedPlacement(mediaId, 'The import could not be queued. Try again.');
    throw error;
  }

  return { uploadId: mediaId, filename: name, maxBytes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a stage back
// ─────────────────────────────────────────────────────────────────────────────

/** The caller's own agent upload in this classroom, or NOT_FOUND. */
async function ownStagedRow(classroomId: string, userId: string, mediaId: string): Promise<MediaRow> {
  const row = await findMediaRow(classroomId, mediaId);
  // `destination` is set on every agent upload and on no other row, so a
  // browser upload's id is not something these calls answer for.
  if (!row || row.destination === null || row.uploaded_by !== userId) {
    throw new MediaError('NOT_FOUND', 'No such upload');
  }
  return row;
}

function statusOf(row: MediaRow, now: number = Date.now()): StagedStatus {
  const base = { uploadId: row.id, filename: row.filename, destination: row.destination ?? 'repo' };
  if (row.status === 'READY') {
    return { ...base, status: 'placed', ref: row.placed_ref ?? mediaRef(row.id) };
  }
  if (row.status === 'DELETED' || row.status === 'UPLOADING') {
    if (row.placed_ref) return { ...base, status: 'placed', ref: row.placed_ref };
    return {
      ...base,
      status: 'failed',
      error: row.placement_error ?? 'This upload was cancelled or expired.',
    };
  }
  if (row.created_at.getTime() < reservationCutoff(now).getTime()) {
    return { ...base, status: 'failed', error: 'This upload expired before it was placed.' };
  }
  return { ...base, status: row.processing === 'PENDING' ? 'placing' : 'awaiting_upload' };
}

/** `file_upload_status`. */
export async function stagedUploadStatus({
  classroom,
  userId,
  uploadId,
}: {
  classroom: { id: string };
  userId: string;
  uploadId: string;
}): Promise<StagedStatus> {
  return statusOf(await ownStagedRow(classroom.id, userId, uploadId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Finishing and placing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Queue the repo placement. Idempotent twice over: the key collapses repeats
 * into one run, and the run itself does nothing for a row no longer STAGING.
 */
async function enqueuePlacement(row: MediaRow): Promise<void> {
  await tasks.trigger(
    PLACE_STAGED_TASK_ID,
    { mediaId: row.id },
    { idempotencyKey: `media-place:${row.id}`, concurrencyKey: row.classroom_id }
  );
}

/**
 * Copy a verified staged object into media: `CopyObject` stage → `m/…/orig.{ext}`
 * inside R2 (the bytes never touch this process), verify the copy's size, flip
 * the row STAGING → READY, then delete the staged object.
 *
 * `MetadataDirective: 'REPLACE'` with the row's content type: the staged PUT
 * carried none (curl sends none, and the signature does not allow one), so a
 * plain copy would store the object typeless and the Worker would fall back.
 * The type comes from the extension, as it does for every upload.
 *
 * READY only FROM STAGING. A concurrent finish that got there first leaves this
 * one a no-op returning the same ref; a cancel that got there first leaves the
 * copy orphaned, so it is deleted.
 */
async function placeIntoMedia(client: S3Client, bucket: string, row: MediaRow): Promise<string> {
  const source = stageKey(row.classroom_id, row.id);
  const target = mediaKey(row.classroom_id, row.id, `orig.${row.ext}`);

  try {
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: target,
        CopySource: `${bucket}/${source}`,
        MetadataDirective: 'REPLACE',
        ContentType: row.content_type,
      })
    );
  } catch (error) {
    // The staged object is gone — most likely a concurrent finish copied it and
    // cleaned up. If that finish made the row READY, this call's answer is its.
    const fresh = await findMediaRow(row.classroom_id, row.id);
    if (fresh?.status === 'READY') return fresh.placed_ref ?? mediaRef(row.id);
    throw error;
  }

  const copied = await verifiedSize(client, bucket, target);
  if (copied !== Number(row.size_bytes)) {
    await deleteObjectsQuietly(client, bucket, [target]);
    throw new MediaError('VERIFY_FAILED', 'The file could not be verified after copying; try again');
  }

  const ref = mediaRef(row.id);
  const readyAt = new Date();
  const { count } = await getPrisma().mediaObject.updateMany({
    where: { id: row.id, status: 'STAGING' },
    data: { status: 'READY', ready_at: readyAt, placed_ref: ref, processing: 'NONE', upload_id: null },
  });
  if (count === 0) {
    const fresh = await findMediaRow(row.classroom_id, row.id);
    if (fresh?.status === 'READY') return fresh.placed_ref ?? ref;
    await deleteObjectsQuietly(client, bucket, [target]);
    throw new MediaError('NOT_FOUND', 'This upload was cancelled before it was placed');
  }

  await deleteObjectsQuietly(client, bucket, [source]);
  await onMediaReady(
    toMediaRecord({
      ...row,
      status: 'READY',
      ready_at: readyAt,
      placed_ref: ref,
      processing: 'NONE',
      upload_id: null,
    })
  );
  return ref;
}

/**
 * `file_upload_finish`: verify the staged bytes and place them.
 *
 *   - media destination → placed synchronously (`placeIntoMedia`), `placed` + ref;
 *   - repo destination  → a placement job is queued, `placing`; poll
 *     `file_upload_status`.
 *
 * Idempotent: a finished upload answers with what it became, a queued one with
 * `placing` (re-queuing is collapsed by the idempotency key).
 *
 * The staged object's size is checked with `HeadObject` BEFORE anything is
 * copied or committed. The PUT was signed for the declared length, so a
 * mismatch should be impossible; if it happens anyway, the declaration the
 * reservation was made against was not what arrived, and the upload is
 * discarded. An object that is not there yet is `NOT_UPLOADED` and changes
 * nothing — the agent uploads, then finishes again.
 */
export async function finishStagedUpload({
  classroom,
  userId,
  uploadId,
}: {
  classroom: { id: string };
  userId: string;
  uploadId: string;
}): Promise<StagedStatus> {
  const { client, bucket } = requireClient();
  const row = await ownStagedRow(classroom.id, userId, uploadId);
  if (row.status !== 'STAGING') return statusOf(row);

  await refuseIfExpired(client, bucket, classroom, row);

  // A placement (or a URL import) is already queued for this row. Not queued
  // again: a URL import places its own file, and a second run beside it would
  // commit the file twice.
  if (row.processing === 'PENDING') return statusOf(row);

  const key = stageKey(classroom.id, row.id);
  const actual = await verifiedSize(client, bucket, key);
  if (actual === null) {
    throw new MediaError(
      'NOT_UPLOADED',
      'Nothing has been uploaded yet — run the curl command from file_upload_start, then finish.'
    );
  }
  if (actual !== Number(row.size_bytes)) {
    if (await markDeleted(row.id, 'STAGING')) await deleteObjectsQuietly(client, bucket, [key]);
    throw new MediaError(
      'SIZE_MISMATCH',
      `Uploaded ${actual} bytes but ${Number(row.size_bytes)} were declared; start again`
    );
  }

  if (row.destination === 'media') {
    const ref = await placeIntoMedia(client, bucket, row);
    return {
      status: 'placed',
      uploadId: row.id,
      filename: row.filename,
      destination: 'media',
      ref,
    };
  }

  // Repo: claim the placement (STAGING/NONE → PENDING) and queue it.
  const { count } = await getPrisma().mediaObject.updateMany({
    where: { id: row.id, status: 'STAGING', processing: 'NONE' },
    data: { processing: 'PENDING' },
  });
  if (count === 0) return statusOf((await findMediaRow(classroom.id, row.id)) ?? row);
  const pending = { ...row, processing: 'PENDING' as const };
  try {
    await enqueuePlacement(pending);
  } catch (error) {
    // Give the claim back, so the agent's retry of finish queues it again
    // rather than finding a row that says "placing" with no job behind it.
    await getPrisma().mediaObject.updateMany({
      where: { id: row.id, status: 'STAGING', processing: 'PENDING' },
      data: { processing: 'NONE' },
    });
    throw error;
  }
  return statusOf(pending);
}

/**
 * Record a placement that failed for good: tombstone (from STAGING only), the
 * reason in `placement_error`, the staged bytes deleted. The reason is what
 * `file_upload_status` hands the agent, so it is a sentence, not a stack.
 */
export async function failStagedPlacement(mediaId: string, reason: string): Promise<void> {
  const row = (await getPrisma().mediaObject.findUnique({ where: { id: mediaId } })) as MediaRow | null;
  if (!row) return;
  const { count } = await getPrisma().mediaObject.updateMany({
    where: { id: mediaId, status: 'STAGING' },
    data: {
      status: 'DELETED',
      deleted_at: new Date(),
      placement_error: reason.slice(0, 500),
      upload_id: null,
    },
  });
  if (count === 0) return;
  const client = requireClientOrNull();
  if (!client) return;
  const key = stageKey(row.classroom_id, row.id);
  if (row.upload_id) await abortQuietly(client.client, client.bucket, key, row.upload_id);
  await deleteObjectsQuietly(client.client, client.bucket, [key]);
}

function requireClientOrNull(): { client: S3Client; bucket: string } | null {
  try {
    return requireClient();
  } catch {
    return null;
  }
}

/** A staged row by id alone — for the tasks, which are handed nothing else. */
async function stagedRowById(mediaId: string): Promise<MediaRow | null> {
  return (await getPrisma().mediaObject.findUnique({ where: { id: mediaId } })) as MediaRow | null;
}

/** Read a staged object whole. Only ever for a repo placement, which is ≤ the repo cap. */
async function readStagedObject(client: S3Client, bucket: string, key: string): Promise<Buffer> {
  const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = object.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) throw new Error(`media: no body for ${key}`);
  return Buffer.from(await body.transformToByteArray());
}

/**
 * Commit a staged file into the content repo, next to what it was added to.
 *
 *   - page  → the page's `assets/` folder, through `uploadPageAsset` (the same
 *             call the page editor, the page cover and `page_asset_upload` make —
 *             routing re-check, type policy, the asset-map row, the stored-ref
 *             rule all come with it); the ref is what the editor would store;
 *   - slide → the deck's `images/` folder, the deck editor's own upload
 *             convention (`{content_path}/images`), with its asset-map row; the
 *             ref is the repo path.
 */
async function commitToRepo(row: MediaRow, buffer: Buffer): Promise<string> {
  const prisma = getPrisma();
  if (row.stage_target_type === 'page') {
    const page = await prisma.page.findUnique({
      where: { id: row.stage_target_id ?? '' },
      include: { classroom: { include: { git_organization: true } } },
    });
    if (!page || page.classroom_id !== row.classroom_id) {
      throw new PlacementRefused('The page this file was being added to no longer exists.');
    }
    const uploaded = await uploadPageAsset(page as unknown as PageWithContentRepo, buffer, row.filename);
    return uploaded.url;
  }

  if (row.stage_target_type === 'slide') {
    const slide = await prisma.slide.findUnique({
      where: { id: row.stage_target_id ?? '' },
      include: { classroom: { include: { git_organization: true } } },
    });
    if (!slide || slide.classroom_id !== row.classroom_id || !slide.classroom) {
      throw new PlacementRefused('The slide deck this file was being added to no longer exists.');
    }
    const classroom = slide.classroom;
    if (!classroom.git_organization || !classroom.content_repo) {
      throw new PlacementRefused('This class has no content repository to add the file to.');
    }
    await assertRepoTarget(classroom as unknown as CapabilityClassroom, {
      name: row.filename,
      size: buffer.length,
    });
    const result = await ContentService.upload({
      gitOrganization: classroom.git_organization as never,
      repo: classroom.content_repo,
      file: buffer,
      filename: row.filename,
      folder: `${slide.content_path}/images`,
      message: `Upload image for slides: ${slide.title}`,
      fileTypes: uploadFileTypes(classroom as never),
    });
    await recordContentAsset(row.classroom_id, {
      path: result.path,
      sha: result.sha,
      size: buffer.length,
    });
    return result.path;
  }

  throw new PlacementRefused('This upload has no page or slide to be added to.');
}

/** A placement that cannot succeed on retry — recorded, not rethrown. */
export class PlacementRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlacementRefused';
  }
}

/**
 * Is this a refusal a retry cannot change? The repository's own typed
 * refusals (type, name, size), the router's `USE_MEDIA`, and our own.
 */
export function isPermanentPlacementError(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as { code?: unknown }).code;
    if (
      current instanceof PlacementRefused ||
      current.name === 'PlacementRefused' ||
      current.name === 'MediaError' ||
      code === 'FILE_REFUSED' ||
      code === 'REPO_FILE_TOO_LARGE' ||
      code === 'USE_MEDIA'
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The `media-place-staged` task's body: place one staged row where its
 * destination says. A row no longer STAGING is a no-op (a retried or duplicate
 * run). Throws on failure; the TASK decides whether that is worth a retry
 * (`isPermanentPlacementError`) or final (`failStagedPlacement`).
 */
export async function placeStagedObject(
  mediaId: string
): Promise<{ status: 'placed'; ref: string } | { status: 'skipped'; reason: string }> {
  const row = await stagedRowById(mediaId);
  if (!row || row.status !== 'STAGING') return { status: 'skipped', reason: 'not-staging' };
  const { client, bucket } = requireClient();

  if (row.destination === 'media') {
    return { status: 'placed', ref: await placeIntoMedia(client, bucket, row) };
  }

  const key = stageKey(row.classroom_id, row.id);
  if (Number(row.size_bytes) > REPO_REST_MAX_BYTES) {
    throw new PlacementRefused('This file is larger than the course repository accepts.');
  }
  const buffer = await readStagedObject(client, bucket, key);
  if (buffer.length !== Number(row.size_bytes)) {
    throw new PlacementRefused(
      `The staged file is ${buffer.length} bytes, not the ${Number(row.size_bytes)} declared.`
    );
  }

  const ref = await commitToRepo(row, buffer);

  // Tombstoned WITH the ref: the row no longer holds bytes in media, so it
  // stops costing quota now rather than in a day; `file_upload_status` reads
  // the ref back from it. Only from STAGING — a cancel that won the race has
  // already tombstoned it, and the commit it could not stop stands.
  await getPrisma().mediaObject.updateMany({
    where: { id: row.id, status: 'STAGING' },
    data: { status: 'DELETED', deleted_at: new Date(), placed_ref: ref, upload_id: null },
  });
  await deleteObjectsQuietly(client, bucket, [key]);
  return { status: 'placed', ref };
}

// ─────────────────────────────────────────────────────────────────────────────
// URL imports (the `media-import-url` task's service half)
// ─────────────────────────────────────────────────────────────────────────────

/** What the import task needs to know before it fetches. */
export async function stagedImportContext(
  mediaId: string
): Promise<{ row: MediaRow; maxBytes: number } | null> {
  const row = await stagedRowById(mediaId);
  if (!row || row.status !== 'STAGING') return null;
  return { row, maxBytes: await importByteCapFor({ id: row.classroom_id }) };
}

/**
 * Stream bytes into the row's staging key as a multipart upload.
 *
 * The part size is fixed (R2 requires every part but the last to be the same
 * size), so the stream is re-chunked into `STAGE_PART_SIZE_BYTES` buffers — one
 * part in memory at a time. The multipart id is written onto the row while it
 * is open, so a cancel, a delete or a classroom purge can abort it. The byte
 * cap is the CALLER's (the fetch helper enforces it on the stream); `maxBytes`
 * here is a second line that aborts the upload rather than trusting it.
 */
export async function streamIntoStage(
  row: MediaRow,
  body: AsyncIterable<Uint8Array>,
  maxBytes: number
): Promise<number> {
  const { client, bucket } = requireClient();
  const key = stageKey(row.classroom_id, row.id);

  const created = await client.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: row.content_type })
  );
  const uploadId = created.UploadId;
  if (!uploadId) throw new Error('R2 did not return an upload id');
  await getPrisma().mediaObject.updateMany({
    where: { id: row.id, status: 'STAGING' },
    data: { upload_id: uploadId },
  });

  const parts: { PartNumber: number; ETag: string }[] = [];
  let total = 0;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;

  const flush = async () => {
    if (pendingBytes === 0) return;
    const partNumber = parts.length + 1;
    const chunk = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    const result = await client.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: chunk,
        ContentLength: chunk.length,
      })
    );
    if (!result.ETag) throw new Error(`R2 returned no etag for part ${partNumber}`);
    parts.push({ PartNumber: partNumber, ETag: result.ETag });
  };

  try {
    for await (const piece of body) {
      total += piece.byteLength;
      if (total > maxBytes) {
        throw new MediaError('FILE_TOO_LARGE', 'The file at that URL is larger than this class can store.');
      }
      let offset = 0;
      while (offset < piece.byteLength) {
        const room = STAGE_PART_SIZE_BYTES - pendingBytes;
        const slice = piece.subarray(offset, offset + room);
        pending.push(slice);
        pendingBytes += slice.byteLength;
        offset += slice.byteLength;
        if (pendingBytes === STAGE_PART_SIZE_BYTES) await flush();
      }
    }
    if (total === 0) throw new MediaError('FILE_TOO_LARGE', 'The URL answered with an empty file.');
    await flush();
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      })
    );
  } catch (error) {
    try {
      await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
    } catch {
      // R2's own abort-incomplete-multipart rule covers a failed abort.
    }
    await getPrisma().mediaObject.updateMany({
      where: { id: row.id, status: 'STAGING' },
      data: { upload_id: null },
    });
    throw error;
  }

  await getPrisma().mediaObject.updateMany({
    where: { id: row.id, status: 'STAGING' },
    data: { upload_id: null },
  });
  return total;
}

/**
 * The fetched file's real size is known: route it for real, and reserve it.
 *
 * Under the classroom lock, like every other reservation: the router runs on
 * the ACTUAL byte count (a Pro file that turned out bigger than the repo cap
 * now goes to media), the quota is checked for a media destination, and the
 * row's size and destination are rewritten. A refusal is thrown as a
 * `MediaError`, which the task records as the placement error.
 */
export async function settleStagedImport(mediaId: string, sizeBytes: number): Promise<MediaRow> {
  const row = await stagedRowById(mediaId);
  if (!row || row.status !== 'STAGING') {
    throw new PlacementRefused('This import was cancelled.');
  }
  const destination = await routeAgentFile({ id: row.classroom_id }, row.filename, sizeBytes);

  await getPrisma().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM classrooms WHERE id = ${row.classroom_id} FOR UPDATE`;
    if (destination === 'media') {
      const live = (await tx.mediaObject.findMany({
        where: liveRowsWhere(row.classroom_id),
      })) as MediaRow[];
      const usedBytes = live
        .filter(other => other.id !== row.id)
        .reduce((total, other) => total + billedBytes(other), 0);
      const quotaBytes = quotaBytesFor(true);
      if (usedBytes + sizeBytes > quotaBytes) {
        throw new MediaError('QUOTA_EXCEEDED', 'This file would put the class over its storage quota', {
          usedBytes,
          quotaBytes,
        });
      }
    }
    await tx.mediaObject.updateMany({
      where: { id: row.id, status: 'STAGING' },
      data: { size_bytes: BigInt(sizeBytes), destination },
    });
  });

  return { ...row, size_bytes: BigInt(sizeBytes), destination };
}
