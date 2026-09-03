import type { Env } from './env.ts';
import type { TransformFormat } from './verify.ts';

/** The formats we actually store. `auto` is resolved before a key is derived. */
export type ConcreteFormat = 'webp' | 'avif';

/**
 * Resolve `fmt=auto` against the browser's `Accept` header. A stored variant is
 * always keyed by the concrete format, so two browsers never share a cache
 * entry that only one of them can decode.
 */
export function negotiateFormat(
  requested: TransformFormat | undefined,
  accept: string | null
): ConcreteFormat {
  if (requested === 'avif') return 'avif';
  if (requested === 'webp') return 'webp';
  return accept?.includes('image/avif') ? 'avif' : 'webp';
}

export type ConcreteMediaType = 'image/webp' | 'image/avif';

export function mediaTypeFor(format: ConcreteFormat): ConcreteMediaType {
  return `image/${format}`;
}

/**
 * Resize + re-encode via the Images binding. Returns `null` when Images cannot
 * do it (unsupported source, quota, anything else) — the caller then serves the
 * original bytes, because a slower image beats a broken one.
 *
 * EXIF, including GPS: there is no `metadata` option on the binding. It exists
 * on the `cf.image` fetch API and is typed on `RequestInitCfPropertiesImage`,
 * but the binding's `ImageTransform` / `ImageOutputOptions` accept no such key,
 * so passing one risks the whole call being rejected and every image silently
 * falling back to an un-resized original. It is also unnecessary here: we only
 * ever emit webp or avif, and both discard all metadata unconditionally —
 * `metadata` only ever governed JPEG output.
 * https://developers.cloudflare.com/images/optimization/features/#metadata
 *
 * That guarantee holds only for transformed bytes. Untransformed originals —
 * the plain blob path, and the fallback below — are streamed through verbatim,
 * EXIF included, exactly as GitHub stores them. Stripping there would mean
 * decoding every image on a cache miss; the place to strip is upload.
 */
export async function transformImage(
  env: Env,
  source: ArrayBuffer,
  width: number,
  format: ConcreteFormat
): Promise<ArrayBuffer | null> {
  try {
    const stream = new Response(source).body;
    if (!stream) return null;
    const result = await env.IMAGES.input(stream)
      .transform({ width, fit: 'scale-down' })
      .output({ format: mediaTypeFor(format) });
    return await result.response().arrayBuffer();
  } catch (error) {
    console.warn(`[content] image transform failed (w=${width}, fmt=${format}):`, error);
    return null;
  }
}
