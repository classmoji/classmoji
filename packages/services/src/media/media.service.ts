import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { tasks } from '@trigger.dev/sdk';
import { randomUUID } from 'node:crypto';
import getPrisma from '@classmoji/database';
import { REPO_REST_MAX_BYTES } from '@classmoji/utils';
// The delivery layer's own predicate, not a copy of it: "can this classroom's
// references be signed" has one definition and media must not grow a second.
// No cycle — contentDelivery reaches media through `mediaLookup.ts`, which
// imports nothing from here.
import { canServeSignedContent } from '../classmoji/contentDelivery.service.ts';
import { getProStateForClassroomId } from '../classmoji/subscription.service.ts';
import { MediaError } from './MediaError.ts';
import {
  mediaKey,
  mediaObjectPrefix,
  mediaPrefix,
  stageKey,
  stagePrefix,
  storedPosterVariant,
  storedRenditionVariant,
} from './mediaKeys.ts';
import { classifyFilename, filenameRefusal } from './mediaKinds.ts';
import {
  billedBytes,
  findMediaRow,
  liveRows,
  liveRowsWhere,
  mediaRef,
  reservationCutoff,
  toMediaRecord,
  type MediaClassroom,
  type MediaRecord,
  type MediaRow,
  type MediaStatus,
} from './mediaLookup.ts';
import {
  MAX_PARTS_PER_SIGN,
  MEDIA_QUOTA_FULL_MESSAGE,
  PART_SIZE_BYTES,
  PER_FILE_MAX_BYTES,
  partCountFor,
  quotaBytesFor,
} from './mediaQuota.ts';
import { mediaBucket } from './mediaConfig.ts';
import { r2Client } from './r2Client.ts';

/**
 * The media store: a classroom's large files, in R2 rather than in git.
 *
 * ## The shape of an upload
 *
 * Bytes never pass through this app. A Cloudflare Worker caps a request body at
 * 100 MB and a Fly machine proxying a 2 GB file would burn egress and memory
 * for nothing, so the browser PUTs directly to R2 using presigned part URLs:
 *
 *   1. `createUpload` — checks everything that can be checked before a byte
 *      moves (kind, Pro, per-file ceiling, quota), writes the row, opens the
 *      multipart upload;
 *   2. `signParts` — hands out short-lived URLs, in batches, so a 2 GB upload
 *      does not get 64 signatures it may never use;
 *   3. `completeUpload` — assembles the object, VERIFIES its size against what
 *      was declared, and only then marks the row READY.
 *
 * Each presigned URL is bound to bucket + key + uploadId + part number, so the
 * client it is handed to can write exactly one part of exactly one object and
 * nothing else. The size check at the end is what makes the quota reservation
 * honest rather than advisory: a client that declares 10 MB and uploads 2 GB
 * has its upload aborted and its row removed.
 *
 * ## The reservation is a row, and it is written under a lock
 *
 * An UPLOADING row younger than 24 hours counts against the classroom's quota,
 * so the reservation exists from the moment the upload is opened rather than
 * from the moment it finishes. That alone is not enough: two uploads opened a
 * millisecond apart would each read the free space the other had not yet
 * reserved. So `createUpload` takes a row lock on the classroom
 * (`SELECT … FOR UPDATE`) and does the SUM and the INSERT inside that one
 * transaction — the second upload waits, re-reads, and is refused.
 *
 * What the lock covers is exactly that: this classroom's own concurrent
 * creates. It is deliberately not held across the Pro lookup or any R2 call,
 * because a slow bucket must not block every upload in a course.
 *
 * What it does NOT promise is that the bytes match: the quota is honest about
 * what was DECLARED, and a client that declares 10 MB and writes 2 GB is caught
 * by `completeUpload`'s size check before the row is ever READY. An upload that
 * is abandoned rather than aborted simply stops counting when the 24-hour
 * window passes, so nothing has to sweep; R2 aborts the abandoned multipart
 * itself at 7 days.
 *
 * ## Pro is checked when an upload is OPENED, and nowhere else
 *
 * `signParts`, `completeUpload` and `deleteMedia` deliberately do not re-check
 * it: a subscription that lapses mid-upload blocks the NEXT upload, it does not
 * strand the one in flight or lock the uploader out of deleting what they
 * already have (decision, 2026-09-19).
 *
 * ## BigInt at the boundary
 *
 * `size_bytes` and `rendition_bytes` are BIGINT, so Prisma hands back `bigint`,
 * which `JSON.stringify` refuses. Every function here returns plain `number`s:
 * the per-file ceiling is 2 GB and the quota 10 GiB, both an order of
 * magnitude under `Number.MAX_SAFE_INTEGER`, so nothing is lost. The database
 * keeps the wider type because the column outlives this phase's limits.
 */

export interface MediaOptions {
  optimise?: boolean;
  keepOriginal?: boolean;
  allowDownload?: boolean;
  /**
   * A deliberate "store this in media" — Settings → Media's own Upload button,
   * which sends it for every file. Without it, a file the storage router keeps
   * in the repository (not a video, within the repository's cap) is refused
   * `USE_REPO`, so course content stays in git where it is portable. A routing
   * choice behind the teaching-team gate the route already applies, not a
   * permission.
   */
  explicit?: boolean;
}

export interface MediaUsage {
  usedBytes: number;
  quotaBytes: number;
  perFileBytes: number;
  isPro: boolean;
}

/** How long a presigned part URL lives. */
const PART_URL_TTL_SECONDS = 15 * 60;

/** The Trigger task that turns an optimisable video into a streaming rendition. */
export const VIDEO_PROCESS_TASK_ID = 'media-video-process';

/**
 * How long `onMediaReady`'s idempotency key lives. Short on purpose: the DB
 * claim is the real dedupe, and the key is only there for an immediate resend.
 */
export const VIDEO_PROCESS_IDEMPOTENCY_TTL = '10m';

/**
 * What `processing_error` says when the job could not even be queued. Shown as
 * the detail under "Couldn't optimise — the original is shown", so it is about
 * the outcome, not the machinery.
 */
export const VIDEO_ENQUEUE_FAILED_REASON = 'Optimising could not be started for this video.';

/**
 * Called once an object has become READY — by EVERY path that makes one:
 * `completeUpload` (the browser), `putMediaObject` (the slides.com import),
 * `placeIntoMedia` (an agent upload finished into media, and a URL import,
 * which places through the same function), and the class-to-class copy.
 *
 * For a VIDEO row with `optimise` set it claims the row for processing
 * (`processing` NONE → PENDING, conditional on the row still READY) and
 * enqueues `media-video-process` in the same step. PENDING is a claim that a
 * job is queued, so it is written here, where that becomes true, and nowhere
 * else — a row carrying it with no job behind it shows as forever optimising.
 *
 * The claim is the dedupe: a row already PENDING, DONE or FAILED matches
 * nothing, so a double fire (a copy reused by a retried import, a concurrent
 * complete) queues nothing twice. The idempotency key only covers the gap the
 * claim cannot — a trigger whose answer was lost and is sent again moments
 * later — so it lives for `VIDEO_PROCESS_IDEMPOTENCY_TTL`, not Trigger's 30-day
 * default. A long-lived key would hand back the old, finished run to a later
 * legitimate enqueue for the same id and leave the row PENDING with no job.
 *
 * NEVER throws. The object is already READY and serving its original; the
 * caller's upload succeeded whatever happens here. A failed enqueue marks the
 * row FAILED with a short reason, and the original keeps serving.
 */
