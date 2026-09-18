/**
 * uploadLimit.ts — refuse an over-sized upload BEFORE it is in memory.
 *
 * `request.formData()` reads the whole multipart body into memory and only then
 * hands back a `File` whose `.size` you can check. For the 150 MB slides.com
 * ZIP that was tolerable because the route is rare and staff-only; for slide
 * files it is the difference between a 413 and a process that has just
 * allocated whatever an unauthenticated stranger felt like sending.
 *
 * So two gates, in this order:
 *
 *  1. `Content-Length`, read from the headers before the body is touched at
 *     all. Cheap, and it covers every real browser upload.
 *  2. A byte count while the body streams, which is what actually enforces the
 *     cap: `Content-Length` is client-supplied and absent entirely on a chunked
 *     request, so a limit that trusted it would be no limit at all. The read is
 *     abandoned — and the connection cancelled — the moment the count crosses.
 *
 * The cap passed in is a TRANSPORT cap: the multipart envelope, the boundary
 * markers and the other form fields all ride in the same body, so it has to be
 * the file limit plus slack. The authoritative per-FILE check stays where the
 * policy lives (`validateSlideFile`), which the caller runs on the parsed part.
 *
 * Pure enough to unit test: no Prisma, no services, web APIs only.
 */

/** Slack for the multipart envelope and the other fields riding with the file. */
export const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

/** The transport cap for a body carrying one file of at most `fileMaxBytes`. */
export function uploadBodyLimit(fileMaxBytes: number): number {
  return fileMaxBytes + MULTIPART_OVERHEAD_BYTES;
}

/**
 * The body was, or was going to be, bigger than we accept.
 *
 * 413 rather than 400: nothing about the request was malformed, there was just
 * too much of it, and a route that answered 400 would send an instructor
 * looking for a typo in a filename.
 */
export class UploadTooLargeError extends Error {
  status = 413 as const;
  code = 'UPLOAD_TOO_LARGE' as const;

  constructor(public readonly limitBytes: number) {
    super(`Upload exceeds the ${limitBytes} byte limit.`);
    this.name = 'UploadTooLargeError';
  }
}

/**
 * The body size the client DECLARED, or null when it declared nothing usable.
 *
 * Null is not "zero": a chunked upload sends no `Content-Length` at all, and
 * treating that as an empty body would wave it straight past the first gate.
 * The caller must fall through to the streaming count for those.
 */
export function declaredBodyBytes(headers: Headers): number | null {
  const raw = headers.get('content-length');
  if (raw === null || raw.trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** True when the declared size alone is already enough to refuse the request. */
export function declaredBodyTooLarge(headers: Headers, maxBytes: number): boolean {
  const declared = declaredBodyBytes(headers);
  return declared !== null && declared > maxBytes;
}

/**
 * Read a request body, giving up as soon as it exceeds `maxBytes`.
 *
 * The stream is cancelled rather than drained on refusal, so the sender is told
 * to stop instead of being allowed to finish sending 10 GB into a buffer we
 * have already decided to throw away.
 */
export async function readLimitedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      seen += value.byteLength;
      if (seen > maxBytes) {
        throw new UploadTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } catch (error: unknown) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(seen);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return joined;
}

/**
 * `request.formData()`, with the two gates above in front of it.
 *
 * Re-parsed out of a `Response` rather than a second `Request` on purpose: a
 * `Request` built around a stream needs `duplex: 'half'` and carries the
 * original (now wrong) `Content-Length` with it, and neither quirk is worth
 * inheriting when the multipart parser only ever wanted the bytes and the
 * boundary.
 *
 * Throws `UploadTooLargeError` for an over-cap body. Everything else — a
 * truncated part, a missing boundary — comes out of the parser unchanged.
 */
export async function readLimitedFormData(request: Request, maxBytes: number): Promise<FormData> {
  if (declaredBodyTooLarge(request.headers, maxBytes)) {
    throw new UploadTooLargeError(maxBytes);
  }

  const body = request.body;
  // No stream to meter (a body already buffered by a test double, or an empty
  // one): the declared-size gate above is all there is, and the parser is the
  // same one either way.
  if (!body) return request.formData();

  const bytes = await readLimitedBody(body, maxBytes);
  const contentType = request.headers.get('content-type');
  return new Response(bytes, {
    headers: contentType ? { 'Content-Type': contentType } : {},
  }).formData();
}
