/**
 * multipartUpload.ts — browser-side S3 multipart upload against the media routes.
 *
 * A lecture video is hundreds of megabytes to a couple of gigabytes, which is
 * more than any of our servers will ever hold: the Cloudflare Worker refuses a
 * body over 100 MB and a Fly machine that proxied one would burn its memory and
 * its egress for nothing. So the bytes go straight from the browser to R2 over
 * presigned part URLs, and our own routes only ever exchange JSON — three small
 * calls to open, sign and close the upload.
 *
 * The shape is fixed by what S3 multipart needs:
 *
 *   create   → the server opens the multipart and tells us the part size
 *   parts    → presigned `UploadPart` URLs, asked for in small batches so a
 *              2 GB file does not mint four hundred signatures up front (each
 *              one is a short-lived credential and most would expire unused)
 *   PUT × n  → the only step that carries bytes, four at a time
 *   complete → the ETags, in part order, so S3 can stitch the object together
 *   abort    → only on failure or cancel: cancels the upload if it is still
 *              open. Sent once, on its own — never with the signal that just
 *              aborted — and not waited for: a cancel is over for the caller
 *              the moment it is asked for
 *
 * Nothing here is resumable across a reload; the multipart id lives for seven
 * days on R2's side, so adding that later is additive.
 *
 * Browser-only and dependency-free on purpose: it runs in a dialog, and `fetch`,
 * `File.slice` and `AbortSignal` are all it needs.
 */

/** Part numbers asked for in one `parts` call. */
const URL_BATCH_SIZE = 8;

/** Concurrent PUTs. Four saturates a home connection without starving the tab. */
const PART_CONCURRENCY = 4;

/** Backoff before the 1st, 2nd and 3rd retry of a part. Length = the retry budget. */
const RETRY_BACKOFF_MS = [500, 2_000, 8_000];

/**
 * How many times one part may ask for a fresh URL before we call it a loop.
 * Re-signing is not a retry — the previous attempt never reached R2 — so it has
 * its own budget, small enough that a server handing out dead signatures fails
 * fast instead of spinning.
 */
const MAX_URL_REFRESHES = 3;

/**
 * Treat a signature as dead this long before its stated expiry. A PUT of a
 * 32 MB part takes a while to even start, and a URL that expires mid-flight
 * fails after the bytes have been sent.
 */
const EXPIRY_SKEW_MS = 30_000;

/** Per-video choices from the upload dialog; ignored by the server for other kinds. */
export interface MediaUploadOptions {
  optimise?: boolean;
  keepOriginal?: boolean;
  allowDownload?: boolean;
  /**
   * "Store this in media" on purpose — Settings → Media's Upload button. Without
   * it the server refuses a non-video file that fits the course repository
   * (`USE_REPO`); an editor routes those to the repository itself.
   */
  explicit?: boolean;
}

export type MultipartUploadErrorCode =
  /** Media storage has no R2 credentials in this environment. */
  | 'NOT_CONFIGURED'
  /** The classroom is not on Pro. */
  | 'PRO_REQUIRED'
  /**
   * This classroom cannot serve content yet, so an upload would have nowhere to
   * be played from. Not a deployment problem — `NOT_CONFIGURED` is that one.
   */
  | 'DELIVERY_REQUIRED'
  /** Over the per-classroom quota; `usedBytes`/`quotaBytes` say by how much. */
  | 'QUOTA_EXCEEDED'
  /** Over the per-file ceiling. */
  | 'FILE_TOO_LARGE'
  /** The extension is not on the accepted list. */
  | 'KIND_NOT_ALLOWED'
  /** What arrived at R2 was not the size the client declared. */
  | 'SIZE_MISMATCH'
  /** The assembled object could not be read back, so it was discarded. */
  | 'VERIFY_FAILED'
  /**
   * The upload was open longer than its reservation lasts, and the server
   * cancelled it. Terminal: the same call cannot succeed, the file has to be
   * uploaded again from the start.
   */
  | 'UPLOAD_EXPIRED'
  /**
   * The storage router keeps this file in the course repository (not a video,
   * within the repository's cap) and the upload was not `explicit`.
   */
  | 'USE_REPO'
  /** The upload row is gone, or no longer in a state that accepts parts. */
  | 'NOT_FOUND'
  | 'BAD_STATE'
  /** The caller aborted via `signal`. Not a failure — the dialog stays quiet. */
  | 'ABORTED'
  /** Transport gave up: network error, or a 5xx/429 that outlived its retries. */
  | 'NETWORK';

