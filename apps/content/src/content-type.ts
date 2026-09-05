/**
 * Extension → Content-Type. Anything unmapped is served as an opaque download.
 *
 * The type comes from the EXTENSION and from nothing else — the bytes are never
 * inspected. That is deliberate, and it is what makes serving TEXT here safe:
 * a `.html` blob is `text/html; charset=utf-8` because the URL said `.html`,
 * and a signature covers the extension, so a caller cannot re-label one file as
 * another. `nosniff` plus the sandboxing CSP on every response (see cache.ts)
 * does the rest: an `.html` opened directly is an inert document in an opaque
 * origin, not script running on a cookie-bearing domain.
 *
 * Text types carry `charset=utf-8` explicitly. Without it a browser falls back
 * to its own locale default and a deck's smart quotes come out as mojibake on
 * exactly the machines nobody tests on.
 *
 * `svg` stays an image and stays OUT of `RASTER_EXTENSIONS` below: it is
 * resolution-independent, so rasterizing it is a downgrade rather than a
 * variant.
 */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
};

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** Extensions Cloudflare Images can decode. Only these are ever sent to a transform. */
const RASTER_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'avif',
  'gif',
]);

export function contentTypeForExtension(ext: string): string {
  return BY_EXTENSION[ext.toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

/** Lowercased extension of a path, or '' when there is none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function contentTypeForPath(path: string): string {
  return contentTypeForExtension(extensionOf(path));
}

export function isRasterExtension(ext: string): boolean {
  return RASTER_EXTENSIONS.has(ext.toLowerCase());
}
