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
 * Memory is the constraint that shapes `placeImportEntry`, on a 2 GB machine.
 * A ZIP under the upload cap can hold entries that inflate to gigabytes, and
 * the size its header declares is the uploader's word, so:
 *
 *   - an entry is judged by its DECLARED size before anything is inflated, and
 *     then inflated as a stream that stops the moment it passes that size
 *     (`inflateAtMost`) — a forged header costs its own size, no more;
 *   - entries are placed one at a time (inflate → store → drop);
 *   - one entry is held whole while it is placed (`putMediaObject` takes a
 *     Buffer), so a media-bound entry may not be over `IMPORT_ENTRY_MAX_BYTES`,
 *     and one bound for the repository is already under its 35 MB cap;
 *   - the files kept for the repository are held until the import's one
 *     commit, so their total is capped (`IMPORT_REPO_HELD_BYTES`);
 *   - everything inflated counts against one budget (`IMPORT_INFLATE_BUDGET_BYTES`).
 *
 * The limits live on one `ImportLimits` per import.
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
  type VideoOptions,
} from './mediaUpload.ts';
import { EntrySizeError, type RepoEntryGate } from './zipRepoEntries.ts';

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
 * What a full media store says, as the server wrote it (or the shared sentence
 * when it wrote none); null for any other refusal.
 */
export function importQuotaSentence(error: unknown): string | null {
  const failure = error as { code?: unknown; message?: unknown } | null;
  if (failure?.code !== 'QUOTA_EXCEEDED') return null;
  return typeof failure.message === 'string' && failure.message.trim()
    ? failure.message.trim()
    : MEDIA_QUOTA_FULL_MESSAGE;
}

/** The gate group every entry left out for a full media store shares. */
export const MEDIA_FULL_GROUP = 'media-full';

/**
 * The warning for a file left out because media storage would not take it:
 * `Skipped lecture.mp4 (40 MB) — media storage could not take it (it is over the
 * limit for one file)`. A full quota says what the server says — who to contact
 * — rather than a phrase of ours: `Skipped lecture.mp4 (40 MB) — This class's
 * media storage is full. Contact hello@classmoji.io to upgrade.`
 */
