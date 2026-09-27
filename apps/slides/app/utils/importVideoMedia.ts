/**
 * importVideoMedia.ts — the slides.com import's videos on a classroom with
 * media storage.
 *
 * Where a classroom has media (Pro, a bucket on this deployment, and content
 * that can be served signed), the storage router sends every video there, and
 * anything over the repository's cap too. The import asks the same router the
 * editors ask, per entry, and a video it sends to media is written with
 * `putMediaObject` — the server-side twin of the browser's upload, with the
 * same Pro, delivery, per-file and quota rules — and referenced from the deck
 * as `media://{id}`. Everything else keeps the repository path, and with it the
 * per-entry skip for a file over the cap.
 *
 * One video media storage refuses (a full quota, a failed write) is left out
 * with a warning that names it, through the same gate and the same warning
 * channel as an entry over the repository's cap. It never fails the import.
 *
 * Pure, with the write injected: nothing here imports `@classmoji/services`, so
 * the rules run in the unit runner without a database or an S3 client.
 */

import { storageTargetFor, type UploadCapability } from '@classmoji/services/media/router';
import { formatMegabytes } from '@classmoji/utils/repo-limits';
import { DEFAULT_VIDEO_OPTIONS, type VideoOptions } from './mediaUpload.ts';
import type { RepoEntryGate } from './zipRepoEntries.ts';

/**
 * The three video choices an imported video is stored with: the uploader's own
 * defaults — optimise on, keep the original, no student download. The import
 * has no dialog to ask them in, so it takes what the dialog starts at.
 */
export const IMPORT_VIDEO_OPTIONS: Readonly<VideoOptions> = { ...DEFAULT_VIDEO_OPTIONS };

/**
 * Does the storage router send this entry to media?
 *
 * Never without a capability that has media: a classroom without it keeps the
 * repository path whatever the file is, and the router's refusal for a file too
 * large for the repository is the per-entry skip the gate already gives.
 */
export function importEntryGoesToMedia(
  capability: UploadCapability | null | undefined,
  name: string,
  size: number
): boolean {
  if (!capability?.media) return false;
  return storageTargetFor(capability, { name, size }).kind === 'media';
}

/** A video read out of the ZIP and bound for media. */
export interface QueuedMediaVideo {
  /** Its path inside the ZIP — what the deck's references name. */
  filePath: string;
  filename: string;
  buffer: Buffer;
}

/** Store one video's bytes in the classroom's media (`putMediaObject`). */
export type PutImportVideo = (video: {
  filename: string;
  bytes: Buffer;
}) => Promise<{ mediaId: string; ref: string }>;

/** What a media refusal means, as the end of an import warning. Never a code. */
function mediaRefusalPhrase(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case 'QUOTA_EXCEEDED':
      return "this class's media storage is full";
    case 'FILE_TOO_LARGE':
      return 'it is over the limit for one file';
    case 'NOT_CONFIGURED':
    case 'PRO_REQUIRED':
    case 'DELIVERY_REQUIRED':
      return "media storage isn't available for this class right now";
    case 'KIND_NOT_ALLOWED':
      return 'its file name cannot be stored';
    default:
      return 'the upload failed';
  }
}

/**
 * The warning for a video left out because media storage would not take it:
 * `Skipped lecture.mp4 (40 MB) — media storage could not take it (this class's
 * media storage is full)`.
 */
export function importMediaSkippedWarning(name: string, bytes: number, error: unknown): string {
  return (
    `Skipped ${name} (${formatMegabytes(bytes)}) — media storage could not take it ` +
    `(${mediaRefusalPhrase(error)})`
  );
}

/**
 * Write every queued video to media, in order.
 *
 * A stored video is mapped — under its zip path AND its bare filename, the
 * importer's convention — to its `media://{id}` reference in `videoMap`. One
 * that fails is recorded on `gate` with its warning, so the deck's references
 * to it are removed and the warning names the slides that used it; the rest
 * carry on.
 *
 * Returns the ids written, for the importer to delete if the import itself
 * fails afterwards.
 */
export async function storeImportVideosInMedia({
  queue,
  put,
  gate,
  videoMap,
  onEach = () => {},
  onError = () => {},
}: {
  queue: readonly QueuedMediaVideo[];
  put: PutImportVideo;
  gate: RepoEntryGate;
  videoMap: Map<string, string>;
  /** Before each write: 1-based position, total, filename. */
  onEach?: (current: number, total: number, filename: string) => void;
  /** A refused write, for the server log — the warning never carries it. */
  onError?: (filename: string, error: unknown) => void;
}): Promise<string[]> {
  const stored: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const { filePath, filename, buffer } = queue[i];
    onEach(i + 1, queue.length, filename);
    try {
      const { mediaId, ref } = await put({ filename, bytes: buffer });
      stored.push(mediaId);
      videoMap.set(filePath, ref);
      videoMap.set(filename, ref);
    } catch (error: unknown) {
      onError(filename, error);
      gate.skip(
        filename,
        buffer.length,
        filePath,
        importMediaSkippedWarning(filename, buffer.length, error)
      );
    }
  }
  return stored;
}
