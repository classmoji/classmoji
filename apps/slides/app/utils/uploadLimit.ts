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
 * Read a body into its chunks, giving up as soon as it exceeds `maxBytes`.
 *
 * The chunks are handed back AS THEY ARRIVED rather than joined, because a
 * 35 MB upload is large enough that every avoidable copy of it is a second
 * 35 MB of heap held at the same moment. The callers below each consume the
 * list in the way that costs them least.
 *
 * The stream is cancelled rather than drained on refusal, so the sender is told
 * to stop instead of being allowed to finish sending 10 GB into a buffer we
 * have already decided to throw away.
 */
export async function readLimitedChunks(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<{ chunks: Uint8Array[]; size: number }> {
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
        // Drop what was kept before throwing: the caller never sees this list,
        // and the error can travel a long way up before anything is collected.
        chunks.length = 0;
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

  return { chunks, size: seen };
}

/**
 * The same read, joined into one buffer for a caller that needs contiguous
 * bytes. `readLimitedFormData` deliberately does NOT use this — see there.
 */
export async function readLimitedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
  const { chunks, size } = await readLimitedChunks(body, maxBytes);

  const joined = new Uint8Array(size);
  let at = 0;
  // `shift` rather than `for…of`: each chunk is released the moment it has been
  // copied, so the peak is the joined buffer plus what is still waiting rather
  // than two whole copies of the body.
  for (let chunk = chunks.shift(); chunk; chunk = chunks.shift()) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return joined;
}

/** A stream over an already-read chunk list, releasing each one as it goes. */
function streamOfChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (!next) {
        controller.close();
        return;
      }
      controller.enqueue(next);
    },
    cancel() {
      chunks.length = 0;
    },
  });
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
 * The `Response` is built around a STREAM of the chunks we kept, not a
 * concatenation of them. The parser assembles its own contiguous copy either
 * way; handing it a joined buffer as well would mean holding two whole copies
 * of a 35 MB upload at once, on top of the file part the parser then produces.
 * Draining the list releases our references as the parser takes them.
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

  const { chunks } = await readLimitedChunks(body, maxBytes);
  const contentType = request.headers.get('content-type');
  return new Response(streamOfChunks(chunks), {
    headers: contentType ? { 'Content-Type': contentType } : {},
  }).formData();
}
