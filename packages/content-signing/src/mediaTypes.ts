/**
 * Extension → Content-Type for the media store, in the one place both sides can
 * read it.
 *
 * The app decides this type at upload time and writes it onto the R2 object;
 * the Worker falls back to it when an object has no stored type, so an
 * `orig.{ext}` variant is served as what it is rather than as an opaque
 * download. Two copies of this table would drift into exactly that: a file the
 * app accepted as `video/quicktime` handed to the browser as
 * `application/octet-stream`, which plays nowhere.
 *
 * It lives in the signing package for the same reason `mediaKey` does — the app
 * writes these objects and the Worker reads them, and the two must agree — and
 * it takes no dependency on anything else here: it is a frozen record and a
 * lookup, safe to import from a module that wants none of the crypto.
 *
 * What is NOT here is the kind grouping (`VIDEO`, `AUDIO`, …) or the upload
 * allowlist policy. Those belong to the app, which owns what may be uploaded;
 * this owns only what a byte stream is labelled as once it exists.
 *
 * Nothing executable is on the list, and that is load-bearing: these bytes are
 * served from a `.classmoji.io` origin. `key` (Keynote) is `application/zip`
 * because a .key bundle is one — Apple registers no distinct type, and
 * inventing one would only confuse the browsers that key a download off it.
 */
const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  // video
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  // audio
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  // documents
  pdf: 'application/pdf',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/zip',
  // archives
  zip: 'application/zip',
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * The type a media extension is stored and served with, or null when it is not
 * one the media store knows.
 *
 * Null rather than a default, because the two callers want different things
 * from a miss: the app refuses the upload outright, and the Worker falls back
 * to its own general table before giving up on `application/octet-stream`.
 */
export function contentTypeForMediaExt(ext: string): string | null {
  if (typeof ext !== 'string') return null;
  return MEDIA_CONTENT_TYPES[ext.toLowerCase()] ?? null;
}
