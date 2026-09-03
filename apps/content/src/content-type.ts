/** Extension → Content-Type. Anything unmapped is served as an opaque download. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
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
