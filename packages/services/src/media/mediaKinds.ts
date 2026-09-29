/**
 * What may be uploaded, and what it is served as.
 *
 * ## Any file with an extension
 *
 * Media is where a Pro classroom's large files go — video always, and anything
 * over the repository's REST ceiling (decision §7.10) — so it takes the same
 * files the repository takes under its `'any'` policy: any extension at all,
 * as long as there IS one. "Has an extension" is decided by the repository's
 * own rule (`sanitizedExtension` in `content/utils/validateFile.ts`: the text
 * after the last dot, lowercase letters and digits only), so a name one store
 * accepts is not refused by the other for its shape.
 *
 * One narrower limit: the extension has to fit the variant grammar the signer
 * and the Worker share, `orig.{ext}` with at most 8 characters. The repository
 * rule keeps up to 16, so a `.longextension` file is refused here with a
 * sentence that says why, rather than accepted and then unaddressable.
 *
 * ## The content type is still decided HERE, never taken from the client
 *
 * An extension this store knows (`MEDIA_KINDS`) is stored with its real type,
 * from the table in `@classmoji/content-signing` the Worker also falls back
 * on. Anything else is `application/octet-stream`: an opaque download. That is
 * what keeps `x.html` or `x.svg` from being served as a page — it is stored
 * and served as bytes to save, and the Worker's `nosniff` and sandboxing CSP
 * sit on top of that. A declared `file.type` has no way in.
 *
 * The extension → content-type mapping itself is NOT here. It lives in
 * `@classmoji/content-signing` (reached through `mediaKeys.ts`, this folder's
 * one door onto that package) because the Worker needs the identical table to
 * fall back on when an object carries no stored type.
 */

import {
  extensionLength,
  extensionTooLongMessage,
  sanitizedExtension,
} from '../content/utils/validateFile.ts';
import { contentTypeForMediaExt, origVariant } from './mediaKeys.ts';

export type MediaKind = 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'ARCHIVE' | 'IMAGE' | 'OTHER';

/** Served as a download: the type of anything this store has no mapping for. */
export const OPAQUE_CONTENT_TYPE = 'application/octet-stream';

interface KindSpec {
  kind: Exclude<MediaKind, 'OTHER'>;
  /** The extensions this kind accepts, lowercase and dotless. */
  exts: readonly string[];
}

/**
 * The extensions this store knows, grouped by kind. Every other extension is
 * `OTHER`. Lowercase and dotless — the same shape `mediaKey`'s `orig.{ext}`
 * variant needs.
 */
export const MEDIA_KINDS: readonly KindSpec[] = [
  { kind: 'VIDEO', exts: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv'] },
  // `.ogg` is audio by convention (Ogg Vorbis/Opus); Ogg video is `.ogv`.
  { kind: 'AUDIO', exts: ['mp3', 'm4a', 'wav', 'ogg', 'oga', 'aac', 'flac'] },
  { kind: 'DOCUMENT', exts: ['pdf', 'ppt', 'pptx', 'key'] },
  { kind: 'ARCHIVE', exts: ['zip'] },
  { kind: 'IMAGE', exts: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
];

const BY_EXT = new Map<string, { kind: MediaKind; contentType: string }>(
  MEDIA_KINDS.flatMap(spec =>
    spec.exts.map(ext => {
      const contentType = contentTypeForMediaExt(ext);
      // A known extension with no type would be served as an opaque download
      // by a store that had just promised to know what it was. The two lists
      // are meant to be the same set, so a drift fails at import rather than
      // at an upload months later.
      if (contentType === null) {
        throw new TypeError(`media: no content type for known extension .${ext}`);
      }
      return [ext, { kind: spec.kind, contentType }] as const;
    })
  )
);

/**
 * A filename → its canonical extension, or null when it has none.
 *
 * The repository's rule (`sanitizedExtension`): only the last dot counts, a
 * leading-dot file (`.gitignore`) has no extension, and what is kept is the
 * lowercase letters and digits of it. A path prefix is dropped first — only
 * the basename's extension is the file's. Nothing here sanitizes the NAME: the
 * filename is display-only and never becomes a path, because the R2 key is
 * built from the row's uuid.
 */
export function extensionOf(filename: string): string | null {
  if (typeof filename !== 'string') return null;
  return sanitizedExtension(basenameOf(filename)) || null;
}

/** The part of a path after its last `/` or `\` — the file's own name. */
function basenameOf(filename: string): string {
  return filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1);
}

/** The kind an extension belongs to: a known one, or `OTHER`. */
export function kindForExt(ext: string): MediaKind {
  return BY_EXT.get(ext?.toLowerCase?.() ?? '')?.kind ?? 'OTHER';
}

/** The content type an extension is stored and served with. */
export function contentTypeForExt(ext: string): string {
  return BY_EXT.get(ext?.toLowerCase?.() ?? '')?.contentType ?? OPAQUE_CONTENT_TYPE;
}

/**
 * Why a filename cannot be stored, as a sentence for the uploader, or null when
 * it can. The two refusals are the two shapes the store cannot address: no
 * extension at all, and one longer than the variant grammar allows.
 */
export function filenameRefusal(filename: string): string | null {
  const ext = extensionOf(filename);
  if (!ext) return 'This file needs an extension, e.g. notes.txt';
  if (origVariant(ext) === null) {
    return extensionTooLongMessage(ext, extensionLength(basenameOf(filename)));
  }
  return null;
}

/**
 * Everything a create needs to know about a filename, or null when it cannot
 * be stored (see `filenameRefusal` for the reason). One call rather than three,
 * so a caller cannot check the kind and then forget the content type.
 */
export function classifyFilename(
  filename: string
): { ext: string; kind: MediaKind; contentType: string } | null {
  if (filenameRefusal(filename) !== null) return null;
  const ext = extensionOf(filename)!;
  return { ext, kind: kindForExt(ext), contentType: contentTypeForExt(ext) };
}

/** The extensions of one kind, lowercase and dotless — `MEDIA_KINDS`' own list. */
export function extensionsOfKind(kind: MediaKind): string[] {
  return [...(MEDIA_KINDS.find(spec => spec.kind === kind)?.exts ?? [])];
}

/** The extensions this store has a real type for — the named kinds. */
export function knownExtensions(): string[] {
  return [...BY_EXT.keys()];
}
