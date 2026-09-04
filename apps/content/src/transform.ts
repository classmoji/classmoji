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

/**
 * Ceiling on the bytes we are willing to materialize for a transform.
 *
 * The transform path is the one place this Worker buffers a whole object, and
 * it does so inside a shared 128 MB isolate serving every concurrent request on
 * the colo. GitHub will hand us blobs up to 100 MB, and a handful of those
 * arriving together is an OOM that takes down unrelated traffic. Past this
 * ceiling the transform is skipped and the original is streamed instead — a
 * large image beats a dead isolate.
 */
export const MAX_TRANSFORM_SOURCE_BYTES = 20 * 1024 * 1024;

/**
 * Read a stream into one buffer, refusing to grow past `limit`.
 *
 * Returns null — having cancelled the rest of the source — when the stream is
 * bigger than the ceiling. For a source whose size is unknown up front, this is
 * the only way to hold the bound: `arrayBuffer()` commits to the whole thing
 * before it knows how big it is.
 *
 * Each chunk is dropped as it is copied into the result. Holding the chunk list
 * and the merged buffer at once would put peak usage at twice the ceiling,
 * which is the number that actually has to fit in the isolate.
 */
export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number
): Promise<ArrayBuffer | null> {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array | undefined> = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk) continue;
    merged.set(chunk, offset);
    offset += chunk.byteLength;
    chunks[index] = undefined;
  }
  return merged.buffer;
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
