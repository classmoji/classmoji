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
 * at a time (inflate → store → drop), the whole import has an inflated-bytes
 * budget (`IMPORT_INFLATE_BUDGET_BYTES`), and the files kept for the
 * repository — held until the import's one commit — have a limit of their own
 * (`IMPORT_REPO_HELD_BYTES`). Both live on one `ImportLimits` per import.
 *
 * An entry left out — too large, over a limit, or refused by media storage —
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
import {
  DEFAULT_VIDEO_OPTIONS,
  MEDIA_QUOTA_FULL_MESSAGE,
  formatGigabytes,
  type VideoOptions,
} from './mediaUpload.ts';
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
 * The warning for a file left out because media storage would not take it:
 * `Skipped lecture.mp4 (40 MB) — media storage could not take it (it is over the
 * limit for one file)`. A full quota says what the server says — who to contact
 * — rather than a phrase of ours: `Skipped lecture.mp4 (40 MB) — This class's
 * media storage is full. Contact hello@classmoji.io to upgrade.`
 */
export function importMediaSkippedWarning(name: string, bytes: number, error: unknown): string {
  const failure = error as { code?: unknown; message?: unknown } | null;
  if (failure?.code === 'QUOTA_EXCEEDED') {
    const sentence =
      typeof failure.message === 'string' && failure.message.trim()
        ? failure.message.trim()
        : MEDIA_QUOTA_FULL_MESSAGE;
    return `Skipped ${name} (${formatMegabytes(bytes)}) — ${sentence}`;
  }
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
 * How many bytes one import may inflate in total, across every entry — the
 * repository's and media's alike. This bounds the work one ZIP can ask for;
 * what is HELD at once is bounded by `IMPORT_REPO_HELD_BYTES`.
 */
export const IMPORT_INFLATE_BUDGET_BYTES = 3_000_000_000;

/**
 * How many bytes of files kept for the course repository one import may hold.
 * Every one of them is held — as base64, a third larger — until the import's
 * single commit, on a 2 GB machine that also holds the uploaded ZIP. Images and
 * video barely compress, so a real export's repository files come to about the
 * size of its ZIP (150 MB at most); only an archive built to inflate gets here.
 */
export const IMPORT_REPO_HELD_BYTES = 256 * 1024 * 1024;

/** A running total of bytes against a limit. */
export class ImportByteBudget {
  private used = 0;
  constructor(readonly limitBytes: number) {}

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
 * Everything one import counts as it places its entries: the bytes it has
 * inflated, and the bytes it holds for the repository commit. One per import,
 * shared by every entry it places — the theme's files included.
 */
export class ImportLimits {
  readonly inflated: ImportByteBudget;
  readonly repoHeld: ImportByteBudget;

  constructor({
    inflateBytes = IMPORT_INFLATE_BUDGET_BYTES,
    repoHeldBytes = IMPORT_REPO_HELD_BYTES,
  }: { inflateBytes?: number; repoHeldBytes?: number } = {}) {
    this.inflated = new ImportByteBudget(inflateBytes);
    this.repoHeld = new ImportByteBudget(repoHeldBytes);
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

/**
 * The warning for an entry left out because the import already holds as much
 * as it may for the course repository: `Skipped photo.png (30 MB) — this
 * import is over its 256 MB limit for files kept in the course repository`.
 */
export function importRepoHeldSkippedWarning(
  name: string,
  bytes: number,
  limitBytes: number
): string {
  return (
    `Skipped ${name} (${formatMegabytes(bytes)}) — this import is over its ` +
    `${formatMegabytes(limitBytes)} limit for files kept in the course repository`
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
 * could go, or one the import's limits cannot cover, is never inflated at all.
 * The same checks run again on the bytes, because a header is only a claim.
 * A file bound for media is written before this returns and its bytes are not
 * kept — the caller places the next entry with this one's memory released.
 */
export async function placeImportEntry({
  entry,
  capability,
  gate,
  limits,
  put,
  onError = () => {},
}: {
  entry: ImportZipEntry;
  capability: UploadCapability | null | undefined;
  gate: RepoEntryGate;
  /** The import's running totals — one per import, shared by every entry. */
  limits: ImportLimits;
  put: PutImportMedia;
  /** A refused media write, for the server log — the warning never carries it. */
  onError?: (filename: string, error: unknown) => void;
}): Promise<ImportPlacement> {
  const { filePath, filename } = entry;

  /** Leave the entry out if `bytes` fit nowhere, or not within a limit. */
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
      // Held until the commit, together with every other repository file.
      if (!limits.repoHeld.fits(bytes)) {
        gate.skip(
          filename,
          bytes,
          filePath,
          importRepoHeldSkippedWarning(filename, bytes, limits.repoHeld.limitBytes)
        );
        return true;
      }
    }
    if (!limits.inflated.fits(bytes)) {
      gate.skip(
        filename,
        bytes,
        filePath,
        importBudgetSkippedWarning(filename, bytes, limits.inflated.limitBytes)
      );
      return true;
    }
    return false;
  };

  if (entry.declared !== null && leftOut(entry.declared)) return { kind: 'skipped' };

  const buffer = await entry.inflate();
  if (leftOut(buffer.length)) return { kind: 'skipped' };
  limits.inflated.spend(buffer.length);

  if (!importEntryGoesToMedia(capability, filename, buffer.length)) {
    limits.repoHeld.spend(buffer.length);
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