export function importMediaSkippedWarning(name: string, bytes: number, error: unknown): string {
  const quota = importQuotaSentence(error);
  if (quota !== null) return `Skipped ${name} (${formatMegabytes(bytes)}) — ${quota}`;
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

const MiB = 1024 * 1024;

/**
 * How many bytes one import may inflate in total, across every entry — the
 * repository's and media's alike. Well under the machine's memory: a real
 * export inflates to about the size of its ZIP (150 MB at most — images and
 * video barely compress), so only an archive built to inflate gets near it.
 */
export const IMPORT_INFLATE_BUDGET_BYTES = 512 * MiB;

/**
 * How many bytes of files kept for the course repository one import may hold.
 * Every one of them is held — as base64, a third larger — until the import's
 * single commit, beside the uploaded ZIP itself.
 */
export const IMPORT_REPO_HELD_BYTES = 256 * MiB;

/**
 * The most one media-bound entry may be. It is held whole while it is written
 * (`putMediaObject` takes a Buffer, and inflating it peaks near twice its
 * size), so this — not media's 2 GB per-file ceiling — is what one entry can
 * cost. A file this large would not fit in the ZIP to begin with.
 */
export const IMPORT_ENTRY_MAX_BYTES = 256 * MiB;

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
 * inflated, the bytes it holds for the repository commit, and whether media
 * storage has already said it is full. One per import, shared by every entry
 * it places — the theme's files included.
 */
export class ImportLimits {
  readonly inflated: ImportByteBudget;
  readonly repoHeld: ImportByteBudget;
  /**
   * The full-quota sentence, once media storage has answered with it. Every
   * later entry bound for media is left out on its declared size, without
   * being inflated: the store will not take it either.
   */
  mediaFull: string | null = null;

  constructor({
    inflateBytes = IMPORT_INFLATE_BUDGET_BYTES,
    repoHeldBytes = IMPORT_REPO_HELD_BYTES,
  }: { inflateBytes?: number; repoHeldBytes?: number } = {}) {
    this.inflated = new ImportByteBudget(inflateBytes);
    this.repoHeld = new ImportByteBudget(repoHeldBytes);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The deck itself
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The most of `index.html` an import will inflate. A slides.com export's
 * index.html is the deck's markup plus its inline theme CSS — tens to hundreds
 * of kilobytes (the test export's is 74 KB) — and cheerio builds a DOM several
 * times its size on top, so this is a ceiling nothing real comes near.
 */
export const INDEX_HTML_MAX_BYTES = 32 * MiB;

/** The sentence an import whose ZIP holds no index.html fails with. */
export const INDEX_HTML_MISSING_MESSAGE =
  'No index.html found in ZIP. Please ensure this is a valid slides.com export.';

/** The sentence an import whose index.html cannot be read fails with. */
export const INDEX_HTML_INVALID_MESSAGE =
  "The ZIP's index.html could not be read. Please ensure this is a valid slides.com export.";

/**
 * The export's index.html as text, inflating no more than
 * `INDEX_HTML_MAX_BYTES` of it and charging what it inflated to the import's
 * budget. `inflate` is `inflateAtMost` on the entry, or null when the ZIP has
 * none. An entry past the ceiling, or not the size its header declares, fails
 * the import as an export that is not one.
 */
export async function readImportIndexHtml(
  inflate: ((limitBytes: number) => Promise<Buffer>) | null,
  limits: ImportLimits
): Promise<string> {
  if (!inflate) throw new Error(INDEX_HTML_MISSING_MESSAGE);
  let buffer: Buffer;
  try {
    buffer = await inflate(INDEX_HTML_MAX_BYTES);
  } catch (error: unknown) {
    if (!(error instanceof EntrySizeError)) throw error;
    limits.inflated.spend(error.inflatedBytes);
    throw new Error(INDEX_HTML_INVALID_MESSAGE);
  }
  limits.inflated.spend(buffer.length);
  const html = buffer.toString('utf8');
  if (!html) throw new Error(INDEX_HTML_MISSING_MESSAGE);
  return html;
}

/**
 * The warning for an entry left out because the import has already inflated
 * as much as it may: `Skipped lecture.mp4 (90 MB) — this import is over its
 * 512 MB limit for all files together`.
 */
export function importBudgetSkippedWarning(
  name: string,
  bytes: number,
  limitBytes: number
): string {
  return (
    `Skipped ${name} (${formatMegabytes(bytes)}) — this import is over its ` +
    `${formatMegabytes(limitBytes)} limit for all files together`
  );
}

/**
 * The warning for one entry too large to import: `Skipped lecture.mp4
 * (300 MB) — it is over this import's 256 MB limit for one file`.
 */
export function importEntryTooLargeWarning(name: string, bytes: number): string {
  return (
    `Skipped ${name} (${formatMegabytes(bytes)}) — it is over this import's ` +
    `${formatMegabytes(IMPORT_ENTRY_MAX_BYTES)} limit for one file`
  );
}

/** The warning for an entry whose bytes are not the size the ZIP declared. */
export function importEntryMisdeclaredWarning(name: string): string {
  return `Skipped ${name} — its size does not match what the ZIP says`;
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
  /**
   * Decompress it, stopping past `limitBytes` with an `EntrySizeError`
   * (`inflateAtMost`). Called at most once, and only after the checks pass.
   */
  inflate(limitBytes: number): Promise<Buffer>;
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
    if (importEntryGoesToMedia(capability, filename, bytes)) {
      // Held whole while it is written, so it has to fit in memory as one.
      if (bytes > IMPORT_ENTRY_MAX_BYTES) {
        gate.skip(filename, bytes, filePath, importEntryTooLargeWarning(filename, bytes));
        return true;
      }
    } else {
      // The router says media only within media's own per-file ceiling (the
      // capability's, never a constant here), so anything it does not send
      // there has to fit the repository.
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

  /** Leave the entry out if it is bound for a media store that is full. */
  const mediaIsFull = (bytes: number): boolean => {
    if (limits.mediaFull === null || !importEntryGoesToMedia(capability, filename, bytes)) {
      return false;
    }
    gate.skip(filename, bytes, filePath, limits.mediaFull, MEDIA_FULL_GROUP);
    return true;
  };

  if (entry.declared !== null && (leftOut(entry.declared) || mediaIsFull(entry.declared))) {
    return { kind: 'skipped' };
  }

  // Never more than the header declared (every check above passed on that
  // size), and with no header, never more than one entry or the budget left.
  const limit =
    entry.declared ??
    Math.min(IMPORT_ENTRY_MAX_BYTES, limits.inflated.limitBytes - limits.inflated.usedBytes);

  let buffer: Buffer;
  try {
    buffer = await entry.inflate(limit);
  } catch (error: unknown) {
    if (!(error instanceof EntrySizeError)) throw error;
    // Stopped part-way: the header said otherwise, or (with no header) it ran
    // past a limit, which `leftOut` names.
    if (entry.declared !== null || !leftOut(error.inflatedBytes)) {
      gate.skip(filename, error.inflatedBytes, filePath, importEntryMisdeclaredWarning(filename));
    }
    return { kind: 'skipped' };
  }
  if (leftOut(buffer.length) || mediaIsFull(buffer.length)) return { kind: 'skipped' };
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
    const quota = importQuotaSentence(error);
    if (quota !== null) {
      // Full: this entry and every later one bound for media share ONE warning.
      limits.mediaFull = quota;
      gate.skip(filename, buffer.length, filePath, quota, MEDIA_FULL_GROUP);
    } else {
      gate.skip(
        filename,
        buffer.length,
        filePath,
        importMediaSkippedWarning(filename, buffer.length, error)
      );
    }
    return { kind: 'skipped' };
  }
}
