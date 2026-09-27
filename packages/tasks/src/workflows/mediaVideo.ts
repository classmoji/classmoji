import { AbortTaskRunError, logger, task } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { mediaKey, posterVariant, renditionVariant } from '@classmoji/content-signing';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deleteObject,
  downloadToFile,
  headBytes,
  mediaStore,
  sha256File,
  uploadFile,
  type MediaStore,
} from '../helpers/r2Objects.ts';
import {
  GENERIC_FAILURE_MESSAGE,
  VideoRefusal,
  decideVideo,
  isCompleteOutput,
  isVideoRefusal,
  parseProbe,
  posterArgs,
  renditionArgs,
  type ProbeJson,
} from '../helpers/videoPlan.ts';
import { probeFile, runFfmpeg } from '../helpers/videoTools.ts';

/**
 * `media-video-process` — turn an uploaded video into a streaming rendition
 * (`web-{hex12}.mp4`) and a poster (`poster-{hex12}.jpg`), plan §3.10, §12.3
 * and the binding amendments in §12.6.
 *
 * Queued by the services' `onMediaReady` for a READY video uploaded with
 * "Optimise for streaming" on, which sets `processing = PENDING` as it queues.
 * The original serves the whole time; the row's `rendition_key` is the serve
 * switch, and it is written only once the rendition is in the bucket and
 * verified.
 *
 * ## Steps
 *
 *   1. Re-read the row: READY, VIDEO, optimise, PENDING — else exit quietly.
 *   2. Stream the original to a tmp dir (exactly `size_bytes`).
 *   3. ffprobe → remux or transcode (`decideVideo`), or refuse.
 *   4. ffmpeg → rendition; ffprobe it; it must be COMPLETE (§12.6).
 *   5. Poster from the rendition. Best-effort: a poster that cannot be made
 *      leaves `poster_key` null rather than failing a finished rendition.
 *   6. SHA-256 → content-derived names; stream-upload; HeadObject verify.
 *   7. The DONE write, fenced on `READY + PENDING`.
 *   8. `keep_original` off: mark the original dropped, then delete it.
 *
 * ## Fencing
 *
 * The DONE write matches only a row still READY and PENDING. Zero rows means
 * the row was deleted, tombstoned or finished by another run while this one
 * worked: whatever THIS run uploaded is deleted — unless the row now names it
 * (identical bytes give identical names, so a replay can produce exactly what
 * an earlier run already recorded) — and the run ends quietly.
 *
 * ## Failure
 *
 * A `VideoRefusal` is final — the file is what it is — and ends the run with
 * `AbortTaskRunError` after recording `processing = FAILED` and the refusal's
 * sentence. Anything else is retried; on the last attempt it is recorded with
 * the generic sentence. Either way, before the DONE write, this attempt's
 * uploads are deleted; the original is never touched on a failure path.
 * `onFailure` is the backstop for a throw that escapes the in-run record; the
 * record is conditional on PENDING, so the two can never disagree.
 *
 * Not in `src/index.ts`: the services trigger it by string id.
 */

export const VIDEO_TASK_ID = 'media-video-process';
export const VIDEO_MAX_ATTEMPTS = 3;

export interface MediaVideoPayload {
  classroomId: string;
  mediaId: string;
}

export type MediaVideoResult =
  | { status: 'done'; mode: 'remux' | 'transcode'; renditionKey: string; posterKey: string | null }
  | { status: 'skipped'; reason: string };

/** The row fields the job reads. */
export interface VideoRow {
  id: string;
  classroom_id: string;
  kind: string;
  ext: string;
  size_bytes: bigint;
  status: string;
  optimise: boolean;
  keep_original: boolean;
  processing: string;
  rendition_key: string | null;
  poster_key: string | null;
}

export interface DoneFields {
  rendition_key: string;
  rendition_bytes: bigint;
  poster_key: string | null;
  duration_ms: number;
  width: number;
  height: number;
}

/**
 * Everything the job touches outside its own arithmetic, so the tests can
 * stand in for the database, the bucket and the processes.
 */
export interface VideoJobDeps {
  findRow(mediaId: string): Promise<VideoRow | null>;
  /** The fenced DONE write. Returns the number of rows it matched (0 or 1). */
  commitDone(mediaId: string, fields: DoneFields): Promise<number>;
  /** Mark the original dropped, only while the row is READY and names `renditionKey`. */
  markOriginalDropped(mediaId: string, renditionKey: string): Promise<number>;
  /** FAILED + reason, only while the row is READY and PENDING. */
  recordFailure(mediaId: string, reason: string): Promise<number>;

