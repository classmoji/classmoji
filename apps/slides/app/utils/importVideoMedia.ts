/**
 * importVideoMedia.ts — where each asset of a slides.com import goes, and how
 * it gets there without holding the ZIP's contents in memory.
 *
 * Every image and video is routed by the storage router the editors ask
 * (`storageTargetFor`): on a classroom with media (Pro, a bucket on this
 * deployment, and content that can be served signed) every video goes there,
 * and so does anything over the repository's cap — an image included. A file
 * bound for media is written with `putMediaObject` (the server-side twin of the
 * browser's upload, with the same Pro, delivery, per-file and quota rules) and
 * referenced from the deck as `media://{id}`. Everything else keeps the
 * repository path, and with it the per-entry skip for a file over the cap.
 *
 * Memory is the constraint that shapes `placeImportEntry`. A ZIP under the
 * upload cap can hold entries that inflate to gigabytes, so an entry is judged
 * by the size the ZIP declares BEFORE it is inflated, entries are placed one
 * at a time (inflate → store → drop), and the whole import has an inflated-bytes
 * budget (`IMPORT_INFLATE_BUDGET_BYTES`).
 *
 * An entry left out — too large, over the budget, or refused by media storage —
 * becomes a warning that names it, through the same gate as an entry over the
 * repository's cap. It never fails the import.
 *
 * Pure, with the write injected: nothing here imports `@classmoji/services`, so
 * the rules run in the unit runner without a database or an S3 client.
 */

import {
  kindOfFilename,
  storageTargetFor,
  type UploadCapability,
} from '@classmoji/services/media/router';
import { formatMegabytes } from '@classmoji/utils/repo-limits';
import { DEFAULT_VIDEO_OPTIONS, formatGigabytes, type VideoOptions } from './mediaUpload.ts';
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