/**
 * Everything this module rejects with, so a caller can branch on `code` instead
 * of matching message strings. `QUOTA_EXCEEDED` carries the numbers
 * (`usedBytes`/`quotaBytes`), and — like every refusal the routes word —
 * the server's own sentence as `serverMessage`, which is what a dialog shows:
 * for a full store it says who to contact to upgrade, and that wording is the
 * server's, not the dialog's.
 */
export class MultipartUploadError extends Error {
  readonly code: MultipartUploadErrorCode;
  readonly status?: number;
  readonly usedBytes?: number;
  readonly quotaBytes?: number;
  /**
   * The sentence the server sent with its refusal (`body.message`), when it
   * sent one. Absent for a bodyless answer, where `message` is only this
   * module's `Upload failed (409).` stand-in and not something to show.
   */
  readonly serverMessage?: string;

  constructor(
    code: MultipartUploadErrorCode,
    message: string,
    extra: {
      status?: number;
      usedBytes?: number;
      quotaBytes?: number;
      serverMessage?: string;
      cause?: unknown;
    } = {}
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'MultipartUploadError';
    this.code = code;
    this.serverMessage = extra.serverMessage;
    this.status = extra.status;
    this.usedBytes = extra.usedBytes;
    this.quotaBytes = extra.quotaBytes;
  }
}

/**
 * Bytes are counted on part COMPLETION, never in flight, which is what makes
 * the number monotonic: a part that fails halfway and is retried has never
 * contributed anything to subtract.
 */
export interface MultipartUploadProgress {
  sentBytes: number;
  totalBytes: number;
  /** The part that just landed; 0 for the opening report, before any PUT. */
  part: number;
  partCount: number;
}

export interface MultipartUploadArgs {
  file: File;
  classroomId: string;
  options?: MediaUploadOptions;
  /** Route prefix; the four media routes hang off it. */
  endpoints?: { base: string };
  onProgress?: (progress: MultipartUploadProgress) => void;
  signal?: AbortSignal;
}

export interface MultipartUploadResult {
  mediaId: string;
  /** `media://{mediaId}` — what gets stored in content.json / deck.json. */
  ref: string;
}

interface CreateUploadResponse {
  mediaId: string;
  uploadId: string;
  partSize: number;
  partCount: number;
  /**
   * Assigned by the server from the extension, never from `File.type`: it is
   * what the presigned URL was signed with, so the PUT has to repeat it
   * verbatim or the signature will not match.
   */
  contentType?: string;
}

interface SignedPart {
  partNumber: number;
  url: string;
  /** ISO timestamp; absent means "do not pre-empt, just use it". */
  expiresAt?: string;
}

const DEFAULT_BASE = '/api/media';

/**
 * Status → code, for a server that answered with a bare status and no body.
 *
 * A fallback and only that. Four of our refusals share 409 —
 * `QUOTA_EXCEEDED`, `DELIVERY_REQUIRED`, `SIZE_MISMATCH`, `BAD_STATE` — so the
 * status alone cannot tell them apart and `errorFromResponse` reads the body's
 * `error` FIRST. What sits here for 409 is the likeliest of the four for a
 * bodyless answer, not a decision.
 */
const STATUS_CODES: Record<number, MultipartUploadErrorCode> = {
  403: 'PRO_REQUIRED',
  404: 'NOT_FOUND',
  409: 'QUOTA_EXCEEDED',
  410: 'UPLOAD_EXPIRED',
  413: 'FILE_TOO_LARGE',
  422: 'KIND_NOT_ALLOWED',
  503: 'NOT_CONFIGURED',
};

/** Every code the routes send. One missing here is silently read as its status. */
const KNOWN_CODES = new Set<string>([
  'NOT_CONFIGURED',
  'PRO_REQUIRED',
  'DELIVERY_REQUIRED',
  'QUOTA_EXCEEDED',
  'FILE_TOO_LARGE',
  'KIND_NOT_ALLOWED',
  'SIZE_MISMATCH',
  'VERIFY_FAILED',
  'UPLOAD_EXPIRED',
  'USE_REPO',
  'NOT_FOUND',
  'BAD_STATE',
]);

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === 'AbortError'
    : (error as Error)?.name === 'AbortError';

const aborted = () => new MultipartUploadError('ABORTED', 'Upload cancelled.');

/** Sleep that gives up the moment the caller cancels, rather than after 8 s. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(aborted());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * An error response turned into a typed one.
 *
 * The body is the first source — the routes answer `{ error: 'QUOTA_EXCEEDED',
 * message, usedBytes, quotaBytes }`, and `message` is kept apart as
 * `serverMessage` so a dialog can show it verbatim — and the status is the
 * fallback for anything that failed before a handler ran (a proxy 503, say).
 */
