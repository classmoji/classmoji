/**
 * What may be uploaded, and what it is served as.
 *
 * ## The allowlist is the whole defence
 *
 * The content type on a media object is decided HERE, from the extension, and
 * never taken from the client. An uploader who names a file `x.html` is refused
 * outright rather than served `text/html` from a classmoji.io origin; one who
 * declares `video/mp4` for an HTML payload gets `video/mp4` back, which no
 * browser will run. The Worker adds `nosniff` and a sandboxed CSP on top, so
 * three separate things would have to be wrong at once.
 *
 * Images are on the list even though small ones belong in the content repo:
 * the 5 MB page-asset cap is a git limit, and an instructor with a 40 MB scan
 * needs somewhere to put it. Nothing routes an image here automatically.
 */

export type MediaKind = 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'ARCHIVE' | 'IMAGE';

interface KindSpec {
  kind: MediaKind;
  /** ext → the content type the object is stored and served with. */
  types: Readonly<Record<string, string>>;
}

/**
 * The allowlist, grouped by kind. Extensions are lowercase and dotless — the
 * same shape `mediaKey`'s `orig.{ext}` variant needs.
 *
 * `key` (Keynote) is `application/zip` because that is what a .key bundle
 * actually is; Apple registers no distinct type and inventing one would only
 * confuse the browsers that do content-type-based downloads.
 */
export const MEDIA_KINDS: readonly KindSpec[] = [
  {
    kind: 'VIDEO',
    types: {
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      m4v: 'video/x-m4v',
    },
  },
  {
    kind: 'AUDIO',
    types: {
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      wav: 'audio/wav',
    },
  },
  {
    kind: 'DOCUMENT',
    types: {
      pdf: 'application/pdf',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      key: 'application/zip',
    },
  },
  {
    kind: 'ARCHIVE',
    types: { zip: 'application/zip' },
  },
  {
    kind: 'IMAGE',
    types: {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
    },
  },
];

const BY_EXT = new Map<string, { kind: MediaKind; contentType: string }>(
  MEDIA_KINDS.flatMap(spec =>
    Object.entries(spec.types).map(
      ([ext, contentType]) => [ext, { kind: spec.kind, contentType }] as const
    )
  )
);

/**
 * A filename → its canonical lowercase extension, or null.
 *
 * Only the last dot counts, and a leading-dot file (`.gitignore`) has no
 * extension at all rather than one called `gitignore`. Nothing here sanitizes
 * the NAME: the filename is display-only and never becomes a path, because the
 * R2 key is built from the row's uuid.
 */
export function extensionOf(filename: string): string | null {
  if (typeof filename !== 'string') return null;
  const name = filename.slice(filename.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** The kind an extension belongs to, or null when it is not on the allowlist. */
export function kindForExt(ext: string): MediaKind | null {
  return BY_EXT.get(ext?.toLowerCase?.() ?? '')?.kind ?? null;
}

/** The content type an extension is served with, or null when not allowed. */
export function contentTypeForExt(ext: string): string | null {
  return BY_EXT.get(ext?.toLowerCase?.() ?? '')?.contentType ?? null;
}

/**
 * Everything a create needs to know about a filename, or null when it is not
 * one this store accepts. One call rather than three, so a caller cannot check
 * the kind and then forget the content type.
 */
export function classifyFilename(
  filename: string
): { ext: string; kind: MediaKind; contentType: string } | null {
  const ext = extensionOf(filename);
  if (!ext) return null;
  const found = BY_EXT.get(ext);
  return found ? { ext, kind: found.kind, contentType: found.contentType } : null;
}

/** Every extension the store takes, for an upload picker's `accept` list. */
export function allowedExtensions(): string[] {
  return [...BY_EXT.keys()];
}
