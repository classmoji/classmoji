/**
 * workersAi.ts — the one call we make to Cloudflare Workers AI.
 *
 * The content index turns a page or a deck into a vector so the MCP's
 * `content_search` can find it by meaning rather than by keyword. That is the
 * only thing this file does: `embedTexts` takes strings and gives back one
 * vector per string, in order. It is a single function rather than a client
 * because there is a single caller shape, and every knob the index does not
 * need is absent rather than defaulted.
 *
 * ── Credentials ────────────────────────────────────────────────────────────
 * `CLOUDFLARE_WORKERS_AI_TOKEN` is an API token scoped to **Workers AI – Read**
 * and nothing else; `CLOUDFLARE_ACCOUNT_ID` names the account it belongs to.
 * The token rides in an `Authorization: Bearer` header, is never logged, and
 * never appears in a thrown error — `WorkersAiError` carries the status and
 * Cloudflare's own message, and the request URL is reconstructed from the
 * account id rather than echoed.
 *
 * Unset is a SAFE state, not a broken one, and it is the state most of the
 * fleet runs in: `isWorkersAiConfigured()` is the guard a caller on a save path
 * checks first, so the save never reaches this file at all. Call `embedTexts`
 * without it and you get a `not_configured` error rather than a silent no-op,
 * because a caller that asked for a vector and got nothing back should be told.
 *
 * ── Symmetric embedding, deliberately ──────────────────────────────────────
 * The model also accepts a `queries` / `documents` / `instruction` form
 * (asymmetric retrieval). We send `text` for BOTH indexing and querying: one
 * code path, one vector space, and no chance of the two halves drifting into
 * different spaces where every similarity score is quietly meaningless.
 * Switching to the asymmetric form later is a re-backfill costing cents, and it
 * is a measured follow-up rather than a v1 guess.
 *
 * ── The input cap, and why this file refuses rather than truncates ──────────
 * Over-cap input is TRUNCATED SILENTLY by the endpoint — verified live — so a
 * document longer than the window comes back as a perfectly valid vector of its
 * opening pages, with `success: true` and nothing anywhere saying half of it
 * was dropped. A vector like that is worse than no vector: it looks indexed, it
 * ranks, and it answers questions out of the half that survived.
 *
 * So this client never sends text it estimates to be over the cap, and it never
 * shortens text to make it fit. It returns `{ ok: false, reason: 'over_cap' }`
 * with the estimate, and the caller decides — chunk it, store a summary, index
 * the first N and say so, or skip it. That decision belongs to the indexer,
 * which knows what the document is; all this file can do is refuse to make it
 * silently. See MAX_INPUT_TOKENS for why the cap is set where it is.
 */

/** The embedding model. Changing it invalidates every stored vector. */
export const EMBEDDING_MODEL = '@cf/qwen/qwen3-embedding-0.6b';

/**
 * Vector width. Pinned, because `content_index.embedding` is a `vector(1024)`
 * column and a vector of any other width is a Postgres error in a different
 * job, hours later, with nothing pointing back here.
 *
 * Verified live against this account on 2026-09-10: `result.shape` came back
 * `[3, 1024]` for a three-item batch.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * The input window, in tokens.
 *
 * Cloudflare publishes two numbers for this model:
 *
 *  - the model page says **8,192** — "Context Window: 8,192 tokens"
 *    https://developers.cloudflare.com/workers-ai/models/qwen3-embedding-0.6b/
 *  - the AI Search launch notice tabulates **4,096** under "Input tokens"
 *    (beside "Vector dims 1,024", which is right)
 *    https://developers.cloudflare.com/changelog/post/2026-04-09-new-workers-ai-models/
 *
 * **8,192 is this endpoint's window. 4,096 is AI Search's chunk size**, which
 * is a property of that product's ingestion pipeline and not a limit the REST
 * endpoint imposes.
 *
 * A differential probe on 2026-09-10 settled it. A 200 proves nothing on its
 * own here — the endpoint truncates over-cap input silently, so a long document
 * comes back as a perfectly valid vector whatever the real cap is. So the probe
 * compared two inputs rather than inspecting one: a 40,000-char document and
 * its own first 20,000 chars (~10,000 and ~5,000 tokens), embedded in the SAME
 * batch. Under a 4,096-token cap both truncate to the identical opening ~16,000
 * characters, and identical input yields an identical vector. They came back at
 * cosine **0.969** — three orders of magnitude away from the ~1e-6 that batch
 * padding or float non-determinism could account for. The model read well past
 * 5,000 tokens, so 4,096 is not this endpoint's limit.
 *
 * The upstream Qwen card's 32K is the model's architecture rather than the
 * hosted contract, and is not what we hold Cloudflare to.
 *
 * None of which makes the cap safe to ignore, because the failure mode is
 * unchanged: go past the window and the tail is dropped with `success: true`
 * and no warning anywhere. Hence the refusal below, and hence
 * CLOUDFLARE_WORKERS_AI_EMBED_MAX_TOKENS, for moving this per environment if
 * Cloudflare's number moves under us.
 */