async function errorFromResponse(response: Response): Promise<MultipartUploadError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // A non-JSON body (an HTML error page) tells us nothing the status does not.
  }

  const raw = typeof body.error === 'string' ? body.error : (body.code as string | undefined);
  const code: MultipartUploadErrorCode =
    raw && KNOWN_CODES.has(raw)
      ? (raw as MultipartUploadErrorCode)
      : (STATUS_CODES[response.status] ?? 'NETWORK');

  const message =
    (typeof body.message === 'string' && body.message) ||
    (raw && !KNOWN_CODES.has(raw) ? raw : '') ||
    `Upload failed (${response.status}).`;

  return new MultipartUploadError(code, message, {
    status: response.status,
    usedBytes: typeof body.usedBytes === 'number' ? body.usedBytes : undefined,
    quotaBytes: typeof body.quotaBytes === 'number' ? body.quotaBytes : undefined,
    serverMessage:
      typeof body.message === 'string' && body.message.trim() ? body.message : undefined,
  });
}

/** POST JSON to one of our own routes; any non-2xx becomes a typed rejection. */
async function postJson<T>(url: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw aborted();
    throw new MultipartUploadError('NETWORK', 'Could not reach the server.', { cause: error });
  }

  if (!response.ok) throw await errorFromResponse(response);
  return (await response.json()) as T;
}

/** True when the URL is past — or nearly past — the expiry the server gave it. */
function isStale(part: SignedPart): boolean {
  if (!part.expiresAt) return false;
  const at = Date.parse(part.expiresAt);
  return Number.isFinite(at) && Date.now() >= at - EXPIRY_SKEW_MS;
}

/**
 * R2 answering "this signature is no longer valid".
 *
 * S3-compatible stores say so with 403 and an XML `<Code>` of `AccessDenied`
 * or `ExpiredToken`, and the message names the expiry. We do not try to parse
 * the XML: any 403 whose body mentions expiry, plus a plain 403 on a URL we
 * already believe is stale, is enough to justify one re-sign.
 */
function looksExpired(status: number, body: string): boolean {
  if (status !== 403) return false;
  return /expire|ExpiredToken|AccessDenied/i.test(body);
}