export async function onMediaReady(row: MediaRecord): Promise<void> {
  if (row.kind !== 'VIDEO' || !row.optimise || row.status !== 'READY') return;

  try {
    const { count } = await getPrisma().mediaObject.updateMany({
      where: { id: row.id, status: 'READY', processing: 'NONE' },
      data: { processing: 'PENDING', processing_error: null },
    });
    if (count === 0) return;
  } catch (error) {
    console.warn(
      `[media] Could not claim ${row.id} for optimising:`,
      error instanceof Error ? error.message : error
    );
    return;
  }

  try {
    await tasks.trigger(
      VIDEO_PROCESS_TASK_ID,
      { classroomId: row.classroomId, mediaId: row.id },
      {
        idempotencyKey: `media-video-process:${row.id}`,
        idempotencyKeyTTL: VIDEO_PROCESS_IDEMPOTENCY_TTL,
      }
    );
  } catch (error) {
    console.warn(
      `[media] Could not enqueue ${VIDEO_PROCESS_TASK_ID} for ${row.id}:`,
      error instanceof Error ? error.message : error
    );
    // Only from the claim this call made: a job that did start (the trigger's
    // answer was lost) and already moved the row on is not overwritten.
    try {
      await getPrisma().mediaObject.updateMany({
        where: { id: row.id, processing: 'PENDING' },
        data: { processing: 'FAILED', processing_error: VIDEO_ENQUEUE_FAILED_REASON },
      });
    } catch (writeError) {
      console.warn(
        `[media] Could not record the failed enqueue for ${row.id}:`,
        writeError instanceof Error ? writeError.message : writeError
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How much of a classroom's quota is used, and what the quota is.
 *
 * A SUM over rows, never a counter column: every path that fails mid-upload
 * would otherwise have to decrement correctly, and one that forgot would leak
 * quota nobody could reclaim without a manual fix.
 */
export async function usage(classroom: MediaClassroom): Promise<MediaUsage> {
  const [{ isPro }, rows] = await Promise.all([
    getProStateForClassroomId(classroom.id),
    liveRows(classroom.id),
  ]);

  return {
    usedBytes: rows.reduce((total, row) => total + billedBytes(row), 0),
    quotaBytes: quotaBytesFor(isPro),
    perFileBytes: PER_FILE_MAX_BYTES,
    isPro,
  };
}

/**
 * The classroom's media, newest first.
 *
 * READY rows and the browser uploads still inside their window — the set the
 * quota is summed over, minus one kind of reservation: an agent upload waiting
 * to be placed (STAGING). Those count against the quota exactly like an
 * UPLOADING row (see `liveRowsWhere`), but they are not media yet — most of
 * them are on their way into the course repository — and a row the Settings
 * list showed would offer a delete for bytes the placement is about to move.
 * Abandoned reservations age out of the meter and the list together.
 */
export async function listMedia(classroom: MediaClassroom): Promise<MediaRecord[]> {
  const rows = await liveRows(classroom.id);
  return rows.filter(row => row.status !== 'STAGING').map(toMediaRecord);
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The R2 client and bucket, or the refusal.
 *
 * Every write starts here, which is what makes `NOT_CONFIGURED` the first thing
 * a caller can be told: a deployment with no bucket has the feature off, and
 * saying so beats failing later with a signature error about credentials that
 * were never set. Returning a non-nullable client is the point — the callers
 * below never have to assert it away.
 */
export function requireClient(): { client: S3Client; bucket: string } {
  const client = r2Client();
  const bucket = mediaBucket();
  if (!client || !bucket) {
    throw new MediaError('NOT_CONFIGURED', 'Media storage is not configured on this deployment');
  }
  return { client, bucket };
}

/**
 * Every check `createUpload` makes, and the reservation, in its fixed order —
 * shared with `putMediaObject`, the server-side single-shot write, so the two
 * doors into media cannot disagree about who may store what. See
 * `createUpload` for the order and why it is the contract.
 *
 * Returns the minted id, the `orig.{ext}` key it will be written at, and the
 * classification. The row is UPLOADING — a reservation counted by the quota.
 */
async function reserveUpload({
  classroom,
  userId,
  filename,
  sizeBytes,
  options,
}: {
  classroom: MediaClassroom;
  userId: string;
  filename: string;
  sizeBytes: number;
  options: MediaOptions;
}): Promise<{
  mediaId: string;
  key: string;
  classified: NonNullable<ReturnType<typeof classifyFilename>>;
}> {
  // Any extension, as long as there is one the store can address (see
  // mediaKinds.ts). The refusal says which of the two it was.
  const classified = classifyFilename(filename);
  if (!classified) {
    throw new MediaError(
      'KIND_NOT_ALLOWED',
      filenameRefusal(filename) ?? `This file cannot be uploaded: ${filename}`
    );
  }

  // The storage router's rule (§7.10): media is for video and for what the
  // repository cannot take. A small non-video file belongs in the repository —
  // unless the uploader said, from Settings → Media, that it goes here.
  // Before Pro: this is about WHERE the file goes, true for every classroom.
  if (
    !options.explicit &&
    classified.kind !== 'VIDEO' &&
    Number.isSafeInteger(sizeBytes) &&
    sizeBytes > 0 &&
    sizeBytes <= REPO_REST_MAX_BYTES
  ) {
    throw new MediaError(
      'USE_REPO',
      'This file is stored in the course repository, not in media storage.'
    );
  }

  // Pro before the numbers: a classroom that cannot store media at all should
  // hear that, not a sentence about a file being over a limit it would still be
  // over at one byte.
  const { isPro } = await getProStateForClassroomId(classroom.id);
  if (!isPro) {
    throw new MediaError('PRO_REQUIRED', 'Media storage requires a Pro subscription');
  }
  const quotaBytes = quotaBytesFor(isPro);

  // Media is SERVED only through the delivery Worker — there is no legacy path
  // for a `media://` reference the way there is for a repo path, so a classroom
  // the layer cannot sign for would store bytes that render as a `/missing/`
  // placeholder and nothing else. Refused at the door rather than discovered
  // after a 2 GB upload.
  const deliverable = await getPrisma().classroom.findUnique({
    where: { id: classroom.id },
    select: {
      content_delivery_enabled: true,
      content_repo: true,
      git_organization: {
        select: { login: true, provider: true, github_installation_id: true },
      },
    },
  });
  // The deployment half too: R2 credentials without the signing secret and the
  // delivery origin would store bytes nothing can mint a URL for.
  if (!canServeSignedContent(deliverable)) {
    throw new MediaError(
      'DELIVERY_REQUIRED',
      'Media uploads need content delivery, which this class cannot use yet'
    );
  }

  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new MediaError('FILE_TOO_LARGE', 'A file size in bytes is required');
  }
  if (sizeBytes > PER_FILE_MAX_BYTES) {
    throw new MediaError('FILE_TOO_LARGE', 'This file is larger than the per-file limit');
  }

  // Video-only options. For any other kind they are stored at fixed values and
  // nothing reads them, so an uploader cannot mark a PDF for transcoding.
  //
  // `allowDownload` is fixed TRUE for everything but video. The setting exists
  // for a lecture recording the instructor wants watched, not saved; a PDF, a
  // zip or a deck IS the file a student came for, and there is no player to
  // fall back on. `mediaDownloadUrl` applies the same rule on the read side.
  //
  // `keepOriginal` is forced true whenever `optimise` is off, and that is not a
  // default but an invariant: dropping the original is only meaningful once a
  // rendition has replaced it, so "do not transcode, and delete the only copy"
  // is a request to delete the file. The dialog disables the checkbox for the
  // same reason; this is the end that has to hold when something else asks.
  const isVideo = classified.kind === 'VIDEO';
  const optimise = isVideo ? options.optimise !== false : false;
  const keepOriginal = isVideo && optimise ? options.keepOriginal !== false : true;
  const allowDownload = isVideo ? options.allowDownload === true : true;

  // The id is minted HERE rather than by the database, so the R2 key can be
  // built — and validated — before anything is written. `mediaKey` asserts
  // every part of the string it produces, and a refusal after the INSERT would
  // leave a reservation the classroom pays for with no upload behind it.
  const mediaId = randomUUID();
  const key = mediaKey(classroom.id, mediaId, `orig.${classified.ext}`);

  // The sum and the insert it authorizes must see the same state, so they run
  // in ONE transaction behind a row lock on the classroom. Two uploads opened a
  // millisecond apart serialize on that lock and the second one counts the
  // reservation the first one left behind; without it they both read the same
  // free space and both fit into it.
  //
  // Nothing slow is inside: no R2 call, no subscription lookup. The lock is
  // held for one SELECT and one INSERT, because it blocks every other upload
  // this classroom is opening.
  await getPrisma().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM classrooms WHERE id = ${classroom.id} FOR UPDATE`;

    const rows = (await tx.mediaObject.findMany({
      where: liveRowsWhere(classroom.id),
    })) as MediaRow[];
    const usedBytes = rows.reduce((total, live) => total + billedBytes(live), 0);

    if (usedBytes + sizeBytes > quotaBytes) {
      throw new MediaError('QUOTA_EXCEEDED', MEDIA_QUOTA_FULL_MESSAGE, { usedBytes, quotaBytes });
    }

    return tx.mediaObject.create({
      data: {
        id: mediaId,
        classroom_id: classroom.id,
        kind: classified.kind,
        filename,
        ext: classified.ext,
        content_type: classified.contentType,
        size_bytes: BigInt(sizeBytes),
        uploaded_by: userId,
        optimise,
        keep_original: keepOriginal,
        allow_download: allowDownload,
      },
    });
  });

  return { mediaId, key, classified };
}

/**
 * Open an upload: everything that can be refused is refused before a byte moves.
 *
 * The ORDER of the checks is deliberate and is the contract:
 *
 *   1. configured — no credentials means the feature is off, not that this file
 *      is wrong, and saying so first keeps a dev laptop's error honest;
 *   2. extension — any, as long as there is one the store can address; it
 *      decides the kind and fixes the content type;
 *   2½. routing — a non-video file within the repository's cap is refused
 *      `USE_REPO` unless the upload is `explicit` (see `MediaOptions`);
 *   3. Pro — before the numbers, so a free classroom is told it needs Pro
 *      rather than that it is 2 GB over a quota of zero;
 *   4. delivery — a classroom whose references cannot be signed has nowhere to
 *      serve the object from, and finding that out after the bytes have moved
 *      is the expensive way to learn it;
 *   5. per-file ceiling — independent of how much room is left;
 *   6. quota — last, because it is the only one that depends on other rows.
 *
 * The row is written BEFORE the multipart is opened, and that is what the quota
 * reserves against. The quota SUM and that INSERT share one transaction behind
 * a `FOR UPDATE` lock on the classroom, so concurrent creates serialize; see
 * the file header. If `CreateMultipartUpload` then fails there is a row with no
 * upload behind it; it is deleted here, and were that delete to fail too the
 * row ages out of the reservation window on its own.
 *
 * ## The content type is decided here, from the extension
 *
 * Never from `file.type`, which is whatever the uploader's OS guessed and is
 * attacker-controlled in any case. It is set on `CreateMultipartUpload`, so R2
 * stores it as the object's `httpMetadata` and the Worker answers with it — the
 * Worker holds no allowlist of its own, which is exactly why this end must not
 * pass a client value through. It is also returned, because the upload client
 * puts it on the part requests.
 */
export async function createUpload({
  classroom,
  userId,
  filename,
  sizeBytes,
  options = {},
}: {
  classroom: MediaClassroom;
  userId: string;
  filename: string;
  sizeBytes: number;
  options?: MediaOptions;
}): Promise<{
  mediaId: string;
  uploadId: string;
  contentType: string;
  partSize: number;
  partCount: number;
}> {
  const { client, bucket } = requireClient();

  const { mediaId, key, classified } = await reserveUpload({
    classroom,
    userId,
    filename,
    sizeBytes,
    options,
  });

  let uploadId: string | undefined;
  try {
    const created = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: classified.contentType,
      })
    );
    uploadId = created.UploadId;
  } catch (error) {
    await getPrisma().mediaObject.delete({ where: { id: mediaId } });
    throw error;
  }

  if (!uploadId) {
    await getPrisma().mediaObject.delete({ where: { id: mediaId } });
    throw new MediaError('BAD_STATE', 'R2 did not return an upload id');
  }

  await getPrisma().mediaObject.update({
    where: { id: mediaId },
    data: { upload_id: uploadId },
  });

  return {
    mediaId,
    uploadId,
    contentType: classified.contentType,
    partSize: PART_SIZE_BYTES,
    partCount: partCountFor(sizeBytes),
  };
}

/**
 * The row an in-flight upload operation needs, or the matching refusal.
 *
 * The return type carries the narrowing: an UPLOADING row always has an
 * `upload_id`, so every caller below can use it without asserting.
 */
async function uploadingRow(
  classroom: MediaClassroom,
  mediaId: string
): Promise<MediaRow & { upload_id: string }> {
  const row = await findMediaRow(classroom.id, mediaId);
  if (!row) throw new MediaError('NOT_FOUND', 'No such media object');
  if (row.status !== 'UPLOADING' || !row.upload_id) {
    throw new MediaError('BAD_STATE', 'This upload is not open');
  }
  return row as MediaRow & { upload_id: string };
}

/**
 * Refuse — and cancel — an open upload whose reservation has lapsed.
 *
 * An UPLOADING row stops counting against the quota once it is older than
 * `RESERVATION_WINDOW_MS`, which is what lets an abandoned upload free its
 * bytes without a sweep. The other half of that rule is here: a row outside the
 * window must not be allowed to go on and finish, or the bytes it stores would
 * be ones no reservation ever covered, and waiting out the window would be a
 * way to fit two files into the room for one.
 *
 * So `signParts` and `completeUpload` both ask this first. The multipart is
 * aborted (best effort — R2 expires it on its own at 7 days if this fails) and
 * the row tombstoned, conditionally, in that order: `markDeleted` clears the
 * upload id the abort needs. The caller is told `UPLOAD_EXPIRED`, which the
 * client treats as terminal.
 *
 * `abortUpload` does not ask: cancelling a lapsed upload is exactly what should
 * happen to it, and refusing to would leave its parts in the bucket.
 */
export async function refuseIfExpired(
  client: S3Client,
  bucket: string,
  classroom: MediaClassroom,
  row: MediaRow,
  now: number = Date.now()
): Promise<void> {
  if (row.created_at.getTime() >= reservationCutoff(now).getTime()) return;

  if (row.status === 'STAGING') {
    // An agent upload: its bytes (or its open multipart, for a URL import
    // still streaming) live under `stage/`, not `m/`. The staged object is
    // deleted as well as any multipart aborted — a single presigned PUT has no
    // multipart to abort, and its object would otherwise wait for the bucket's
    // `stage/` lifecycle rule.
    const key = stageKey(classroom.id, row.id);
    if (row.upload_id) await abortQuietly(client, bucket, key, row.upload_id);
    if (await markDeleted(row.id, 'STAGING')) {
      await deleteObjectsQuietly(client, bucket, [key]);
    }
    throw new MediaError(
      'UPLOAD_EXPIRED',
      'This upload was not finished in time and has been cancelled. Start it again.'
    );
  }

  if (!row.upload_id) return;
  const key = mediaKey(classroom.id, row.id, `orig.${row.ext}`);
  await abortQuietly(client, bucket, key, row.upload_id);
  await markDeleted(row.id, 'UPLOADING');
  throw new MediaError(
    'UPLOAD_EXPIRED',
    'This upload took too long and has been cancelled. Start it again.'
  );
}

/**
 * The exact byte count of one part of a file of `sizeBytes`.
 *
 * Every part is `PART_SIZE_BYTES` except the last, which is whatever is left —
 * the same slicing the upload client does. A file that is an exact multiple of
 * the part size has a FULL last part, never an empty one.
 */
export function partLengthFor(sizeBytes: number, partNumber: number): number {
  const partCount = partCountFor(sizeBytes);
  if (partNumber < partCount) return PART_SIZE_BYTES;
  return sizeBytes - (partCount - 1) * PART_SIZE_BYTES;
}

/**
 * Presigned `UploadPart` URLs for a batch of part numbers.
 *
 * Batched rather than all at once because a 2 GB upload is 64 parts and the
 * client only needs the next few; a URL minted now and used in forty minutes
 * has expired, and a URL never used was signing work nobody wanted. Fifteen
 * minutes is long enough for a slow part and short enough that a leaked URL is
 * a write to one part of one object for a quarter of an hour.
 *
 * ## A part number is bounded by the DECLARED size, not by S3's ceiling
 *
 * The declaration is what the quota reserved against, and `partCountFor` is
 * exactly how many 32 MiB parts that many bytes take. Signing part 500 of a
 * 1 MB upload would hand out a write for bytes the reservation never covered:
 * `completeUpload` would catch the resulting object at `HeadObject` and delete
 * it, but only after the parts had been stored. Refusing here is the cheaper
 * and more honest half of the same rule — a client asking for a part its own
 * file cannot have is confused about its own upload.
 */
export async function signParts({
  classroom,
  mediaId,
  partNumbers,
}: {
  classroom: MediaClassroom;
  mediaId: string;
  partNumbers: number[];
}): Promise<{ urls: { partNumber: number; url: string; expiresAt: string }[] }> {
  const { client, bucket } = requireClient();
  const row = await uploadingRow(classroom, mediaId);
  await refuseIfExpired(client, bucket, classroom, row);

  const wanted = [...new Set(partNumbers)];
  if (wanted.length === 0 || wanted.length > MAX_PARTS_PER_SIGN) {
    throw new MediaError(
      'BAD_STATE',
      `Ask for between 1 and ${MAX_PARTS_PER_SIGN} part numbers at a time`
    );
  }

  // Every part this file can have, and no more: a 1 MB upload has one part, so
  // part 2 is not "past the end", it is a request to write bytes nothing
  // reserved. Refused rather than filtered out, so a client with an off-by-one
  // hears about it instead of silently getting a shorter list back.
  const lastPart = partCountFor(Number(row.size_bytes));
  if (wanted.some(part => !Number.isSafeInteger(part) || part < 1 || part > lastPart)) {
    throw new MediaError('BAD_STATE', `Part numbers for this upload run from 1 to ${lastPart}`);
  }

  const key = mediaKey(classroom.id, row.id, `orig.${row.ext}`);
  const expiresAt = new Date(Date.now() + PART_URL_TTL_SECONDS * 1000).toISOString();
  const declared = Number(row.size_bytes);

  // Each URL is signed for an exact `Content-Length`: the full part size for
  // every part but the last, and the remainder for the last. The length is
  // part of the signature, so a PUT carrying more (or fewer) bytes than that is
  // refused by R2 before it is stored — the parts can only add up to the size
  // the quota reserved. `completeUpload`'s size check still runs; this makes it
  // a formality rather than the only line.
  //
  // `signableHeaders` names it explicitly. The presigner signs a
  // `content-length` it finds on the request today, but that is its default
  // rather than its contract, and this is the header the whole rule rests on.
  const urls = await Promise.all(
    wanted.map(async partNumber => ({
      partNumber,
      url: await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: row.upload_id,
          PartNumber: partNumber,
          ContentLength: partLengthFor(declared, partNumber),
        }),
        { expiresIn: PART_URL_TTL_SECONDS, signableHeaders: new Set(['content-length']) }
      ),
      expiresAt,
    }))
  );

  return { urls };
}

/** Abort the multipart without letting a failure there hide the real error. */
export async function abortQuietly(
  client: S3Client,
  bucket: string,
  key: string,
  uploadId: string
): Promise<void> {
  try {
    await client.send(
      new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })
    );
  } catch (error) {
    console.warn('[media] Could not abort multipart upload:', error);
  }
}

/**
 * Delete objects one key at a time, and never let one failure stop the rest.
 *
 * Every caller here has ALREADY tombstoned the row, which is the ordering that
 * matters: a row that still says READY while its bytes are gone renders as a
 * broken file forever, where a tombstoned row whose bytes survive is an orphan
 * in the bucket — invisible, uncharged, and findable later. So a failed delete
 * is logged and the next key is tried, rather than throwing and leaving the
 * remaining two untouched.
 */
export async function deleteObjectsQuietly(
  client: S3Client,
  bucket: string,
  keys: string[]
): Promise<void> {
  for (const key of keys) {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      console.warn(
        `[media] Could not delete ${key}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
}

/**
 * Tombstone a row, but ONLY from the status the caller believed it was in.
 *
 * Every tombstone here is written after something else failed, and a failure
 * path is exactly where a stale view of the row is likely: a `complete` whose
 * response was lost is retried, R2 answers the second one `NoSuchUpload`
 * because the first one finished the object, and an unconditional write would
 * then un-READY a file that exists and is being served. `updateMany` with the
 * expected status in the WHERE makes that a no-op instead — the row moved on,
 * so this call's conclusion about it is out of date and must not land.
 *
 * Returns whether it landed, so a caller that cares can tell "I tombstoned it"
 * from "somebody else got there first".
 */
export async function markDeleted(
  mediaId: string,
  expected: MediaStatus | MediaStatus[]
): Promise<boolean> {
  const { count } = await getPrisma().mediaObject.updateMany({
    where: {
      id: mediaId,
      status: Array.isArray(expected) ? { in: expected } : expected,
    },
    data: { status: 'DELETED', deleted_at: new Date(), upload_id: null },
  });
  return count > 0;
}

/**
 * Assemble the object, verify its size, and only then call it READY.
 *
 * The verification is what makes the quota real. Everything before this point
 * trusts a number the client declared: the reservation, the per-file check, the
 * remaining-space arithmetic. `HeadObject` is the first moment the app learns
 * what was actually written, and a mismatch means every one of those decisions
 * was made against a false premise — so the row is marked DELETED (only from
 * UPLOADING), the object is deleted once that tombstone has landed, and the
 * caller is told. Not rounded down to a warning: a client that can overrun its
 * declaration can fill the bucket. A tombstone that does NOT land means another
 * call moved the row first. Moved to READY, the bytes are left alone: that row
 * is serving them, and that finished upload is this caller's answer too. Moved
 * to DELETED, they are deleted anyway — nothing can ever serve them again.
 *
 * A `HeadObject` that FAILS is the same outcome, not a lesser one. Letting the
 * error escape would leave a verified-by-nobody object in the bucket behind an
 * UPLOADING row that ages out of the quota in a day — bytes paid for, billed to
 * no one, reachable by nothing. One retry (R2 is briefly-unavailable far more
 * often than it is wrong), and then the object is discarded exactly as a
 * mismatch is.
 *
 * ## The ETag contract, in one direction
 *
 * S3 returns a part's ETag QUOTED (`"a1b2…"`), `CompleteMultipartUpload` wants
 * it back quoted, and a browser reading the `ETag` response header gets the
 * quotes too. So an etag travels through here VERBATIM — collected by the
 * client, posted as a string, handed to the SDK unchanged. `normalizeEtag`
 * re-adds the quotes for a client that stripped them rather than guessing which
 * convention arrived, because the two shapes are distinguishable and a
 * half-stripped one is not a thing S3 ever produces.
 */

/**
 * An etag as `CompleteMultipartUpload` wants it: quoted.
 *
 * Idempotent, so the common path (the browser's `ETag` header, quotes intact)
 * passes through untouched.
 */
function normalizeEtag(etag: string): string {
  const trimmed = etag.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed : `"${trimmed}"`;
}

/** How many times the size check asks R2 before giving up on the object. */
const HEAD_ATTEMPTS = 2;

/**
 * The pause between the two size checks.
 *
 * The retry is for a blip, and a blip needs a moment to pass: a second
 * `HeadObject` issued in the same tick as the first asks the same overloaded
 * node the same question and gets the same answer. Short enough that a user
 * waiting on `complete` does not notice, long enough to be a different moment.
 */
const HEAD_RETRY_DELAY_MS = 250;

/**
 * The assembled object's size, or null when R2 would not say.
 *
 * Retried once and no more: the failure this covers is a blip between the
 * complete and the head, and a request that fails twice in a row is not one
 * more attempt away from succeeding. Null rather than a throw, because the
 * caller's answer to "I cannot verify this" is the same cleanup as "this is the
 * wrong size" and the difference belongs in the error code, not in control flow.
 *
 * A reply with NO `ContentLength` is one of those failures, not a size. It used
 * to become `-1`, which is a number, so the caller compared it to the declared
 * bytes and reported SIZE_MISMATCH — "you uploaded -1 bytes" — for an object
 * nobody had managed to measure. Unverified is unverified: it falls through to
 * the retry and then to null, and the caller says VERIFY_FAILED.
 */
export async function verifiedSize(
  client: S3Client,
  bucket: string,
  key: string
): Promise<number | null> {
  for (let attempt = 1; attempt <= HEAD_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await new Promise(resolve => setTimeout(resolve, HEAD_RETRY_DELAY_MS));
    }
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (typeof head.ContentLength === 'number' && Number.isFinite(head.ContentLength)) {
        return head.ContentLength;
      }
      console.warn(`[media] Read back ${key} with no size (attempt ${attempt}/${HEAD_ATTEMPTS})`);
    } catch (error) {
      console.warn(
        `[media] Could not read back ${key} (attempt ${attempt}/${HEAD_ATTEMPTS}):`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return null;
}

/** What a finished upload answers with — the same shape however it was reached. */
function completedResult(row: MediaRow): { mediaId: string; ref: string; sizeBytes: number } {
  return { mediaId: row.id, ref: mediaRef(row.id), sizeBytes: Number(row.size_bytes) };
}

/**
 * Whether another call already finished this upload, read fresh.
 *
 * The question every lost race in `completeUpload` comes down to: a conditional
 * write that matched nothing means the row moved, and the one move that makes
 * this call's work redundant rather than wrong is to READY.
 */
async function finishedElsewhere(classroom: MediaClassroom, mediaId: string) {
  const fresh = await findMediaRow(classroom.id, mediaId);
  return fresh?.status === 'READY' ? fresh : null;
}

/** The pause before the one retry of a Complete that R2 answered with a 5xx. */
const COMPLETE_RETRY_DELAY_MS = 500;

/** R2 answered with a server-side failure — worth exactly one more try. */
function isTransientR2Error(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
    ?.httpStatusCode;
  if (typeof status === 'number') return status >= 500 && status <= 599;
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'InternalError' || name === 'ServiceUnavailable' || name === 'SlowDown';
}

/** The multipart is gone — completed (or aborted) by an earlier request. */
function isNoSuchUpload(error: unknown): boolean {
  const e = error as { name?: unknown; Code?: unknown } | null;
  return e?.name === 'NoSuchUpload' || e?.Code === 'NoSuchUpload';
}

/**
 * `CompleteMultipartUpload`, retried ONCE when R2 answers with a 5xx.
 *
 * Without the retry, one transient failure at the very last step threw away a
 * whole upload — the error path aborts the multipart and tombstones the row, so
 * a 2 GB lecture that R2 hiccupped on had to be sent again from the start.
 *
 * Only a 5xx is retried. A 4xx (`InvalidPart`, a bad etag, `EntityTooSmall`) is
 * the request being wrong, and asking again changes nothing. `NoSuchUpload` is
 * never retried either — it is the "finished elsewhere" answer the caller's
 * error path already knows how to read.
 *
 * The one subtle case: the FIRST attempt can succeed on R2's side and still
 * reach us as a 5xx (the answer was lost). The retry then meets a multipart that
 * no longer exists and gets `NoSuchUpload`. That is treated as success here and
 * handed to the size check that runs next: if the assembled object is there and
 * the right size, the upload finished; if it is not (a concurrent abort got
 * there instead), the size check discards it exactly as it would any other
 * object it cannot verify.
 */
async function assembleWithOneRetry(assemble: () => Promise<unknown>): Promise<void> {
  try {
    await assemble();
    return;
  } catch (error) {
    if (!isTransientR2Error(error)) throw error;
    console.warn(
      '[media] Complete failed with a server error; retrying once:',
      error instanceof Error ? error.message : error
    );
  }
  await new Promise(resolve => setTimeout(resolve, COMPLETE_RETRY_DELAY_MS));
  try {
    await assemble();
  } catch (retryError) {
    if (isNoSuchUpload(retryError)) return;
    throw retryError;
  }
}

export async function completeUpload({
  classroom,
  mediaId,
  parts,
}: {
  classroom: MediaClassroom;
  mediaId: string;
  parts: { partNumber: number; etag: string }[];
}): Promise<{ mediaId: string; ref: string; sizeBytes: number }> {
  const { client, bucket } = requireClient();

  // Idempotent by status, before anything touches R2. A complete whose
  // response was lost is retried by a client that cannot know it succeeded;
  // answering the retry with the same result is what keeps that client from
  // concluding the upload failed and cleaning up a file that exists. A DELETED
  // row is gone as far as this caller is concerned — cancelled, expired or
  // deleted — and gets the same answer as an id that was never issued.
  const current = await findMediaRow(classroom.id, mediaId);
  if (!current || current.status === 'DELETED') {
    throw new MediaError('NOT_FOUND', 'No such media object');
  }
  if (current.status === 'READY') return completedResult(current);
  // Positive, not "has an upload id": an agent upload (STAGING) can carry a
  // multipart id too — a URL import streams through one — and it is finished by
  // its own placement, never by this browser-upload call.
  if (current.status !== 'UPLOADING' || !current.upload_id) {
    throw new MediaError('BAD_STATE', 'This upload is not open');
  }

  const row = current as MediaRow & { upload_id: string };
  await refuseIfExpired(client, bucket, classroom, row);

  const key = mediaKey(classroom.id, row.id, `orig.${row.ext}`);
  const uploadId = row.upload_id;

  // S3 requires the parts in ascending order and will reject the whole
  // assembly otherwise — a client that collected them as they finished has
  // them in completion order, which is not the same thing.
  const ordered = [...parts]
    .filter(
      part =>
        Number.isSafeInteger(part?.partNumber) &&
        typeof part?.etag === 'string' &&
        part.etag.trim().length > 0
    )
    .sort((a, b) => a.partNumber - b.partNumber);
  if (ordered.length === 0) {
    throw new MediaError('BAD_STATE', 'No parts were supplied');
  }

  const assemble = () =>
    client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: ordered.map(part => ({
            PartNumber: part.partNumber,
            ETag: normalizeEtag(part.etag),
          })),
        },
      })
    );

  try {
    await assembleWithOneRetry(assemble);
  } catch (error) {
    await abortQuietly(client, bucket, key, uploadId);
    // Only from UPLOADING. If the tombstone does not land, the row moved while
    // this call was assembling — and when it moved to READY, a concurrent
    // complete of the same upload finished it (R2 then answers this one
    // `NoSuchUpload`). That is success from the caller's point of view, and the
    // object at `key` is that upload's file, so it is left alone. A row that
    // went DELETED was cancelled underneath us, and a DELETED row never becomes
    // READY again, so whatever this call assembled can never be served: it is
    // deleted here, because an abort only cancels the multipart and would leave
    // an assembled object behind with nothing to bill or find it.
    if (!(await markDeleted(row.id, 'UPLOADING'))) {
      const done = await finishedElsewhere(classroom, row.id);
      if (done) return completedResult(done);
      await deleteObjectsQuietly(client, bucket, [key]);
      throw new MediaError('NOT_FOUND', 'This upload was cancelled before it finished');
    }
    // The tombstone landed, so nothing will ever serve this key. A complete
    // that errored (a timeout, a dropped connection) may still have assembled
    // the object on R2's side, and with the row DELETED nothing would bill it
    // or find it again. R2 answers a delete of a missing key with success.
    await deleteObjectsQuietly(client, bucket, [key]);
    throw error;
  }

  const actual = await verifiedSize(client, bucket, key);
  const declared = Number(row.size_bytes);

  if (actual === null || actual !== declared) {
    // Row first, then the bytes: see `deleteObjectsQuietly`. And the bytes ONLY
    // if the tombstone landed. A concurrent complete of the same upload writes
    // to the same key, and when it has already made the row READY this call's
    // R2 request was a replay of a finished upload — the object it failed to
    // measure is the file the READY row serves, and deleting it would break
    // that file everywhere it is referenced. A row that went DELETED under us
    // was cancelled, and a DELETED row never becomes READY again, so the bytes
    // can never be served and go now — the same as the cancelled branch after
    // the READY write below.
    if (!(await markDeleted(row.id, 'UPLOADING'))) {
      const done = await finishedElsewhere(classroom, row.id);
      if (done) return completedResult(done);
      await deleteObjectsQuietly(client, bucket, [key]);
      throw new MediaError('NOT_FOUND', 'This upload was cancelled before it finished');
    }
    await deleteObjectsQuietly(client, bucket, [key]);
    if (actual === null) {
      throw new MediaError(
        'VERIFY_FAILED',
        'The upload could not be verified and has been discarded; please try again'
      );
    }
    throw new MediaError('SIZE_MISMATCH', `Uploaded ${actual} bytes but ${declared} were declared`);
  }

  // READY only FROM UPLOADING. Between the read above and here the row can
  // have been cancelled (an abort racing this complete) or finished by a
  // concurrent complete; an unconditional write would resurrect the first and
  // double-fire `onMediaReady` for the second.
  const readyAt = new Date();
  const { count } = await getPrisma().mediaObject.updateMany({
    where: { id: row.id, status: 'UPLOADING' },
    data: {
      status: 'READY',
      ready_at: readyAt,
      upload_id: null,
      // NONE, even for a row that asked to be optimised. PENDING means "a job
      // is queued", and in P1 there is no job — a row parked in PENDING is one
      // the admin page shows as processing forever and one a later sweep would
      // have to unstick. P2's `onMediaReady` sets PENDING at the moment it
      // enqueues, which is the only moment the claim is true.
      processing: 'NONE',
    },
  });

  if (count === 0) {
    const done = await finishedElsewhere(classroom, row.id);
    if (done) return completedResult(done);
    // Cancelled underneath us: the object was assembled for a row that no
    // longer exists, so nothing will ever serve it, bill it or delete it. It
    // goes now, and the caller hears what an abort would have told them.
    await deleteObjectsQuietly(client, bucket, [key]);
    throw new MediaError('NOT_FOUND', 'This upload was cancelled before it finished');
  }

  const ready: MediaRow = {
    ...row,
    status: 'READY',
    ready_at: readyAt,
    upload_id: null,
    processing: 'NONE',
  };
  await onMediaReady(toMediaRecord(ready));

  return completedResult(ready);
}

/**
 * The row, unless it is an agent upload still STAGING that `userId` did not
 * open — then null, which the callers answer NOT_FOUND.
 *
 * A stage is its uploader's until it is placed: `file_upload_finish` and
 * `file_upload_status` are already bound to them (`ownStagedRow`), and a
 * cancel or delete must not be the way around that for another member of the
 * teaching team. Every other status is a classroom resource, as before — an
 * UPLOADING browser upload included, so the web abort route is unchanged.
 */
function stagedRowOf(row: MediaRow | null, userId: string | null | undefined): MediaRow | null {
  if (!row) return null;
  if (row.status === 'STAGING' && (!userId || row.uploaded_by !== userId)) return null;
  return row;
}

/**
 * Cancel an upload in flight — the client's own "stop" button, and the upload
 * client's cleanup after any failure.
 *
 * Acts ONLY on an UPLOADING row, and is a quiet no-op on anything else:
 * "cancel the upload" and "delete the file" are different intentions, and one
 * standing in for the other would turn a stray abort into data loss. That
 * matters most for the client's cleanup, which runs after a failure it cannot
 * always see the bottom of — a `complete` whose response was lost looks like a
 * failure from the browser while the file is READY on this side. An abort then
 * must leave the file alone, which is why the client calls this and never
 * `deleteMedia`.
 *
 * A READY or DELETED row answers `{ aborted: false }` rather than an error:
 * there is nothing to cancel, and a cleanup call that failed noisily would only
 * be ignored. An unknown id is still NOT_FOUND.
 */
export async function abortUpload({
  classroom,
  mediaId,
  userId,
}: {
  classroom: MediaClassroom;
  mediaId: string;
  /** The caller. Required to touch an agent upload still STAGING — see `stagedRowOf`. */
  userId?: string | null;
}): Promise<{ mediaId: string; aborted: boolean }> {
  const { client, bucket } = requireClient();
  const row = stagedRowOf(await findMediaRow(classroom.id, mediaId), userId);
  if (!row) throw new MediaError('NOT_FOUND', 'No such media object');

  // An agent upload not yet placed: cancelling it removes the staged bytes.
  // Only from STAGING, so a placement that finished first (READY, or a repo
  // placement already tombstoned with its `placed_ref`) is never undone.
  if (row.status === 'STAGING') {
    const staged = stageKey(classroom.id, row.id);
    if (row.upload_id) await abortQuietly(client, bucket, staged, row.upload_id);
    const aborted = await markDeleted(row.id, 'STAGING');
    if (aborted) await deleteObjectsQuietly(client, bucket, [staged]);
    return { mediaId: row.id, aborted };
  }

  if (row.status !== 'UPLOADING' || !row.upload_id) return { mediaId: row.id, aborted: false };

  const key = mediaKey(classroom.id, row.id, `orig.${row.ext}`);
  await abortQuietly(client, bucket, key, row.upload_id);
  // Only from UPLOADING: a `complete` that won the race while this abort was in
  // flight has already made the row READY, and cancelling an upload must never
  // be able to delete the file that upload produced.
  const aborted = await markDeleted(row.id, 'UPLOADING');

  return { mediaId: row.id, aborted };
}

/**
 * Remove a media object: the row's tombstone, then the R2 objects.
 *
 * Hard-deleted from R2, with no retention window and nothing scheduled — there
 * is no undo, and the row's DELETED status is a tombstone for the references
 * that still point at it rather than a recovery path. Content holding
 * `media://{id}` keeps rendering; the resolver finds no READY row and hands
 * back the `/missing/` placeholder, exactly as it does for a repo path that
 * has left the repo.
 *
 * EVERY object under the row's prefix `m/{classroom}/{id}/` — listed, not
 * named — because the rendition and the poster may or may not exist depending
 * on whether the video job has run, their names are content-derived
 * (`web-{hex12}.mp4`), and a replayed job can have written a pair the row never
 * recorded. A delete that skipped any of them would leave bytes nobody can see
 * and nobody is billed for. When the listing fails, the keys the row names are
 * deleted instead (best effort, like the rest).
 *
 * Deleting an UPLOADING row aborts its multipart first: without that, R2 holds
 * the uploaded parts until its own 7-day expiry.
 *
 * ## Retryable, so idempotent
 *
 * Object deletes are best effort (`deleteObjectsQuietly`), so one can fail
 * after the row is already a tombstone. Deleting a DELETED row therefore does
 * not answer NOT_FOUND: it re-attempts the object deletes and succeeds, which
 * is what lets a half-failed delete be finished by asking again. The same goes
 * for the loser of two concurrent deletes. Only an id this classroom has never
 * had is NOT_FOUND. A tombstoned row no longer carries its multipart id, so a
 * retry cannot re-abort an upload whose first abort failed; R2's own 7-day
 * expiry of incomplete uploads covers that one.
 */
export async function deleteMedia({
  classroom,
  mediaId,
  userId,
}: {
  classroom: MediaClassroom;
  mediaId: string;
  /** The caller. Required to touch an agent upload still STAGING — see `stagedRowOf`. */
  userId?: string | null;
}): Promise<{ mediaId: string }> {
  const { client, bucket } = requireClient();
  const row = stagedRowOf(await findMediaRow(classroom.id, mediaId), userId);
  if (!row) throw new MediaError('NOT_FOUND', 'No such media object');

  const origKey = mediaKey(classroom.id, row.id, `orig.${row.ext}`);

  // The tombstone goes FIRST. It is the one write that decides what every
  // reader sees, and an R2 delete that fails halfway must not be able to leave
  // a READY row pointing at bytes that are gone — a permanently broken file in
  // every page that referenced it. Conditional, so a delete racing another one
  // does not double-tombstone; the loser simply goes on to the object deletes,
  // which are safe to repeat.
  if (row.status !== 'DELETED') {
    await markDeleted(row.id, ['UPLOADING', 'READY', 'STAGING']);
  }

  if (row.status === 'UPLOADING' && row.upload_id) {
    await abortQuietly(client, bucket, origKey, row.upload_id);
  }

  // An agent upload's bytes wait under `stage/` (a URL import may still hold a
  // multipart there). `destination` is set on every agent upload and on no
  // other row, so it says whether there can be a staged object at all — a
  // STAGING row now, or one that was STAGING before it was placed or deleted.
  const staged = row.destination !== null ? stageKey(classroom.id, row.id) : null;
  if (staged && row.status === 'STAGING' && row.upload_id) {
    await abortQuietly(client, bucket, staged, row.upload_id);
  }

  // Everything under the row's own prefix, listed rather than named: the
  // rendition and poster names are content-derived, and a replayed job whose
  // result write lost the race can have left a pair the row never recorded.
  // When the listing itself fails, the keys the row DOES name are deleted
  // instead, so a delete is never worse than it was before the listing — and
  // asking again (see "Retryable" above) lists again.
  const listed = await deletePrefixQuietly(client, bucket, mediaObjectPrefix(classroom.id, row.id));
  const named: string[] = [];
  if (!listed) {
    named.push(origKey);
    const rendition = storedRenditionVariant(row.rendition_key);
    if (rendition) named.push(mediaKey(classroom.id, row.id, rendition));
    const poster = storedPosterVariant(row.poster_key);
    if (poster) named.push(mediaKey(classroom.id, row.id, poster));
  }
  await deleteObjectsQuietly(client, bucket, [...named, ...(staged ? [staged] : [])]);

  return { mediaId: row.id };
}

/**
 * Delete every object under `prefix`, quietly. Returns false when the LISTING
 * failed (nothing is known about what is there), true otherwise — a failed
 * delete of one listed key is logged and the rest are still tried, exactly as
 * `deleteObjectsQuietly` does.
 *
 * One `DeleteObject` per key rather than a batch `DeleteObjects`: that
 * operation REQUIRES a checksum, and the modern ones the SDK sends by default
 * are not reliably supported by S3-compatible stores. A media row's prefix
 * holds a handful of keys, so the round trips are not worth that risk — the
 * classroom purge makes the same choice.
 */
export async function deletePrefixQuietly(
  client: S3Client,
  bucket: string,
  prefix: string
): Promise<boolean> {
  let continuationToken: string | undefined;
  do {
    let page;
    try {
      page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
    } catch (error) {
      console.warn(
        `[media] Could not list ${prefix}:`,
        error instanceof Error ? error.message : error
      );
      return false;
    }
    const keys = (page.Contents ?? [])
      .map(object => object.Key)
      .filter((key): key is string => typeof key === 'string' && key.startsWith(prefix));
    await deleteObjectsQuietly(client, bucket, keys);
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return true;
}

/**
 * Delete every object a classroom has in the media bucket, ahead of the
 * classroom itself being deleted.
 *
 * The rows go with the classroom (`ON DELETE CASCADE`), and once they are gone
 * nothing names these objects any more: no page can reach them, no quota bills
 * them, and no later delete will find them. So this runs BEFORE the cascade,
 * over the whole `m/{classroomId}/` prefix rather than over the rows — every
 * variant the rendition job ever wrote is under it, named in a column or not.
 *
 * Open multiparts are not objects and a listing does not show them, so the
 * UPLOADING rows' uploads are aborted first, from the ids the rows hold. One
 * that cannot be aborted is left to R2's 7-day expiry of incomplete uploads.
 *
 * A deployment with no media store has nothing to delete and returns at once,
 * and so does a classroom with no media rows in any status, without asking R2.
 * A LISTING that fails throws, and the caller must not delete the classroom:
 * with the rows gone the prefix is the only record of what is there. Individual
 * object deletes that fail are counted, and a purge with failures throws too,
 * for the same reason — asking again deletes what is left.
 *
 * Returns how many objects were deleted, for the log line.
 */
export async function purgeClassroomMedia(classroomId: string): Promise<{ deleted: number }> {
  const client = r2Client();
  const bucket = mediaBucket();
  if (!client || !bucket) return { deleted: 0 };
  const prefix = mediaPrefix(classroomId);

  // A classroom that never had a row never had an object: the row is written
  // before an upload can start, and it outlives its bytes as a tombstone. So a
  // classroom with no rows at all — every Free classroom — has nothing under
  // its prefix, and asking R2 to list it would only let an R2 outage block a
  // classroom delete that has nothing to clean up.
  const anyRow = await getPrisma().mediaObject.findFirst({
    where: { classroom_id: classroomId },
    select: { id: true },
  });
  if (!anyRow) return { deleted: 0 };

  // Open multiparts are not objects, so a listing cannot see them: abort each
  // one from the id its row holds. A browser upload's is at `m/…/orig.{ext}`;
  // an agent URL import still streaming has one at its `stage/` key.
  const open = (await getPrisma().mediaObject.findMany({
    where: {
      classroom_id: classroomId,
      status: { in: ['UPLOADING', 'STAGING'] },
      upload_id: { not: null },
    },
    select: { id: true, ext: true, upload_id: true, status: true },
  })) as { id: string; ext: string; upload_id: string; status?: MediaStatus }[];
  for (const upload of open) {
    const key =
      upload.status === 'STAGING'
        ? stageKey(classroomId, upload.id)
        : mediaKey(classroomId, upload.id, `orig.${upload.ext}`);
    await abortQuietly(client, bucket, key, upload.upload_id);
  }

  let deleted = 0;
  const failed: string[] = [];
  // Both prefixes: the stored objects, and any agent upload still waiting to be
  // placed. The staged ones would expire under the bucket's lifecycle rule on
  // their own, but a deleted classroom should not leave bytes behind for a day.
  for (const listPrefix of [prefix, stagePrefix(classroomId)]) {
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: listPrefix,
          ContinuationToken: continuationToken,
        })
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
          deleted += 1;
        } catch (error) {
          failed.push(object.Key);
          console.warn(
            `[media] Could not delete ${object.Key}:`,
            error instanceof Error ? error.message : error
          );
        }
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  if (failed.length > 0) {
    throw new Error(
      `Could not delete ${failed.length} media object(s) for classroom ${classroomId}`
    );
  }
  return { deleted };
}