/** The options an imported file is stored with: the video choices for a video, none otherwise. */
export function importMediaOptions(filename: string): Partial<VideoOptions> {
  return kindOfFilename(filename) === 'VIDEO' ? { ...IMPORT_VIDEO_OPTIONS } : {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Which ZIP entries are assets at all
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An entry's role in the deck, by the store's own kind table: a video or an
 * audio file is placed with the videos (the deck plays it from a `<video>` /
 * `<source>`), an image with the images. SVG is an image the store's table
 * leaves out on purpose (it is not a kind media serves), and anything else in
 * one of the export's asset folders — other than its css and js — is carried as
 * an image, as the importer always did. Null for everything else.
 */
export function importAssetType(filePath: string): 'image' | 'video' | null {
  const filename = filePath.split('/').pop() ?? '';
  if (!filename) return null;
  const kind = kindOfFilename(filename);
  if (kind === 'VIDEO' || kind === 'AUDIO') return 'video';
  if (kind === 'IMAGE' || /\.svg$/i.test(filename)) return 'image';
  const inAssetFolder = filePath.includes('/') && !filePath.startsWith('lib/');
  if (inAssetFolder && !/\.(css|js)$/i.test(filename)) return 'image';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Placing one entry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many bytes one import may inflate in total, across every entry. The
 * slides VM has 2 GB of memory and an import's repository files are all held
 * until its single commit; this bounds the work one ZIP can ask for.
 */
export const IMPORT_INFLATE_BUDGET_BYTES = 3 * 1024 * 1024 * 1024;

/** The import's running total of inflated bytes. */
export class ImportInflateBudget {
  private used = 0;
  constructor(readonly limitBytes: number = IMPORT_INFLATE_BUDGET_BYTES) {}

  fits(bytes: number): boolean {
    return this.used + bytes <= this.limitBytes;
  }

  spend(bytes: number): void {
    this.used += bytes;
  }

  get usedBytes(): number {
    return this.used;
  }
}

/**
 * The warning for an entry left out because the import has already inflated
 * as much as it may: `Skipped lecture.mp4 (900 MB) — this import is over its
 * 3 GB limit for all files together`.
 */
export function importBudgetSkippedWarning(
  name: string,
  bytes: number,
  limitBytes: number
): string {
  return (
    `Skipped ${name} (${formatMegabytes(bytes)}) — this import is over its ` +
    `${formatGigabytes(limitBytes)} limit for all files together`
  );
}

/** One ZIP entry, as much of it as placing it needs. */
export interface ImportZipEntry {
  /** Its path inside the ZIP — what the deck's references name. */
  filePath: string;
  filename: string;
  /** The uncompressed size the ZIP declares, or null when it declares none. */
  declared: number | null;
  /** Decompress it. Called at most once, and only after the checks pass. */
  inflate(): Promise<Buffer>;
}

/** Store one file's bytes in the classroom's media (`putMediaObject`). */
export type PutImportMedia = (bytes: Buffer) => Promise<{ mediaId: string; ref: string }>;

export type ImportPlacement =
  /** The repository takes it: the caller commits these bytes. */
  | { kind: 'repo'; buffer: Buffer }
  /** Stored in media; the bytes are gone, only the reference is left. */
  | { kind: 'media'; mediaId: string; ref: string }
  /** Left out, recorded on the gate with its warning. */
  | { kind: 'skipped' };

/**
 * Place one entry: the repository, media, or nowhere (with a named warning).
 *
 * Checked by the DECLARED size first, so an entry too large for anywhere it
 * could go, or one the import's budget cannot cover, is never inflated at all.
 * The same checks run again on the bytes, because a header is only a claim.
 * A file bound for media is written before this returns and its bytes are not
 * kept — the caller places the next entry with this one's memory released.
 */
export async function placeImportEntry({
  entry,
  capability,
  gate,
  budget,
  put,
  onError = () => {},
}: {
  entry: ImportZipEntry;
  capability: UploadCapability | null | undefined;
  gate: RepoEntryGate;
  budget: ImportInflateBudget;
  put: PutImportMedia;
  /** A refused media write, for the server log — the warning never carries it. */
  onError?: (filename: string, error: unknown) => void;
}): Promise<ImportPlacement> {
  const { filePath, filename } = entry;

  /** Leave the entry out if `bytes` fit nowhere, or not in the budget. */
  const leftOut = (bytes: number): boolean => {
    // The router says media only within media's own per-file ceiling (the
    // capability's, never a constant here), so anything it does not send there
    // has to fit the repository.
    if (!importEntryGoesToMedia(capability, filename, bytes)) {
      const media = capability?.media;
      if (media && bytes > media.perFileMaxBytes) {
        gate.skip(
          filename,
          bytes,
          filePath,
          importMediaSkippedWarning(filename, bytes, { code: 'FILE_TOO_LARGE' })
        );
        return true;
      }
      // The repository's own skip, with its own sentence.
      if (!gate.admit(filename, bytes, filePath)) return true;
    }
    if (!budget.fits(bytes)) {
      gate.skip(
        filename,
        bytes,
        filePath,
        importBudgetSkippedWarning(filename, bytes, budget.limitBytes)
      );
      return true;
    }
    return false;
  };

  if (entry.declared !== null && leftOut(entry.declared)) return { kind: 'skipped' };

  const buffer = await entry.inflate();
  if (leftOut(buffer.length)) return { kind: 'skipped' };
  budget.spend(buffer.length);

  if (!importEntryGoesToMedia(capability, filename, buffer.length)) {
    return { kind: 'repo', buffer };
  }

  try {
    const { mediaId, ref } = await put(buffer);
    return { kind: 'media', mediaId, ref };
  } catch (error: unknown) {
    onError(filename, error);
    gate.skip(
      filename,
      buffer.length,
      filePath,
      importMediaSkippedWarning(filename, buffer.length, error)
    );
    return { kind: 'skipped' };
  }
}