export const MAX_INPUT_TOKENS = 8192;

/** The env var that overrides {@link MAX_INPUT_TOKENS}. */
export const MAX_INPUT_TOKENS_ENV = 'CLOUDFLARE_WORKERS_AI_EMBED_MAX_TOKENS';

/**
 * The cap in force, which is {@link MAX_INPUT_TOKENS} unless the environment
 * raises or lowers it.
 *
 * A malformed override (empty, non-numeric, zero, negative) is ignored in
 * favour of the conservative default rather than throwing: this is read on a
 * save path, and a typo in a deploy config should cost recall on long
 * documents, not the save.
 */
export function maxInputTokens(): number {
  const raw = process.env[MAX_INPUT_TOKENS_ENV];
  if (!raw) return MAX_INPUT_TOKENS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return MAX_INPUT_TOKENS;
  return Math.floor(parsed);
}

/**
 * Characters per token, for the estimate below.
 *
 * There is no Qwen3 tokenizer in this workspace. `js-tiktoken` is present, but
 * only as a transitive dependency of something else, and it carries OpenAI's
 * BPE vocabularies — a *different* tokenizer, which agrees with Qwen roughly on
 * English prose and diverges exactly where it matters (code, CJK, base64,
 * dense punctuation). Borrowing it would dress a guess up as a measurement, so
 * this is an explicit estimate instead.
 *
 * Three, not four. Four characters per token is the English-prose average, and
 * an average is the wrong tool for a ceiling: the documents that overrun a cap
 * are the ones full of code fences, identifiers and CJK, where a token can be
 * one character. Three is deliberately pessimistic, so the estimate errs toward
 * refusing a document that would have fit rather than accepting one that gets
 * silently cut in half.
 */
export const CHARS_PER_TOKEN = 3;

/**
 * A deliberately pessimistic token count. Over-estimates; never under-estimates
 * by design. See {@link CHARS_PER_TOKEN}.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The cap in force, expressed in characters. */
export function maxInputChars(): number {
  return maxInputTokens() * CHARS_PER_TOKEN;
}

/**
 * Strings per request. The API's own limit: the "Text Embeddings" branch of
 * `POST /accounts/{account_id}/ai/run/{model_name}` declares `maxItems: 100` on
 * the `text` array. Over it, we refuse here rather than spend a round trip
 * learning the same thing from a 400.
 */
export const MAX_BATCH_SIZE = 100;

/** Generous: a 3-item batch with a 40,000-char document answered in 6.4s. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Why the call failed, in a form a caller can branch on without reading
 * English. `not_configured` is the one a save path treats as "skip quietly";
 * the rest are worth a log line.
 */
export type WorkersAiErrorCode =
  | 'not_configured'
  | 'batch_too_large'
  | 'http_error'
  | 'network_error'
  | 'malformed_response'
  | 'dimension_mismatch';

export class WorkersAiError extends Error {
  readonly code: WorkersAiErrorCode;
  readonly status: number;
  /** Worth another attempt: rate limiting, server-side faults, timeouts. */
  readonly retryable: boolean;
  /** Seconds from a 429's `Retry-After`, when it sent one. */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    {
      code,
      status,
      retryable,
      retryAfterSeconds = null,
    }: {
      code: WorkersAiErrorCode;
      status: number;
      retryable: boolean;
      retryAfterSeconds?: number | null;
    }
  ) {
    super(message);
    this.name = 'WorkersAiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Both halves or nothing. The account id alone embeds no text and the token
 * alone has no account to spend against, so a half-configured environment is
 * unconfigured.
 */
export function isWorkersAiConfigured(): boolean {
  return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_WORKERS_AI_TOKEN);
}

/**
 * `Retry-After`, in seconds from now.
 *
 * RFC 9110 allows delta-seconds or an HTTP-date, and Cloudflare sends both
 * depending on which layer rate-limited you. A date already in the past is no
 * wait at all rather than a negative one.
 */
function retryAfterFrom(response: {
  headers: { get(name: string): string | null };
}): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((at - Date.now()) / 1000));
}

/**
 * Cloudflare's own account of the failure.
 *
 * The envelope is `{ success: false, errors: [{ code, message }], messages }`,
 * and on a 4xx the `errors` array is the only thing that says WHICH of a dozen
 * possible malformed requests this was. All of them are surfaced, not just the
 * first — a token-scope failure and a body failure can arrive together, and
 * dropping either sends the reader after the wrong one.
 */
async function describeFailure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      errors?: Array<{ code?: number; message?: string }>;
      message?: string;
    };
    const described = (body?.errors ?? [])
      .map(error => {
        if (!error?.message) return null;
        return error.code ? `${error.code}: ${error.message}` : error.message;
      })
      .filter((line): line is string => Boolean(line));

    if (described.length) return described.join('; ');
    if (body?.message) return body.message;
  } catch {
    // Not JSON, or an empty body. The status alone is the message then.
  }
  return `HTTP ${response.status}`;
}