/**
 * Above this, `putMediaObject` writes in parts rather than one PUT. R2's single
 * PUT goes to 5 GiB, but a 2 GiB body in one request is a 2 GiB retry when a
 * connection drops, and the parts reuse the browser path's `PART_SIZE_BYTES`.
 */
export const SINGLE_PUT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Store bytes the SERVER already holds — the slides.com import's videos on Pro,
 * where the file arrived inside a ZIP rather than from a browser.
 *
 * Every rule `createUpload` applies, in the same order and from the same code
 * (`reserveUpload`): kind, `USE_REPO` unless `explicit`, Pro, delivery (the
 * deployment's signing half included), the per-file ceiling, and the quota
 * reserved under the classroom lock BEFORE a byte is written. Then one
 * `PutObject` at `m/{classroom}/{id}/orig.{ext}` with the server-assigned type
 * and the exact length — or a multipart upload in `PART_SIZE_BYTES` parts above
 * `SINGLE_PUT_MAX_BYTES` — a `HeadObject` size check, and READY only from
 * UPLOADING, exactly as `completeUpload` ends.
 *
 * A write or a verification that fails tombstones the reservation (from
 * UPLOADING only) and removes whatever may have landed, then throws — the
 * caller decides what a failed file means for its import.
 */
export async function putMediaObject({
  classroom,
  userId,
  filename,
  bytes,
  options = {},
}: {
  classroom: MediaClassroom;
  userId: string;
  filename: string;
  bytes: Buffer;
  options?: MediaOptions;
}): Promise<{ mediaId: string; ref: string }> {
  const { client, bucket } = requireClient();
  const sizeBytes = bytes.length;
  const { mediaId, key, classified } = await reserveUpload({
    classroom,
    userId,
    filename,
    sizeBytes,
    options,
  });

  try {
    if (sizeBytes <= SINGLE_PUT_MAX_BYTES) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: classified.contentType,
          ContentLength: sizeBytes,
        })
      );
    } else {
      await putInParts(client, bucket, key, mediaId, bytes, classified.contentType);
    }
  } catch (error) {
    if (await markDeleted(mediaId, 'UPLOADING')) {
      await deleteObjectsQuietly(client, bucket, [key]);
    }
    throw error;
  }

  const actual = await verifiedSize(client, bucket, key);
  if (actual !== sizeBytes) {
    if (await markDeleted(mediaId, 'UPLOADING')) {
      await deleteObjectsQuietly(client, bucket, [key]);
    }
    if (actual === null) {
      throw new MediaError('VERIFY_FAILED', 'The file could not be verified after writing it');
    }
    throw new MediaError('SIZE_MISMATCH', `Wrote ${actual} bytes but ${sizeBytes} were expected`);
  }

  const readyAt = new Date();
  let count: number;
  try {
    ({ count } = await getPrisma().mediaObject.updateMany({
      where: { id: mediaId, status: 'UPLOADING' },
      data: { status: 'READY', ready_at: readyAt, upload_id: null, processing: 'NONE' },
    }));
  } catch (error) {
    // The bytes are written and the flip to READY failed. Whether it landed is
    // asked, not assumed: a lost response looks exactly like a failed write.
    const outcome = await afterFailedReadyFlip(classroom.id, mediaId, 'UPLOADING');
    if (outcome !== 'ready') {
      if (outcome === 'released') await deleteObjectsQuietly(client, bucket, [key]);
      throw error;
    }
    count = 1;
  }
  if (count === 0) {
    // Deleted from Settings → Media while the write ran: nothing will serve it.
    await deleteObjectsQuietly(client, bucket, [key]);
    throw new MediaError('NOT_FOUND', 'This file was deleted before it finished writing');
  }

  const row = await findMediaRow(classroom.id, mediaId);
  if (row) await onMediaReady(toMediaRecord(row));
  return { mediaId, ref: mediaRef(mediaId) };
}