  download(key: string, file: string, expectedBytes: number): Promise<void>;
  upload(key: string, file: string, sizeBytes: number, contentType: string): Promise<void>;
  headBytes(key: string): Promise<number | null>;
  deleteObject(key: string): Promise<void>;

  probe(file: string): Promise<ProbeJson>;
  ffmpeg(args: string[]): Promise<void>;
  sha256(file: string): Promise<string>;
  fileSize(file: string): Promise<number>;

  makeTmpDir(): Promise<string>;
  removeTmpDir(dir: string): Promise<void>;
}

/** Why a row is not this job's to process, or null when it is. */
export function ineligibility(row: VideoRow | null, classroomId: string): string | null {
  if (!row) return 'missing';
  if (row.classroom_id !== classroomId) return 'wrong-classroom';
  if (row.status !== 'READY') return 'not-ready';
  if (row.kind !== 'VIDEO') return 'not-video';
  if (!row.optimise) return 'not-optimised';
  if (row.processing !== 'PENDING') return 'not-pending';
  return null;
}

function lastSegment(key: string | null): string | null {
  return key ? key.slice(key.lastIndexOf('/') + 1) : null;
}

/** The objects a row names — by variant, so a full key and a bare variant compare equal. */
function namedBy(row: VideoRow | null): Set<string> {
  const named = new Set<string>();
  for (const key of [row?.rendition_key ?? null, row?.poster_key ?? null]) {
    const tail = lastSegment(key);
    if (tail) named.add(tail);
  }
  return named;
}

/**
 * Delete what this run uploaded, except anything the row (re-read now) names.
 * Quiet: a cleanup failure must not replace the error that caused it; the
 * objects are still under the media's prefix, which its delete removes.
 */
