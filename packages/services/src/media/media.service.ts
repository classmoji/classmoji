import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import getPrisma from '@classmoji/database';
// The delivery layer's own predicate, not a copy of it: "can this classroom's
// references be signed" has one definition and media must not grow a second.
// No cycle — contentDelivery reaches media through `mediaLookup.ts`, which
// imports nothing from here.
import { canDeliverContent } from '../classmoji/contentDelivery.service.ts';
import { getProStateForClassroomId } from '../classmoji/subscription.service.ts';
import { MediaError } from './MediaError.ts';
import { mediaKey } from './mediaKeys.ts';
import { classifyFilename } from './mediaKinds.ts';
import {
  findMediaRow,
  liveRows,
  liveRowsWhere,
  toMediaRecord,
  type MediaClassroom,
  type MediaRecord,
  type MediaRow,
  type MediaStatus,
} from './mediaLookup.ts';
import {
  MAX_PARTS_PER_SIGN,
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
 * the per-file ceiling is 2 GiB and the quota 10 GiB, both an order of
 * magnitude under `Number.MAX_SAFE_INTEGER`, so nothing is lost. The database
 * keeps the wider type because the column outlives this phase's limits.
 */

export interface MediaOptions {
  optimise?: boolean;
  keepOriginal?: boolean;
  allowDownload?: boolean;
}

export interface MediaUsage {
  usedBytes: number;
  quotaBytes: number;
  perFileBytes: number;
  isPro: boolean;
}

/** How long a presigned part URL lives. */
const PART_URL_TTL_SECONDS = 15 * 60;

/**
 * Called once an upload is complete and verified.
 *
 * A no-op in phase 1. Phase 2 enqueues the `media-video-process` task here for
 * rows with `optimise` set, which is why the seam exists now: `completeUpload`
 * is the only moment that knows an object has just become real, and adding the
 * call later would mean editing the function rather than filling this in.
 *
 * Setting `processing` to PENDING belongs HERE, in the same step that enqueues
 * the job — not in `completeUpload`. PENDING is a claim that something is
 * queued, and a row that carries it with no job behind it shows as forever
 * processing on the admin page.
 */
export async function onMediaReady(_row: MediaRecord): Promise<void> {
  // Phase 2: enqueue media-video-process for VIDEO rows with `optimise`.
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What one row costs against the quota.
 *
 * The original's bytes while it is there; the rendition's once it has been
 * dropped. A row mid-processing still has its original, so it is still billed
 * for it — the job only deletes the original after the rendition is verified,
 * and the swap is a single moment rather than a window where both or neither
 * counts.
 *
 * A rendition-only row with no `rendition_bytes` recorded would read as free,
 * which cannot happen (the job writes both or neither) but falls back to the
 * original's size rather than to zero, because a quota that undercounts is the
 * failure worth avoiding.
 */
function billedBytes(row: MediaRow): number {
  if (row.original_deleted_at !== null && row.rendition_bytes !== null) {
    return Number(row.rendition_bytes);
  }
  return Number(row.size_bytes);
}

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
 * READY rows and the reservations still inside their window — the same set the
 * quota is summed over, so the meter and the list can never disagree about what
 * a classroom is holding. Abandoned reservations age out of both together.
 */
export async function listMedia(classroom: MediaClassroom): Promise<MediaRecord[]> {
  const rows = await liveRows(classroom.id);
  return rows.map(toMediaRecord);
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
function requireClient(): { client: S3Client; bucket: string } {
  const client = r2Client();
  const bucket = mediaBucket();
  if (!client || !bucket) {
    throw new MediaError('NOT_CONFIGURED', 'Media storage is not configured on this deployment');
  }
  return { client, bucket };
}

/**
 * Open an upload: everything that can be refused is refused before a byte moves.
 *
 * The ORDER of the checks is deliberate and is the contract:
 *
 *   1. configured — no credentials means the feature is off, not that this file
 *      is wrong, and saying so first keeps a dev laptop's error honest;
 *   2. kind — decided from the extension, which also fixes the content type;
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

  const classified = classifyFilename(filename);
  if (!classified) {
    throw new MediaError('KIND_NOT_ALLOWED', `Files of this type cannot be uploaded: ${filename}`);
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
  if (!canDeliverContent(deliverable)) {
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

  // Video-only options. For any other kind they are stored at their defaults
  // and nothing reads them, so an uploader cannot mark a PDF for transcoding.
  //
  // `keepOriginal` is forced true whenever `optimise` is off, and that is not a
  // default but an invariant: dropping the original is only meaningful once a
  // rendition has replaced it, so "do not transcode, and delete the only copy"
  // is a request to delete the file. The dialog disables the checkbox for the
  // same reason; this is the end that has to hold when something else asks.
  const isVideo = classified.kind === 'VIDEO';
  const optimise = isVideo ? options.optimise !== false : false;
  const keepOriginal = isVideo && optimise ? options.keepOriginal !== false : true;
  const allowDownload = isVideo ? options.allowDownload === true : false;

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
      throw new MediaError(
        'QUOTA_EXCEEDED',
        'This file would put the class over its storage quota',
        { usedBytes, quotaBytes }
      );
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
        }),
        { expiresIn: PART_URL_TTL_SECONDS }
      ),
      expiresAt,
    }))
  );

  return { urls };
}

/** Abort the multipart without letting a failure there hide the real error. */
async function abortQuietly(
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
async function deleteObjectsQuietly(
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
async function markDeleted(
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
 * was made against a false premise — so the object is deleted, the row is
 * marked DELETED, and the caller is told. Not rounded down to a warning: a
 * client that can overrun its declaration can fill the bucket.
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
async function verifiedSize(client: S3Client, bucket: string, key: string): Promise<number | null> {
  for (let attempt = 1; attempt <= HEAD_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await new Promise(resolve => setTimeout(resolve, HEAD_RETRY_DELAY_MS));
    }
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (typeof head.ContentLength === 'number' && Number.isFinite(head.ContentLength)) {
        return head.ContentLength;
      }
      console.warn(
        `[media] Read back ${key} with no size (attempt ${attempt}/${HEAD_ATTEMPTS})`
      );
    } catch (error) {
      console.warn(
        `[media] Could not read back ${key} (attempt ${attempt}/${HEAD_ATTEMPTS}):`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return null;
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
  const row = await uploadingRow(classroom, mediaId);

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

  try {
    await client.send(
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
  } catch (error) {
    await abortQuietly(client, bucket, key, uploadId);
    await markDeleted(row.id, 'UPLOADING');
    throw error;
  }

  const actual = await verifiedSize(client, bucket, key);
  const declared = Number(row.size_bytes);

  if (actual === null || actual !== declared) {
    // Row first, then the bytes: see `deleteObjectsQuietly`.
    await markDeleted(row.id, 'UPLOADING');
    await deleteObjectsQuietly(client, bucket, [key]);
    if (actual === null) {
      throw new MediaError(
        'VERIFY_FAILED',
        'The upload could not be verified and has been discarded; please try again'
      );
    }
    throw new MediaError('SIZE_MISMATCH', `Uploaded ${actual} bytes but ${declared} were declared`);
  }

  const ready = (await getPrisma().mediaObject.update({
    where: { id: row.id },
    data: {
      status: 'READY',
      ready_at: new Date(),
      upload_id: null,
      // NONE, even for a row that asked to be optimised. PENDING means "a job
      // is queued", and in P1 there is no job — a row parked in PENDING is one
      // the admin page shows as processing forever and one a later sweep would
      // have to unstick. P2's `onMediaReady` sets PENDING at the moment it
      // enqueues, which is the only moment the claim is true.
      processing: 'NONE',
    },
  })) as MediaRow;

  const record = toMediaRecord(ready);
  await onMediaReady(record);

  return { mediaId: record.id, ref: record.ref, sizeBytes: record.sizeBytes };
}

/**
 * Cancel an upload in flight — the client's own "stop" button, and what an
 * unmounting editor calls.
 *
 * Refuses a READY row rather than quietly deleting it: "cancel the upload" and
 * "delete the file" are different intentions, and one standing in for the other
 * would turn a stray abort into data loss. `deleteMedia` is the one that means
 * the second thing.
 */
export async function abortUpload({
  classroom,
  mediaId,
}: {
  classroom: MediaClassroom;
  mediaId: string;
}): Promise<{ mediaId: string }> {
  const { client, bucket } = requireClient();
  const row = await uploadingRow(classroom, mediaId);

  const key = mediaKey(classroom.id, row.id, `orig.${row.ext}`);
  await abortQuietly(client, bucket, key, row.upload_id);
  // Only from UPLOADING: a `complete` that won the race while this abort was in
  // flight has already made the row READY, and cancelling an upload must never
  // be able to delete the file that upload produced.
  await markDeleted(row.id, 'UPLOADING');

  return { mediaId: row.id };
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
 * All three variants, unconditionally, because two of them may or may not exist
 * depending on whether the rendition job has run and a delete that skipped them
 * would leave bytes nobody can see and nobody is billed for. R2 answers a
 * delete of a missing key with success.
 *
 * Deleting an UPLOADING row aborts its multipart first: without that, R2 holds
 * the uploaded parts until its own 7-day expiry.
 */
export async function deleteMedia({
  classroom,
  mediaId,
}: {
  classroom: MediaClassroom;
  mediaId: string;
}): Promise<{ mediaId: string }> {
  const { client, bucket } = requireClient();
  const row = await findMediaRow(classroom.id, mediaId);
  if (!row || row.status === 'DELETED') {
    throw new MediaError('NOT_FOUND', 'No such media object');
  }

  const origKey = mediaKey(classroom.id, row.id, `orig.${row.ext}`);

  // The tombstone goes FIRST. It is the one write that decides what every
  // reader sees, and an R2 delete that fails halfway must not be able to leave
  // a READY row pointing at bytes that are gone — a permanently broken file in
  // every page that referenced it. Conditional, so a delete racing another one
  // does not double-tombstone: the loser is told the object is already gone.
  if (!(await markDeleted(row.id, ['UPLOADING', 'READY']))) {
    throw new MediaError('NOT_FOUND', 'No such media object');
  }

  if (row.status === 'UPLOADING' && row.upload_id) {
    await abortQuietly(client, bucket, origKey, row.upload_id);
  }

  // One command per key rather than a batch DeleteObjects: that operation
  // REQUIRES a checksum, and the modern ones the SDK sends by default are not
  // reliably supported by S3-compatible stores. Three round trips for at most
  // three keys is not worth the compatibility risk.
  await deleteObjectsQuietly(client, bucket, [
    origKey,
    mediaKey(classroom.id, row.id, 'web.mp4'),
    mediaKey(classroom.id, row.id, 'poster.webp'),
  ]);

  return { mediaId: row.id };
}