/**
 * What to do with bytes already written when the flip to READY threw.
 *
 *   - `'ready'`    — the flip landed after all (its response was lost): the
 *                    object is being served; keep it and carry on;
 *   - `'released'` — the row is not READY, and is now tombstoned from `from`
 *                    (or was already gone): nothing will ever serve the object,
 *                    so the caller deletes it;
 *   - `'unknown'`  — the row could not be read or tombstoned. The object is
 *                    left: deleting bytes a READY row might be serving is worse
 *                    than an orphan, which `deleteMedia` / the classroom purge
 *                    still reach through the row.
 *
 * `from: null` skips the tombstone and only answers whether the flip landed —
 * for a caller that keeps its row for a retry (an agent upload stays STAGING;
 * its staged bytes are still there to copy again).
 */
export async function afterFailedReadyFlip(
  classroomId: string,
  mediaId: string,
  from: MediaStatus | null
): Promise<'ready' | 'released' | 'unknown'> {
  let fresh: MediaRow | null;
  try {
    fresh = await findMediaRow(classroomId, mediaId);
  } catch {
    return 'unknown';
  }
  if (fresh?.status === 'READY') return 'ready';
  if (!fresh || fresh.status === 'DELETED' || from === null) return 'released';
  try {
    return (await markDeleted(mediaId, from)) ? 'released' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The multipart half of `putMediaObject`. The upload id is written onto the
 * row while it is open, so a delete or a classroom purge can abort it — the
 * same bookkeeping a browser upload has.
 */
async function putInParts(
  client: S3Client,
  bucket: string,
  key: string,
  mediaId: string,
  bytes: Buffer,
  contentType: string
): Promise<void> {
  const created = await client.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType })
  );
  const uploadId = created.UploadId;
  if (!uploadId) throw new MediaError('BAD_STATE', 'R2 did not return an upload id');
  await getPrisma().mediaObject.updateMany({
    where: { id: mediaId, status: 'UPLOADING' },
    data: { upload_id: uploadId },
  });

  try {
    const parts: { PartNumber: number; ETag: string }[] = [];
    const partCount = partCountFor(bytes.length);
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const start = (partNumber - 1) * PART_SIZE_BYTES;
      const body = bytes.subarray(start, start + partLengthFor(bytes.length, partNumber));
      const result = await client.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: body,
          ContentLength: body.length,
        })
      );
      if (!result.ETag)
        throw new MediaError('BAD_STATE', `R2 returned no etag for part ${partNumber}`);
      parts.push({ PartNumber: partNumber, ETag: result.ETag });
    }
    await assembleWithOneRetry(() =>
      client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        })
      )
    );
  } catch (error) {
    await abortQuietly(client, bucket, key, uploadId);
    throw error;
  }
}
