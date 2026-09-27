/**
 * Where an uploaded file is stored: the course repository, media, or nowhere.
 *
 * ## The rule (decision §7.10, locked 2026-09-26)
 *
 *   - media is available AND (the file is a video OR it is over the
 *     repository's cap) → **media**. Pro video always goes to R2, and so does
 *     anything the repository cannot take;
 *   - otherwise, it fits the repository AND its type is one the classroom's
 *     repository policy takes → **repo**. Small images, documents and decks stay
 *     in git, where the course content stays portable — and on a classroom
 *     without media, a video that fits stays there too;
 *   - otherwise → **refused**, with a sentence the uploader can act on.
 *
 * ## Pure, and importable from the browser
 *
 * No Prisma, no S3 client, no network. The editors ask this BEFORE an upload
 * starts, with the capability their loader handed them, so the dialog can say
 * where a file will live — and every server upload entry asks it again from
 * the file it actually received (`assertRepoTarget`, `createUpload`), so what
 * the browser decided is never what is trusted. Client code imports it through
 * the `@classmoji/services/media/router` subpath, whose whole graph is this
 * file, the kind table and the repository's own file rule
 * (`content/utils/validateFile.ts`) — a guard test pins that.
 *
 * ## What it deliberately does not decide
 *
 * Quota. `media.remainingBytes` is for a dialog to show; the quota is enforced
 * by `createUpload`, under a lock, with the numbers in its refusal. A router
 * that refused on a stale remaining-bytes figure would disagree with the
 * server, and a Pro video bound for a full store would have no correct answer
 * here: it does not belong in the repository just because media is full.
 */

import { formatMegabytes } from '@classmoji/utils/repo-limits';
import { validateFile, type FileTypePolicy } from '../content/utils/validateFile.ts';
import { extensionOf, filenameRefusal, kindForExt, type MediaKind } from './mediaKinds.ts';
import { PER_FILE_MAX_BYTES } from './mediaQuota.ts';

/** Why a file cannot be stored anywhere this classroom can put it. */
export type StorageRefusalCode = 'TOO_LARGE_FOR_REPO' | 'MEDIA_UNAVAILABLE' | 'TYPE_NOT_ALLOWED';

export type StorageTarget =
  | { kind: 'repo' }
  | { kind: 'media' }
  | { kind: 'refused'; code: StorageRefusalCode; message: string };

/**
 * What a classroom's uploads can do — what a loader hands the client, and what
 * a server upload entry routes against.
 *
 * Built by `uploadCapabilityFor(classroom)` (server-only). Plain data, so it
 * crosses the loader boundary as JSON.
 */
export interface UploadCapability {
  /** The repository's per-file ceiling — `REPO_REST_MAX_BYTES`. */
  repoMaxBytes: number;
  /** `uploadFileTypes(classroom)`: any extension, or the image/PDF allowlist. */
  repoFileTypes: FileTypePolicy;
  /**
   * Whether the classroom is on Pro. Only decides what a refusal SAYS: a free
   * classroom's too-large refusal mentions what Pro stores; a Pro classroom is
   * not sold what it already has.
   */
  isPro: boolean;
  /** Null unless Pro AND media is configured AND the classroom can deliver. */
  media: null | {
    perFileMaxBytes: number;
    /** Quota left right now. For display — see the file header. */
    remainingBytes: number;
  };
}

const GIB = 1024 * 1024 * 1024;

/** `2 GB` — the per-file ceiling as a person reads it. */
function formatGigabytes(bytes: number): string {
  return `${Math.round((bytes / GIB) * 10) / 10} GB`;
}

/** A filename's kind by its extension; `OTHER` when it has none. */
export function kindOfFilename(name: string): MediaKind {
  const ext = extensionOf(name);
  return ext ? kindForExt(ext) : 'OTHER';
}

function refused(code: StorageRefusalCode, message: string): StorageTarget {
  return { kind: 'refused', code, message };
}

/**
 * Where `file` goes, for a classroom that can do `cap`. See the file header.
 *
 * `file.kind` overrides the kind read from the name, for a caller that already
 * classified it; nothing else about the file is taken on trust from anywhere
 * but its name and its size.
 */
export function storageTargetFor(
  cap: UploadCapability,
  file: { name: string; size: number; kind?: MediaKind }
): StorageTarget {
  const kind = file.kind ?? kindOfFilename(file.name);
  const overRepo = file.size > cap.repoMaxBytes;

  if (cap.media && (kind === 'VIDEO' || overRepo)) {
    // Media takes any extension it can address; the refusal says which of its
    // two shapes this name missed.
    const nameRefusal = filenameRefusal(file.name);
    if (nameRefusal) return refused('TYPE_NOT_ALLOWED', nameRefusal);
    if (file.size > cap.media.perFileMaxBytes) {
      return refused(
        'MEDIA_UNAVAILABLE',
        `This file is larger than the ${formatGigabytes(cap.media.perFileMaxBytes)} limit for one file.`
      );
    }
    return { kind: 'media' };
  }

  if (!overRepo) {
    // The repository's own rule, with the classroom's own policy — the same
    // call every repository write makes, so this cannot promise a file the
    // commit would then refuse. The size is checked above; this is the name
    // and the type.
    const check = validateFile({
      filename: file.name,
      size: file.size,
      fileTypes: cap.repoFileTypes,
    });
    if (!check.valid) {
      return refused('TYPE_NOT_ALLOWED', check.error ?? 'This file type cannot be uploaded here.');
    }
    return { kind: 'repo' };
  }

  const tooLarge = `This file is larger than the ${formatMegabytes(cap.repoMaxBytes)} your course repository accepts.`;
  return refused(
    'TOO_LARGE_FOR_REPO',
    cap.isPro ? tooLarge : `${tooLarge} Pro stores files up to ${formatGigabytes(PER_FILE_MAX_BYTES)}.`
  );
}
