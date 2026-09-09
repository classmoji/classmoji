/**
 * RFC 7233 single byte-range support.
 *
 * ## Why this exists
 *
 * Before this, every blob was answered `200` with the whole body no matter what
 * `Range` the client asked for, and no `Accept-Ranges` was ever sent. Safari
 * tolerates that; Chrome does not. Chrome's `<video>` element issues
 * `Range: bytes=0-<n>` to sniff the container, and a `200` carrying the whole
 * file in reply is treated as "this server cannot seek" — the element stays at
 * `readyState 0`, reports no duration, and never plays. A 1.35 MB `.webm` served
 * out of R2 reproduced it exactly.
 *
 * ## What is implemented
 *
 * One range, the common case and the only one a media element ever sends. A
 * multi-range request (`bytes=0-99,200-299`) is answered with the full `200`,
 * which RFC 7233 §3.1 explicitly allows — a server MAY ignore a `Range` it does
 * not wish to satisfy, and nothing in the fleet asks for two.
 *
 * Syntactically broken specs are IGNORED (full `200`), while syntactically valid
 * specs that fall outside the representation are `416`. That split is the
 * standard's, not ours: a garbled header is not a claim about the object, but
 * `bytes=9999999-` against a 1 MB file is, and it is a claim that is false.
 */

/** An inclusive byte range, already resolved against a known total size. */
export interface ByteRange {
  /** First byte position, inclusive. */
  readonly start: number;
  /** Last byte position, inclusive. Always >= `start`. */
  readonly end: number;
}

/**
 * What a `Range` header amounts to once the object's size is known.
 *
 * `full` covers three different reasons to send the whole thing — no header, a
 * header we are entitled to ignore, and a header that is not addressed to the
 * version we hold — because the response is identical in all three and the
 * caller has no reason to tell them apart.
 */
export type RangeOutcome =
  | { readonly kind: 'full' }
  | { readonly kind: 'partial'; readonly range: ByteRange }
  | { readonly kind: 'unsatisfiable' };

const FULL: RangeOutcome = { kind: 'full' };
const UNSATISFIABLE: RangeOutcome = { kind: 'unsatisfiable' };

/** `bytes=` and then at least one character, case-insensitive per RFC 7230. */
const BYTES_UNIT = /^bytes\s*=\s*(.+)$/i;

/** `first-last`, `first-`, or `-suffix`. Digits only — no signs, no spaces inside. */
const BYTE_RANGE_SPEC = /^(\d*)-(\d*)$/;

export function rangeLength(range: ByteRange): number {
  return range.end - range.start + 1;
}

/** `Content-Range` for a 206: the bytes served, and the size of the whole. */
export function contentRangeHeader(range: ByteRange, total: number): string {
  return `bytes ${range.start}-${range.end}/${total}`;
}

/** `Content-Range` for a 416: no bytes, and the size the client got wrong. */
export function unsatisfiedRangeHeader(total: number): string {
  return `bytes */${total}`;
}

/**
 * Resolve a `Range` header against an object of `total` bytes.
 *
 * `total` must be the size of the WHOLE object — the point of the exercise is
 * to turn an open-ended or suffix spec into concrete first/last positions, and
 * only the full size can do that.
 */
export function parseRange(header: string | null | undefined, total: number): RangeOutcome {
  if (header === null || header === undefined) return FULL;

  const unit = BYTES_UNIT.exec(header.trim());
  if (!unit) return FULL;

  const specs = unit[1].split(',');
  // More than one range is legal to ask for and legal to refuse. We refuse:
  // a multipart/byteranges body is a lot of machinery for a request shape no
  // client of this Worker sends.
  if (specs.length !== 1) return FULL;

  const spec = BYTE_RANGE_SPEC.exec(specs[0].trim());
  if (!spec) return FULL;

  const [, firstDigits, lastDigits] = spec;

  // `-` on its own is neither a suffix nor a position: malformed, so ignored.
  if (firstDigits === '' && lastDigits === '') return FULL;

  if (firstDigits === '') {
    // `bytes=-N`: the last N bytes. N=0 asks for nothing, which RFC 7233 §2.1
    // makes unsatisfiable rather than an empty 206.
    const suffix = Number(lastDigits);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || total === 0) return UNSATISFIABLE;
    return { kind: 'partial', range: { start: Math.max(0, total - suffix), end: total - 1 } };
  }

  const start = Number(firstDigits);
  if (!Number.isSafeInteger(start)) return FULL;
  // Past the end of what we hold — a valid ask about bytes that do not exist.
  if (total === 0 || start >= total) return UNSATISFIABLE;

  if (lastDigits === '') {
    // `bytes=N-`: everything from N on.
    return { kind: 'partial', range: { start, end: total - 1 } };
  }

  const last = Number(lastDigits);
  if (!Number.isSafeInteger(last)) return FULL;
  // last < first is not a range at all. Malformed, so ignored rather than 416.
  if (last < start) return FULL;
  // A last position past the end is clamped, not refused: the client asked for
  // "up to here", and here is the end.
  return { kind: 'partial', range: { start, end: Math.min(last, total - 1) } };
}

/**
 * Whether an `If-Range` validator still names the representation we hold.
 *
 * Deliberately only the strong-ETag comparison. `If-Range` also accepts an
 * HTTP-date, and a date will never equal a quoted etag, so a dated `If-Range`
 * falls out of here as "no match" and the client is sent the whole object —
 * which is exactly what `If-Range` is for: it is a conditional whose failure
 * mode is a correct full response, never an error. Weak etags (`W/"…"`) are
 * excluded by the same equality, and RFC 7232 §2.3.2 forbids using them for
 * range requests anyway.
 */
export function ifRangeMatches(ifRange: string | null | undefined, etag: string): boolean {
  if (ifRange === null || ifRange === undefined) return true;
  return ifRange.trim() === etag;
}

/**
 * A stream carrying only `[start, end]` of `source`, in bytes.
 *
 * The origin path needs this because a cache MISS still has to write the whole
 * object into R2 while answering the client with a slice of it. The body is
 * `tee()`d: one branch runs to the end and lands in R2, and this wraps the
 * other. Bytes before the range are read and dropped rather than held, and once
 * the last byte of the range is out the reader is cancelled — which, per the
 * streams spec, cancels only this branch and leaves the R2-bound one pulling.
 *
 * Chunks are copied rather than sub-viewed: both `tee()` branches receive the
 * same chunk object, and handing a view of it to the client while the other
 * branch is also holding it is a needless aliasing hazard for the few bytes it
 * saves.
 */
export function sliceStream(
  source: ReadableStream<Uint8Array>,
  start: number,
  end: number
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const stop = end + 1;
  let position = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (position >= stop) {
          controller.close();
          await reader.cancel().catch(() => {});
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          // The origin was shorter than its own declared length. Nothing more
          // to send; the length we already promised is the caller's problem,
          // and it is the same promise a full 200 would have made.
          controller.close();
          return;
        }
        const chunkStart = position;
        position += value.byteLength;
        if (position <= start) continue;

        const from = Math.max(0, start - chunkStart);
        const to = Math.min(value.byteLength, stop - chunkStart);
        if (to > from) {
          controller.enqueue(value.slice(from, to));
          return;
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}