export async function uploadMultipart({
  file,
  classroomId,
  options,
  endpoints,
  onProgress,
  signal,
}: MultipartUploadArgs): Promise<MultipartUploadResult> {
  const base = (endpoints?.base ?? DEFAULT_BASE).replace(/\/$/, '');
  if (signal?.aborted) throw aborted();

  const created = await postJson<CreateUploadResponse>(
    `${base}/uploads`,
    { classroomId, filename: file.name, sizeBytes: file.size, options },
    signal
  );

  const { mediaId, partSize, partCount } = created;
  const totalBytes = file.size;

  // Every request past the create runs under a controller of our own, linked
  // to the caller's. The caller's cancel reaches all of them through it, and so
  // does our own failure: when one part gives up, the three PUTs still flying
  // beside it have to stop too, or they go on pushing bytes into an upload the
  // cleanup below has just cancelled.
  const inner = new AbortController();
  const stop = () => inner.abort();
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  const innerSignal = inner.signal;

  // Everything past the create has an upload behind it, so every failure from
  // here owes R2 a cleanup: the abort cancels the multipart and drops the row,
  // which is what stops a dead reservation eating the classroom's quota for the
  // next 24 hours.
  //
  // ABORT, never DELETE. The abort acts only on an upload that is still open;
  // a failure seen here may be a `complete` that succeeded on the server and
  // whose answer was lost, and a DELETE would then remove the finished file.
  try {
    onProgress?.({ sentBytes: 0, totalBytes, part: 0, partCount });

    const etags = new Map<number, string>();
    let sentBytes = 0;

    for (let first = 1; first <= partCount; first += URL_BATCH_SIZE) {
      if (innerSignal.aborted) throw aborted();

      const partNumbers: number[] = [];
      for (let n = first; n < first + URL_BATCH_SIZE && n <= partCount; n += 1) partNumbers.push(n);

      const signed = new Map<number, SignedPart>();
      const sign = async (wanted: number[]) => {
        const { urls } = await postJson<{ urls: SignedPart[] }>(
          `${base}/uploads/${mediaId}/parts`,
          { partNumbers: wanted },
          innerSignal
        );
        for (const url of urls) signed.set(url.partNumber, url);
      };

      await sign(partNumbers);

      /**
       * Re-sign every part of this batch that has not finished yet.
       *
       * Whole batch rather than the one that failed: they were minted together
       * and expire together, so the next part in the queue is about to hit the
       * same wall, and one round trip settles all of them.
       */
      const refreshBatch = async () => {
        const outstanding = partNumbers.filter(n => !etags.has(n));
        if (outstanding.length > 0) await sign(outstanding);
      };

      const putPart = async (partNumber: number): Promise<void> => {
        const start = (partNumber - 1) * partSize;
        const blob = file.slice(start, Math.min(start + partSize, totalBytes));
        let retries = 0;
        let refreshes = 0;

        for (;;) {
          if (innerSignal.aborted) throw aborted();

          let part = signed.get(partNumber);
          if (!part) throw new MultipartUploadError('NETWORK', `No URL for part ${partNumber}.`);

          if (isStale(part) && refreshes < MAX_URL_REFRESHES) {
            refreshes += 1;
            await refreshBatch();
            part = signed.get(partNumber) ?? part;
          }

          let retryable: MultipartUploadError | null = null;
          try {
            const response = await fetch(part.url, {
              method: 'PUT',
              body: blob,
              headers: created.contentType ? { 'Content-Type': created.contentType } : undefined,
              signal: innerSignal,
            });

            if (response.ok) {
              const etag = response.headers.get('ETag') ?? response.headers.get('etag');
              if (!etag) {
                // Without the ETag the complete call cannot name this part, and
                // no amount of retrying will conjure one: the bucket's CORS is
                // not exposing the header.
                throw new MultipartUploadError(
                  'NETWORK',
                  `Part ${partNumber} came back without an ETag.`
                );
              }
              etags.set(partNumber, etag.trim());
              sentBytes += blob.size;
              onProgress?.({ sentBytes, totalBytes, part: partNumber, partCount });
              return;
            }

            const body = await response.text().catch(() => '');
            if (looksExpired(response.status, body) && refreshes < MAX_URL_REFRESHES) {
              refreshes += 1;
              await refreshBatch();
              continue;
            }
            if (response.status < 500 && response.status !== 429) {
              throw new MultipartUploadError(
                'NETWORK',
                `Part ${partNumber} was rejected (${response.status}).`,
                { status: response.status }
              );
            }
            retryable = new MultipartUploadError(
              'NETWORK',
              `Part ${partNumber} failed (${response.status}).`,
              { status: response.status }
            );
          } catch (error) {
            if (isAbortError(error)) throw aborted();
            if (error instanceof MultipartUploadError) throw error;
            retryable = new MultipartUploadError('NETWORK', `Part ${partNumber} failed.`, {
              cause: error,
            });
          }

          if (!retryable || retries >= RETRY_BACKOFF_MS.length) {
            throw retryable ?? new MultipartUploadError('NETWORK', `Part ${partNumber} failed.`);
          }
          await delay(RETRY_BACKOFF_MS[retries], innerSignal);
          retries += 1;
        }
      };

      // A fixed pool of workers pulling from the batch, so the fourth PUT starts
      // as soon as any of the first three lands rather than at a batch boundary.
      const queue = [...partNumbers];
      const workers = Array.from({ length: Math.min(PART_CONCURRENCY, queue.length) }, async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          await putPart(next);
        }
      });
      await Promise.all(workers);
    }

    if (innerSignal.aborted) throw aborted();

    const parts = [...etags.entries()]
      .map(([partNumber, etag]) => ({ partNumber, etag }))
      .sort((a, b) => a.partNumber - b.partNumber);

    const completed = await postJson<{ mediaId: string; ref: string }>(
      `${base}/uploads/${mediaId}/complete`,
      { parts },
      innerSignal
    );

    return { mediaId: completed.mediaId ?? mediaId, ref: completed.ref ?? `media://${mediaId}` };
  } catch (error) {
    // Stop every request still in flight before telling the server to cancel,
    // so no part lands after the abort has closed the upload.
    stop();
    // Exactly one cleanup per upload, and this is the only place that sends
    // it. Deliberately un-signalled: the usual reason we are here is that the
    // signal just aborted, and a request wired to it would be cancelled before
    // it left. Not awaited either — its answer changes nothing for the caller,
    // who is told at once that the upload is over, and a cancel that sat
    // waiting on a round trip would look like a button that did nothing.
    void fetch(`${base}/uploads/${mediaId}/abort`, { method: 'POST' }).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}
