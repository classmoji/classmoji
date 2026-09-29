import { AbortTaskRunError, logger, task, usage } from '@trigger.dev/sdk';
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
  mappedDurationSec,
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
 *   1. Re-read the row: READY, VIDEO, optimise, PENDING or FAILED — else exit
 *      quietly — and claim it back to PENDING (clearing `processing_error`)
 *      with a conditional update.
 *   2. Stream the original to a tmp dir (exactly `size_bytes`).
 *   3. ffprobe → remux or transcode (`decideVideo`), or refuse.
 *   4. ffmpeg → rendition; ffprobe it; it must be COMPLETE (§12.6).
 *   5. SHA-256 → content-derived name; stream-upload; HeadObject verify.
 *   6. Poster from the rendition, named, uploaded and verified the same way.
 *      Best-effort throughout: any failure leaves `poster_key` null rather
 *      than failing a finished rendition.
 *   7. The DONE write, fenced on `READY + PENDING`.
 *   8. `keep_original` off: mark the original dropped, then delete it.
 *
 * ## Retrying a video (runbook)
 *
 * To retry a video, replay its run in Trigger (or trigger
 * `media-video-process` with `{classroomId, mediaId}`); never replay a run
 * that is still executing. A FAILED row is eligible and is claimed back to
 * PENDING; a DONE row is left alone.
 *
 * ## The deadline
 *
 * `maxDuration` counts compute across ALL attempts, and a run the platform
 * stops at it never reaches `onFailure`, leaving the row PENDING. So the run
 * sets its own deadline 15 minutes short of what is left, kills ffmpeg there,
 * and records FAILED ("took too long") through the normal path.
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
  /**
   * Claim the row for this run: PENDING or FAILED → PENDING, clearing
   * `processing_error`, only while it is still this classroom's READY
   * optimised video. Returns the number of rows it matched (0 or 1).
   */
  claim(mediaId: string, classroomId: string): Promise<number>;
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
  // PENDING: queued on upload. FAILED: a retry (see the runbook above).
  if (row.processing !== 'PENDING' && row.processing !== 'FAILED') return 'not-queued';
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
  if ((await deps.claim(mediaId, classroomId)) === 0) {
    return { status: 'skipped', reason: 'claim-lost' };
  }

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
    const expectedSec = mappedDurationSec(facts);
    if (!output.video || !isCompleteOutput(expectedSec, output)) {
      throw new VideoRefusal(
        'INCOMPLETE',
        `output ${output.durationSec}s of ${expectedSec}s, video ${Boolean(output.video)}`
      );
    }
    const outputVideo = output.video;

    // 5. The rendition: content-derived name, streamed up, verified.
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

    // 6. The poster, best-effort from the first command to the last.
    let posterKey: string | null = null;
    let posterAttempt: string | null = null;
    try {
      const file = join(dir, 'poster.jpg');
      await deps.ffmpeg(
        posterArgs({
          rendition,
          output: file,
          durationSec: output.durationSec,
          renditionWidth: outputVideo.displayWidth,
        })
      );
      const bytes = await deps.fileSize(file);
      if (bytes > 0) {
        posterAttempt = mediaKey(
          row.classroom_id,
          row.id,
          posterVariant((await deps.sha256(file)).slice(0, 12))
        );
        uploaded.push(posterAttempt);
        await deps.upload(posterAttempt, file, bytes, 'image/jpeg');
        const storedPoster = await deps.headBytes(posterAttempt);
        if (storedPoster !== bytes) {
          throw new Error(`poster stored as ${storedPoster} bytes, expected ${bytes}`);
        }
        posterKey = posterAttempt;
      }
    } catch (error) {
      logger.warn('No poster for this video', { mediaId, error: describe(error) });
      if (posterAttempt) {
        await deps
          .deleteObject(posterAttempt)
          .catch(e => logger.warn('Could not delete a failed poster', { error: describe(e) }));
      }
    }

    // 7. The fenced result write.
    const matched = await deps.commitDone(mediaId, {
      rendition_key: renditionKey,
      rendition_bytes: BigInt(renditionBytes),
      poster_key: posterKey,
      duration_ms: Math.round(output.durationSec * 1000),
      width: outputVideo.displayWidth,
      height: outputVideo.displayHeight,
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
 * with the generic sentence on the last attempt. `maxAttempts` is the run's
 * own (`ctx.run.maxAttempts`), which a trigger can override.
 */
export async function runVideoAttempt(
  payload: MediaVideoPayload,
  attempt: number,
  maxAttempts: number,
  deps: VideoJobDeps
): Promise<MediaVideoResult> {
  try {
    return await processVideo(payload, deps);
  } catch (error) {
    const refusal = isVideoRefusal(error);
    const final = refusal || attempt >= maxAttempts;
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

/** The task's `maxDuration`, in seconds: a long lecture's transcode plus the transfers. */
export const VIDEO_MAX_DURATION_SEC = 4 * 60 * 60;

/** How far short of the platform's limit the run stops itself. */
export const DEADLINE_MARGIN_MS = 15 * 60 * 1000;

/**
 * Milliseconds this attempt may run before it kills ffmpeg: what is left of
 * `maxDuration` after the compute already used (earlier attempts included),
 * less the margin. Never negative — a late attempt gets a deadline already past.
 */
export function deadlineInMs(maxDurationSec: number, computeUsedMs: number): number {
  return Math.max(0, maxDurationSec * 1000 - computeUsedMs - DEADLINE_MARGIN_MS);
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

/** `deadline` kills ffmpeg/ffprobe when it fires (see "The deadline"). */
export function liveDeps(deadline?: AbortSignal): VideoJobDeps {
  return {
    findRow: async mediaId =>
      (await getPrisma().mediaObject.findUnique({
        where: { id: mediaId },
        select: ROW_SELECT,
      })) as VideoRow | null,
    claim: async (mediaId, classroomId) =>
      (
        await getPrisma().mediaObject.updateMany({
          where: {
            id: mediaId,
            classroom_id: classroomId,
            status: 'READY',
            kind: 'VIDEO',
            optimise: true,
            processing: { in: ['PENDING', 'FAILED'] },
          },
          data: { processing: 'PENDING', processing_error: null },
        })
      ).count,
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

    probe: file => probeFile(file, deadline),
    ffmpeg: args => runFfmpeg(args, deadline),
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
  maxDuration: VIDEO_MAX_DURATION_SEC,
  retry: {
    maxAttempts: VIDEO_MAX_ATTEMPTS,
    minTimeoutInMs: 10_000,
    maxTimeoutInMs: 120_000,
    factor: 2,
  },
  run: async (payload: MediaVideoPayload, { ctx }): Promise<MediaVideoResult> => {
    const deadlineMs = deadlineInMs(
      ctx.run.maxDuration ?? VIDEO_MAX_DURATION_SEC,
      usage.getCurrent().compute.total.durationMs
    );
    return runVideoAttempt(
      payload,
      ctx.attempt.number,
      ctx.run.maxAttempts ?? VIDEO_MAX_ATTEMPTS,
      liveDeps(AbortSignal.timeout(deadlineMs))
    );
  },
  /**
   * After the last attempt. `run` has usually recorded the failure already
   * (then this matches no PENDING row and does nothing); this catches a throw
   * from outside its own catch.
   *
   * It runs IN the task process, only when `run` threw and no retry is left
   * (SDK 4.6.3 `taskExecutor`). A run the platform ends from outside — killed
   * at `maxDuration`, OOM-killed, over the disk limit, heartbeat timeout,
   * cancelled, or a crash on its last attempt — never reaches it, and the row
   * stays PENDING ("Optimising"). The in-run deadline keeps `maxDuration` out
   * of that list in practice. The original keeps serving; a Trigger replay
   * picks the row up again (see the runbook at the top).
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