async function deleteOwnUploads(deps: VideoJobDeps, mediaId: string, keys: string[]) {
  if (!keys.length) return;
  let keep: Set<string>;
  try {
    keep = namedBy(await deps.findRow(mediaId));
  } catch (error) {
    logger.error('Could not re-read the row; leaving this run’s uploads in place', {
      mediaId,
      keys,
      error: describe(error),
    });
    return;
  }
  for (const key of keys) {
    if (keep.has(lastSegment(key) ?? '')) continue;
    try {
      await deps.deleteObject(key);
    } catch (error) {
      logger.warn('Could not delete an upload from this run', { key, error: describe(error) });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One attempt at the job. Throws a `VideoRefusal` for a final refusal and any
 * other error for a retry; the caller decides what to record.
 */
export async function processVideo(
  payload: MediaVideoPayload,
  deps: VideoJobDeps
): Promise<MediaVideoResult> {
  const { classroomId, mediaId } = payload;
  const row = await deps.findRow(mediaId);
  const skip = ineligibility(row, classroomId);
  if (skip || !row) return { status: 'skipped', reason: skip ?? 'missing' };

  const origKey = mediaKey(row.classroom_id, row.id, `orig.${row.ext}`);
  const inputBytes = Number(row.size_bytes);
  const uploaded: string[] = [];
  let committed = false;
  const dir = await deps.makeTmpDir();

  try {
    // 2. The original, to disk.
    const input = join(dir, 'input');
    await deps.download(origKey, input, inputBytes);

    // 3. What it is, and what to do with it.
    const facts = parseProbe(await deps.probe(input), inputBytes);
    const decision = decideVideo(facts, row.ext);
    logger.info('Video plan', {
      mediaId,
      mode: decision.mode,
      reasons: decision.reasons,
      durationSec: facts.durationSec,
      width: decision.video.displayWidth,
      height: decision.video.displayHeight,
      bitRate: Math.round(facts.bitRate),
    });

    // 4. The rendition, and proof it is whole.
    const rendition = join(dir, 'web.mp4');
    await deps.ffmpeg(
      renditionArgs({
        input,
        output: rendition,
        decision,
        audioIndex: facts.audio?.index ?? null,
        inputBytes,
      })
    );
    const renditionBytes = await deps.fileSize(rendition);
    let output;
    try {
      output = parseProbe(await deps.probe(rendition), renditionBytes);
    } catch (error) {
      if (isVideoRefusal(error)) throw new VideoRefusal('INCOMPLETE', 'output unreadable');
      throw error;
    }
    if (!output.video || !isCompleteOutput(facts.durationSec, output)) {
      throw new VideoRefusal(
        'INCOMPLETE',
        `output ${output.durationSec}s of ${facts.durationSec}s, video ${Boolean(output.video)}`
      );
    }

    // 5. The poster — best-effort.
    let poster: { file: string; bytes: number } | null = null;
    try {
      const file = join(dir, 'poster.jpg');
      await deps.ffmpeg(
        posterArgs({
          rendition,
          output: file,
          durationSec: output.durationSec,
          renditionWidth: output.video.displayWidth,
        })
      );
      const bytes = await deps.fileSize(file);
      if (bytes > 0) poster = { file, bytes };
    } catch (error) {
      if (!isVideoRefusal(error)) throw error;
      logger.warn('No poster for this video', { mediaId, error: describe(error) });
    }

    // 6. Content-derived names, streamed up, verified.
    const renditionKey = mediaKey(
      row.classroom_id,
      row.id,
      renditionVariant((await deps.sha256(rendition)).slice(0, 12))
    );
    uploaded.push(renditionKey);
    await deps.upload(renditionKey, rendition, renditionBytes, 'video/mp4');
    const storedRendition = await deps.headBytes(renditionKey);
    if (storedRendition !== renditionBytes) {
      throw new Error(`rendition stored as ${storedRendition} bytes, expected ${renditionBytes}`);
    }

    let posterKey: string | null = null;
    if (poster) {
      posterKey = mediaKey(
        row.classroom_id,
        row.id,
        posterVariant((await deps.sha256(poster.file)).slice(0, 12))
      );
      uploaded.push(posterKey);
      await deps.upload(posterKey, poster.file, poster.bytes, 'image/jpeg');
      const storedPoster = await deps.headBytes(posterKey);
      if (storedPoster !== poster.bytes) {
        throw new Error(`poster stored as ${storedPoster} bytes, expected ${poster.bytes}`);
      }
    }

    // 7. The fenced result write.
    const matched = await deps.commitDone(mediaId, {
      rendition_key: renditionKey,
      rendition_bytes: BigInt(renditionBytes),
      poster_key: posterKey,
      duration_ms: Math.round(output.durationSec * 1000),
      width: output.video.displayWidth,
      height: output.video.displayHeight,
    });
    if (matched === 0) {
      logger.info('The row moved on while this run worked; removing its uploads', { mediaId });
      await deleteOwnUploads(deps, mediaId, uploaded);
      return { status: 'skipped', reason: 'fenced' };
    }
    committed = true;

    // 8. Drop the original, only now, only if asked. Never throws: the
    // rendition is live, and a retry would find the row DONE and do nothing.
    if (!row.keep_original) {
      try {
        const marked = await deps.markOriginalDropped(mediaId, renditionKey);
        if (marked === 1) await deps.deleteObject(origKey);
      } catch (error) {
        logger.error('Could not drop the original after optimising', {
          mediaId,
          origKey,
          error: describe(error),
        });
      }
    }

    return { status: 'done', mode: decision.mode, renditionKey, posterKey };
  } catch (error) {
    if (!committed) await deleteOwnUploads(deps, mediaId, uploaded);
    throw error;
  } finally {
    await deps
      .removeTmpDir(dir)
      .catch(error => logger.warn('Could not remove the tmp dir', { dir, error: describe(error) }));
  }
}

/**
 * Run one attempt and decide what a failure means: a refusal is recorded and
 * ends the run (`AbortTaskRunError`); anything else is retried, and recorded
 * with the generic sentence on the last attempt.
 */
export async function runVideoAttempt(
  payload: MediaVideoPayload,
  attempt: number,
  deps: VideoJobDeps
): Promise<MediaVideoResult> {
  try {
    return await processVideo(payload, deps);
  } catch (error) {
    const refusal = isVideoRefusal(error);
    const final = refusal || attempt >= VIDEO_MAX_ATTEMPTS;
    logger.warn('Video processing failed', {
      mediaId: payload.mediaId,
      attempt,
      final,
      error: describe(error),
    });
    if (final) {
      const reason = refusal ? error.userMessage : GENERIC_FAILURE_MESSAGE;
      await deps.recordFailure(payload.mediaId, reason);
      if (refusal) throw new AbortTaskRunError(error.message);
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The live dependencies
// ─────────────────────────────────────────────────────────────────────────────

function requireStore(): MediaStore {
  const store = mediaStore();
  if (!store) throw new Error('media: MEDIA_R2_* is not configured for this environment');
  return store;
}

const ROW_SELECT = {
  id: true,
  classroom_id: true,
  kind: true,
  ext: true,
  size_bytes: true,
  status: true,
  optimise: true,
  keep_original: true,
  processing: true,
  rendition_key: true,
  poster_key: true,
} as const;

export function liveDeps(): VideoJobDeps {
  return {
    findRow: async mediaId =>
      (await getPrisma().mediaObject.findUnique({
        where: { id: mediaId },
        select: ROW_SELECT,
      })) as VideoRow | null,
    commitDone: async (mediaId, fields) =>
      (
        await getPrisma().mediaObject.updateMany({
          where: { id: mediaId, status: 'READY', processing: 'PENDING' },
          data: { ...fields, processing: 'DONE', processing_error: null },
        })
      ).count,
    markOriginalDropped: async (mediaId, renditionKey) =>
      (
        await getPrisma().mediaObject.updateMany({
          where: {
            id: mediaId,
            status: 'READY',
            keep_original: false,
            original_deleted_at: null,
            rendition_key: renditionKey,
          },
          data: { original_deleted_at: new Date() },
        })
      ).count,
    recordFailure: async (mediaId, reason) =>
      (
        await getPrisma().mediaObject.updateMany({
          where: { id: mediaId, status: 'READY', processing: 'PENDING' },
          data: { processing: 'FAILED', processing_error: reason },
        })
      ).count,

    download: (key, file, expectedBytes) =>
      downloadToFile(requireStore(), key, file, expectedBytes),
    upload: (key, file, sizeBytes, contentType) =>
      uploadFile(requireStore(), key, file, sizeBytes, contentType),
    headBytes: key => headBytes(requireStore(), key),
    deleteObject: key => deleteObject(requireStore(), key),

    probe: probeFile,
    ffmpeg: runFfmpeg,
    sha256: sha256File,
    fileSize: async file => (await stat(file)).size,

    makeTmpDir: () => mkdtemp(join(tmpdir(), 'media-video-')),
    removeTmpDir: dir => rm(dir, { recursive: true, force: true }),
  };
}

export const mediaVideoProcess = task({
  id: VIDEO_TASK_ID,
  /**
   * Two encodes at a time across the project: a transcode keeps all eight
   * cores busy for up to an hour, and a class uploading a term of lectures
   * at once should queue, not fan out.
   */
  queue: { name: 'media-video', concurrencyLimit: 2 },
  /** 8 vCPU / 16 GB / 10 GB disk: x264 scales with cores; the disk budget is §12.6. */
  machine: { preset: 'large-2x' },
  /** 4 hours: a long lecture's transcode, plus the transfers either side. */
  maxDuration: 4 * 60 * 60,
  retry: {
    maxAttempts: VIDEO_MAX_ATTEMPTS,
    minTimeoutInMs: 10_000,
    maxTimeoutInMs: 120_000,
    factor: 2,
  },
  run: async (payload: MediaVideoPayload, { ctx }): Promise<MediaVideoResult> =>
    runVideoAttempt(payload, ctx.attempt.number, liveDeps()),
  /**
   * After the last attempt. `run` has usually recorded the failure already
   * (then this matches no PENDING row and does nothing); this catches a throw
   * from outside its own catch.
   *
   * It runs IN the task process, only when `run` threw and no retry is left
   * (SDK 4.6.3 `taskExecutor`). A run the platform ends from outside — killed
   * at `maxDuration`, OOM-killed, over the disk limit, heartbeat timeout,
   * cancelled, or a crash on its last attempt — never reaches it, and the row
   * stays PENDING ("Optimising"). The original keeps serving; a Trigger replay
   * picks the row up again.
   */
  onFailure: async ({ payload }) => {
    try {
      await liveDeps().recordFailure(payload.mediaId, GENERIC_FAILURE_MESSAGE);
    } catch (error) {
      logger.error('Could not record a failed video job', {
        mediaId: payload.mediaId,
        error: describe(error),
      });
    }
  },
});