/**
 * The call did not happen, and the caller has to decide what to do about it.
 *
 * This is NOT the error channel — a refusal is a judgement the caller is better
 * placed to make, not a fault. Faults (unreachable, non-2xx, malformed answer,
 * unconfigured) still throw `WorkersAiError`.
 */
export type EmbedRefusal = {
  ok: false;
  /** A union of one for now; adding members here is not a breaking change. */
  reason: 'over_cap';
  /** Pessimistic — see {@link estimateTokens}. Not a measurement. */
  estimatedTokens: number;
  /** The cap that was in force, so a log line explains itself. */
  limit: number;
  /** Which string in the batch. The rest were not sent either. */
  index: number;
};

export type EmbedResult = { ok: true; vectors: number[][] } | EmbedRefusal;

/**
 * Embeds every string in one call. On success, `vectors` holds one vector per
 * input, in the order they were given.
 *
 * Never truncates: a string estimated over the cap is refused before any
 * request is made, and the whole batch is refused with it, because a partial
 * batch would hand the caller vectors it cannot line up against its inputs.
 * Pre-screen with {@link estimateTokens} to avoid the round trip entirely.
 *
 * Never retries. The nightly reconcile is the retry — a backoff loop here would
 * hold a save-path tail open to wait out a rate limit that the reconcile will
 * clear for free, and would turn one slow classroom into a queue. `retryable`
 * on the thrown error is there so a caller that IS a retry loop (a Trigger.dev
 * task) can classify without parsing a message.
 */
export async function embedTexts(
  texts: string[],
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<EmbedResult> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_WORKERS_AI_TOKEN;
  if (!accountId || !token) {
    throw new WorkersAiError('Workers AI is not configured', {
      code: 'not_configured',
      status: 0,
      retryable: false,
    });
  }

  // Nothing to embed is not a failure, and it is not worth a round trip.
  if (texts.length === 0) return { ok: true, vectors: [] };

  // A batch this size is a caller mistake rather than a property of the
  // documents, so it comes first and it throws.
  if (texts.length > MAX_BATCH_SIZE) {
    throw new WorkersAiError(`Batch of ${texts.length} exceeds the ${MAX_BATCH_SIZE}-item limit`, {
      code: 'batch_too_large',
      status: 0,
      retryable: false,
    });
  }

  // Before the network, not after: the endpoint would answer 200 on an
  // over-cap body and quietly embed its opening pages.
  const limit = maxInputTokens();
  for (const [index, text] of texts.entries()) {
    const estimatedTokens = estimateTokens(text);
    if (estimatedTokens > limit) {
      return { ok: false, reason: 'over_cap', estimatedTokens, limit, index };
    }
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await doFetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBEDDING_MODEL}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: texts }),
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
  } catch (error) {
    // A timeout and a dropped connection are the same thing to a caller: the
    // request did not happen, and it might next time.
    const name = (error as { name?: string })?.name;
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    throw new WorkersAiError(
      timedOut ? `Workers AI did not answer within ${timeoutMs}ms` : 'Workers AI was unreachable',
      { code: 'network_error', status: 0, retryable: true }
    );
  }

  if (!response.ok) {
    const status = response.status;
    throw new WorkersAiError(await describeFailure(response), {
      code: 'http_error',
      status,
      // 429 and 5xx are the endpoint saying "not now". A 400 is it saying "not
      // ever", and asking again costs a round trip to reach the same answer.
      retryable: status === 429 || status >= 500,
      retryAfterSeconds: status === 429 ? retryAfterFrom(response) : null,
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new WorkersAiError('Workers AI answered 200 with a body that is not JSON', {
      code: 'malformed_response',
      status: response.status,
      retryable: false,
    });
  }

  const result = (json as { result?: { data?: unknown; shape?: unknown } })?.result;
  const data = result?.data;
  const shape = result?.shape;

  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new WorkersAiError(
      `Malformed embedding response: expected ${texts.length} vectors, got ${
        Array.isArray(data) ? data.length : typeof data
      }`,
      { code: 'malformed_response', status: response.status, retryable: false }
    );
  }

  // `shape` is [rows, width] and is the endpoint's own account of what it
  // returned — the cheapest place to catch a model swap underneath us.
  if (Array.isArray(shape) && shape[1] !== EMBEDDING_DIMENSIONS) {
    throw new WorkersAiError(
      `Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${String(shape[1])}`,
      { code: 'dimension_mismatch', status: response.status, retryable: false }
    );
  }

  // And the vectors themselves, because `shape` is advisory: it can be absent,
  // and it is not what gets written. A 768-wide vector reaching a `vector(1024)`
  // column fails at INSERT time, in the indexer, with nothing naming this call.
  for (const [index, vector] of data.entries()) {
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
      throw new WorkersAiError(
        `Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${
          Array.isArray(vector) ? vector.length : typeof vector
        } at index ${index}`,
        { code: 'dimension_mismatch', status: response.status, retryable: false }
      );
    }
  }

  return { ok: true, vectors: data as number[][] };
}
