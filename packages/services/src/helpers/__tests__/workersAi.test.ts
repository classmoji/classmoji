/**
 * The Workers AI embedding call: what we send, and how we read what comes back.
 *
 * Four things here are load-bearing and none is obvious from the code:
 *
 *  - the WIDTH. `content_index.embedding` is a `vector(1024)` column. A
 *    768-wide vector is a valid JSON array, a valid embedding, and a Postgres
 *    error hours later in a different job. Both the endpoint's own `shape` and
 *    the vectors themselves are checked, because `shape` is advisory and it is
 *    not the thing that gets written.
 *  - the RETRYABLE classification. This client never retries — the nightly
 *    reconcile is the retry — so `retryable` exists for the one caller that IS
 *    a retry loop. 429 and 5xx are "not now"; a 400 is "not ever".
 *  - the AUTH FORM. `Bearer`, not `Token` and not Fly's `FlyV1`. Getting it
 *    wrong is a 401 on a token that is perfectly good.
 *  - the UNCONFIGURED state, which is the state most of the fleet runs in.
 *    `isWorkersAiConfigured()` is the guard, and calling anyway is an error
 *    rather than an empty vector, because a caller that asked for a vector and
 *    silently got none would index garbage.
 *  - the INPUT CAP, which is enforced BEFORE the network because the endpoint
 *    answers 200 on an over-cap body and embeds only its opening pages. These
 *    tests assert the refusal happens with `fetch` untouched — a cap checked
 *    after the call would be no cap at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BASE_URL_ENV,
  CHARS_PER_TOKEN,
  DEFAULT_BASE_URL,
  EMBEDDING_DIMENSIONS,
  MAX_BATCH_SIZE,
  MAX_INPUT_TOKENS,
  MAX_INPUT_TOKENS_ENV,
  WorkersAiError,
  embedTexts,
  estimateTokens,
  isWorkersAiConfigured,
  maxInputTokens,
  workersAiBaseUrl,
} from '../workersAi.ts';

const TOKEN = 'super-secret-workers-ai-token';

const vector = (width = EMBEDDING_DIMENSIONS) => Array.from({ length: width }, (_, i) => i / width);

function response(
  body: BodyInit,
  { status = 200, headers = {} }: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The shape a 200 actually has — verified live on 2026-09-10. */
const embeddings = (count: number, width = EMBEDDING_DIMENSIONS) =>
  response(
    JSON.stringify({
      result: {
        data: Array.from({ length: count }, () => vector(width)),
        shape: [count, width],
        usage: { prompt_tokens: 12, total_tokens: 12 },
      },
      success: true,
      errors: [],
      messages: [],
    })
  );

const stub = (res: Response) => vi.fn().mockResolvedValue(res) as unknown as typeof fetch;
const calls = (fetchImpl: typeof fetch) => (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock;

beforeEach(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct-1234';
  process.env.CLOUDFLARE_WORKERS_AI_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_WORKERS_AI_TOKEN;
  delete process.env[MAX_INPUT_TOKENS_ENV];
  delete process.env[BASE_URL_ENV];
});

describe('isWorkersAiConfigured', () => {
  it('needs both the account and the token', () => {
    expect(isWorkersAiConfigured()).toBe(true);
    delete process.env.CLOUDFLARE_WORKERS_AI_TOKEN;
    expect(isWorkersAiConfigured()).toBe(false);
    process.env.CLOUDFLARE_WORKERS_AI_TOKEN = TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    expect(isWorkersAiConfigured()).toBe(false);
  });
});

describe('workersAiBaseUrl', () => {
  it('is Cloudflare when the override is unset — the only correct production value', () => {
    expect(workersAiBaseUrl()).toBe(DEFAULT_BASE_URL);
    process.env[BASE_URL_ENV] = '   ';
    expect(workersAiBaseUrl()).toBe(DEFAULT_BASE_URL);
  });

  it('takes an http(s) override, trailing slashes trimmed', () => {
    process.env[BASE_URL_ENV] = 'http://127.0.0.1:9987/v4';
    expect(workersAiBaseUrl()).toBe('http://127.0.0.1:9987/v4');
    process.env[BASE_URL_ENV] = 'http://127.0.0.1:9987/v4//';
    expect(workersAiBaseUrl()).toBe('http://127.0.0.1:9987/v4');
  });

  it('falls back to Cloudflare for anything unparseable or non-HTTP', () => {
    for (const bad of ['not a url', '/relative/path', 'file:///etc/passwd', 'ftp://example.test']) {
      process.env[BASE_URL_ENV] = bad;
      expect(workersAiBaseUrl(), `override ${bad}`).toBe(DEFAULT_BASE_URL);
    }
  });
});

describe('the request', () => {
  it('posts the account ai/run endpoint for the embedding model', async () => {
    const fetchImpl = stub(embeddings(2));

    await embedTexts(['first', 'second'], { fetchImpl });

    const [url, init] = calls(fetchImpl).calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-1234/ai/run/@cf/qwen/qwen3-embedding-0.6b'
    );
    expect(init.method).toBe('POST');
    // `Bearer`. Not `Token`, not `FlyV1` — both of which are forms used
    // elsewhere in this repo and both of which 401 here.
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('sends to the overridden root when one is set, path and auth unchanged', async () => {
    // This is what lets tests/phase2-content.integration.test.ts exercise
    // content_search through the real tool with no Cloudflare account.
    process.env[BASE_URL_ENV] = 'http://127.0.0.1:9987/v4/';
    const fetchImpl = stub(embeddings(1));

    await embedTexts(['first'], { fetchImpl });

    const [url, init] = calls(fetchImpl).calls[0];
    expect(url).toBe(
      'http://127.0.0.1:9987/v4/accounts/acct-1234/ai/run/@cf/qwen/qwen3-embedding-0.6b'
    );
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('ignores a malformed override rather than refusing to embed', async () => {
    process.env[BASE_URL_ENV] = 'not a url';
    const fetchImpl = stub(embeddings(1));

    await embedTexts(['first'], { fetchImpl });

    expect(calls(fetchImpl).calls[0][0]).toBe(
      `${DEFAULT_BASE_URL}/accounts/acct-1234/ai/run/@cf/qwen/qwen3-embedding-0.6b`
    );
  });

  it('sends the symmetric `text` form, never `queries`/`documents`', async () => {
    // The asymmetric form puts index-time and query-time vectors in different
    // spaces. Both halves of the search have to send the same field or every
    // similarity score is quietly meaningless.
    const fetchImpl = stub(embeddings(2));

    await embedTexts(['first', 'second'], { fetchImpl });

    const body = JSON.parse(calls(fetchImpl).calls[0][1].body);
    expect(body).toEqual({ text: ['first', 'second'] });
    expect(body).not.toHaveProperty('queries');
    expect(body).not.toHaveProperty('documents');
    expect(body).not.toHaveProperty('instruction');
  });

  it('returns result.data, one vector per input, in order', async () => {
    const first = vector();
    const second = vector().map(n => n + 1);
    const fetchImpl = stub(
      response(
        JSON.stringify({
          result: { data: [first, second], shape: [2, EMBEDDING_DIMENSIONS] },
          success: true,
        })
      )
    );

    await expect(embedTexts(['a', 'b'], { fetchImpl })).resolves.toEqual({
      ok: true,
      vectors: [first, second],
    });
  });

  it('embeds nothing without a round trip', async () => {
    const fetchImpl = stub(embeddings(0));
    await expect(embedTexts([], { fetchImpl })).resolves.toEqual({ ok: true, vectors: [] });
    expect(calls(fetchImpl).calls).toHaveLength(0);
  });

  it('refuses a batch over the API limit rather than spending a 400 to learn it', async () => {
    const fetchImpl = stub(embeddings(MAX_BATCH_SIZE + 1));

    const error = (await embedTexts(
      Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => `doc ${i}`),
      { fetchImpl }
    ).catch((e: unknown) => e)) as WorkersAiError;

    expect(error).toBeInstanceOf(WorkersAiError);
    expect(error.code).toBe('batch_too_large');
    expect(error.retryable).toBe(false);
    expect(calls(fetchImpl).calls).toHaveLength(0);
  });

  it('takes exactly the API limit', async () => {
    const fetchImpl = stub(embeddings(MAX_BATCH_SIZE));
    await expect(
      embedTexts(
        Array.from({ length: MAX_BATCH_SIZE }, (_, i) => `doc ${i}`),
        { fetchImpl }
      )
    ).resolves.toMatchObject({
      ok: true,
      vectors: expect.objectContaining({ length: MAX_BATCH_SIZE }),
    });
  });

  it('refuses to call at all when unconfigured', async () => {
    delete process.env.CLOUDFLARE_WORKERS_AI_TOKEN;
    const fetchImpl = stub(embeddings(1));

    const error = (await embedTexts(['a'], { fetchImpl }).catch(
      (e: unknown) => e
    )) as WorkersAiError;

    expect(error).toBeInstanceOf(WorkersAiError);
    expect(error.code).toBe('not_configured');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/not configured/);
    expect(calls(fetchImpl).calls).toHaveLength(0);
  });

  it('treats a half-configured environment as unconfigured', async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    const fetchImpl = stub(embeddings(1));

    await expect(embedTexts(['a'], { fetchImpl })).rejects.toMatchObject({
      code: 'not_configured',
    });
    expect(calls(fetchImpl).calls).toHaveLength(0);
  });
});

describe('the vector width', () => {
  it('refuses a shape that is not 1024 wide', async () => {
    // The data here is the RIGHT width and only `shape` disagrees, so this test
    // bites on the shape check alone. A model swapped underneath us announces
    // itself here first.
    const fetchImpl = stub(
      response(
        JSON.stringify({
          result: { data: [vector()], shape: [1, 768] },
          success: true,
        })
      )
    );

    const error = (await embedTexts(['a'], { fetchImpl }).catch(
      (e: unknown) => e
    )) as WorkersAiError;

    expect(error).toBeInstanceOf(WorkersAiError);
    expect(error.code).toBe('dimension_mismatch');
    expect(error.message).toMatch(/1024/);
    expect(error.message).toMatch(/768/);
    expect(error.retryable).toBe(false);
  });

  it('refuses vectors that are not 1024 wide even when shape is absent', async () => {
    // `shape` is advisory and can be missing; the vectors are what reaches the
    // `vector(1024)` column. Trusting shape alone would let this through to
    // fail at INSERT time, in another job, naming neither this call nor the
    // document that caused it.
    const fetchImpl = stub(
      response(JSON.stringify({ result: { data: [vector(768)] }, success: true }))
    );

    const error = (await embedTexts(['a'], { fetchImpl }).catch(
      (e: unknown) => e
    )) as WorkersAiError;

    expect(error).toBeInstanceOf(WorkersAiError);
    expect(error.code).toBe('dimension_mismatch');
    expect(error.message).toMatch(/768/);
  });

  it('names which vector in the batch was wrong', async () => {
    const fetchImpl = stub(
      response(
        JSON.stringify({
          result: { data: [vector(), vector(), vector(512)], shape: [3, EMBEDDING_DIMENSIONS] },
          success: true,
        })
      )
    );

    const error = (await embedTexts(['a', 'b', 'c'], { fetchImpl }).catch(
      (e: unknown) => e
    )) as WorkersAiError;

    expect(error.code).toBe('dimension_mismatch');
    expect(error.message).toMatch(/index 2/);
  });
});

describe('reading the response', () => {
  it('refuses a batch that came back short', async () => {
    // Three documents in, two vectors out: whichever way a caller zips those
    // together, some document gets another document's vector and the index is
    // wrong in a way no error ever surfaces.
    const fetchImpl = stub(
      response(
        JSON.stringify({
          result: { data: [vector(), vector()], shape: [2, EMBEDDING_DIMENSIONS] },
          success: true,
        })
      )
    );

    const error = (await embedTexts(['a', 'b', 'c'], { fetchImpl }).catch(
      (e: unknown) => e
    )) as WorkersAiError;

    expect(error).toBeInstanceOf(WorkersAiError);
    expect(error.code).toBe('malformed_response');
    expect(error.message).toMatch(/expected 3 vectors, got 2/);
    expect(error.retryable).toBe(false);
  });

  it('refuses a 200 with no result.data at all', async () => {
    const fetchImpl = stub(response(JSON.stringify({ success: true, result: {} })));
    await expect(embedTexts(['a'], { fetchImpl })).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });

  it('refuses a 200 that is not JSON', async () => {
    const fetchImpl = stub(
      response('<html>gateway</html>', { headers: { 'content-type': 'text/html' } })
    );
    await expect(embedTexts(['a'], { fetchImpl })).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });

  it('tolerates the extra keys the endpoint actually sends', async () => {
    // The live response carries `result.usage` and top-level `messages`, neither
    // of which appears in the OpenAPI spec's Text Embeddings branch. Reading
    // strictly would break on a field Cloudflare added without telling anyone.
    const fetchImpl = stub(embeddings(1));
    await expect(embedTexts(['a'], { fetchImpl })).resolves.toMatchObject({ ok: true });
  });
});

describe('classifying failures', () => {
  it('marks a 429 retryable and carries its Retry-After', async () => {
    const fetchImpl = stub(
      response(
        JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Rate limited' }] }),
        {
          status: 429,
          headers: { 'retry-after': '12' },
        }
      )
    );

    const error = (await embedTexts(['a'], { fetchImpl }).catch(
      (e: unknown) => e
    )) as WorkersAiError;

    expect(error).toBeInstanceOf(WorkersAiError);
    expect(error).toMatchObject({
      code: 'http_error',
      status: 429,
      retryable: true,
      retryAfterSeconds: 12,
    });
    expect(error.message).toBe('10000: Rate limited');
  });

  it('reads a Retry-After sent as an HTTP-date, which RFC 9110 also allows', async () => {
    const fetchImpl = stub(
      response('', {
        status: 429,
        headers: { 'retry-after': new Date(Date.now() + 30_000).toUTCString() },
      })
    );

    const error = (await embedTexts(['a'], { fetchImpl }).catch(
      (e: unknown) => e
    )) as WorkersAiError;

    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(28);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(31);
  });

  it('marks a 5xx retryable and a 4xx not', async () => {
    for (const [status, retryable] of [
      [400, false],
      [401, false],
      [403, false],
      [500, true],
      [503, true],
    ] as const) {
      const fetchImpl = stub(response('', { status }));
      const error = (await embedTexts(['a'], { fetchImpl }).catch(
        (e: unknown) => e
      )) as WorkersAiError;
      expect(error.status).toBe(status);
      expect(error.retryable).toBe(retryable);
      expect(error.retryAfterSeconds).toBeNull();
    }
  });

  it('surfaces every entry of the Cloudflare errors array', async () => {
    // A scope failure and a body failure arrive together, and reading only the
    // first sends you after the wrong one — the difference between "your token
    // lacks Workers AI" and "your text array is empty".
    const fetchImpl = stub(
      response(
        JSON.stringify({
          success: false,
          errors: [
            { code: 10000, message: 'Authentication error' },
            { code: 7003, message: 'Could not route to /ai/run' },
          ],
        }),
        { status: 400 }
      )
    );

    const error = (await embedTexts(['a'], { fetchImpl }).catch(
      (e: unknown) => e
    )) as WorkersAiError;

    expect(error.message).toContain('Authentication error');
    expect(error.message).toContain('Could not route to /ai/run');
  });

  it('falls back to the status when the body says nothing', async () => {
    const fetchImpl = stub(
      response('', { status: 502, headers: { 'content-type': 'text/plain' } })
    );
    const error = (await embedTexts(['a'], { fetchImpl }).catch(
      (e: unknown) => e
    )) as WorkersAiError;
    expect(error.message).toBe('HTTP 502');
  });

  it('treats a timeout as retryable, not as a malformed answer', async () => {
    // `AbortSignal.timeout` rejects the fetch with a DOMException; left
    // unclassified it would escape as a bare TimeoutError and the reconcile
    // could not tell "Cloudflare is slow" from "this document cannot be
    // embedded".
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      ) as unknown as typeof fetch;

    const error = (await embedTexts(['a'], { fetchImpl, timeoutMs: 5000 }).catch(
      (e: unknown) => e
    )) as WorkersAiError;

    expect(error).toBeInstanceOf(WorkersAiError);
    expect(error.code).toBe('network_error');
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/5000ms/);
  });

  it('treats a dropped connection as retryable too', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;

    await expect(embedTexts(['a'], { fetchImpl })).rejects.toMatchObject({
      code: 'network_error',
      retryable: true,
    });
  });

  it('never puts the token in the error it throws', async () => {
    const fetchImpl = stub(
      response(JSON.stringify({ errors: [{ message: 'Authentication error' }] }), { status: 401 })
    );

    const error = (await embedTexts(['a'], { fetchImpl }).catch(
      (e: unknown) => e
    )) as WorkersAiError;

    expect(`${error.message}${error.stack ?? ''}`).not.toContain(TOKEN);
  });
});

describe('the input cap', () => {
  const overCap = (tokens = maxInputTokens() + 1) => 'x'.repeat(tokens * CHARS_PER_TOKEN);

  it('defaults to the 8,192-token window the endpoint actually honours', () => {
    // Cloudflare publishes both 8,192 (model page) and 4,096 (AI Search launch
    // notice). A differential probe settled it: a document and its own first
    // half, embedded in one batch, came back at cosine 0.969 — they would be
    // identical under a 4,096 truncation. 4,096 is AI Search's chunk size, not
    // this endpoint's limit. Hardcoded on purpose: deriving this from the
    // constant would let the default drift with nothing noticing.
    expect(MAX_INPUT_TOKENS).toBe(8192);
    expect(maxInputTokens()).toBe(8192);
  });

  it('refuses an over-cap text without touching the network', async () => {
    const fetchImpl = stub(embeddings(1));

    const result = await embedTexts([overCap()], { fetchImpl });

    expect(result).toMatchObject({
      ok: false,
      reason: 'over_cap',
      limit: MAX_INPUT_TOKENS,
      index: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.estimatedTokens).toBeGreaterThan(MAX_INPUT_TOKENS);
    // The whole point: no request was made, so nothing was half-embedded.
    expect(calls(fetchImpl).calls).toHaveLength(0);
  });

  it('refuses the whole batch and names which string overran', async () => {
    // A partial batch would hand back vectors the caller cannot line up against
    // its own inputs, which is how the wrong document gets the wrong vector.
    const fetchImpl = stub(embeddings(3));

    const result = await embedTexts(['short', 'also short', overCap()], { fetchImpl });

    expect(result).toMatchObject({ ok: false, reason: 'over_cap', index: 2 });
    expect(calls(fetchImpl).calls).toHaveLength(0);
  });

  it('sends a text that exactly fills the cap, unshortened', async () => {
    const exactly = 'x'.repeat(maxInputTokens() * CHARS_PER_TOKEN);
    expect(estimateTokens(exactly)).toBe(maxInputTokens());

    const fetchImpl = stub(embeddings(1));
    await expect(embedTexts([exactly], { fetchImpl })).resolves.toMatchObject({ ok: true });

    // Byte-identical. This client never trims text to make it fit — a trimmed
    // document is the silent truncation we are refusing on the caller's behalf.
    const body = JSON.parse(calls(fetchImpl).calls[0][1].body);
    expect(body.text[0]).toBe(exactly);
    expect(body.text[0]).toHaveLength(exactly.length);
  });

  it('lets the environment raise the cap deliberately', async () => {
    // Over the 8,192 default, under the override.
    const text = overCap(9000);
    const fetchImpl = stub(embeddings(1));

    await expect(embedTexts([text], { fetchImpl })).resolves.toMatchObject({ ok: false });

    process.env[MAX_INPUT_TOKENS_ENV] = '16384';
    expect(maxInputTokens()).toBe(16384);
    await expect(embedTexts([text], { fetchImpl })).resolves.toMatchObject({ ok: true });
    expect(JSON.parse(calls(fetchImpl).calls[0][1].body).text[0]).toBe(text);
  });

  it('lets the environment lower it too', () => {
    process.env[MAX_INPUT_TOKENS_ENV] = '512';
    expect(maxInputTokens()).toBe(512);
  });

  it('ignores a malformed override rather than throwing on a save path', () => {
    // A typo in a deploy config should cost recall on long documents, not the
    // save that triggered the index.
    for (const bad of ['', 'banana', '0', '-5', 'NaN']) {
      process.env[MAX_INPUT_TOKENS_ENV] = bad;
      expect(maxInputTokens()).toBe(MAX_INPUT_TOKENS);
    }
  });

  it('estimates pessimistically at three characters per token', () => {
    // Not four. Four is the English-prose average, and the documents that
    // overrun a cap are the ones full of code, identifiers and CJK, where a
    // token can be a single character.
    expect(CHARS_PER_TOKEN).toBe(3);
    expect(estimateTokens('abcdef')).toBe(2);
    // Never rounds DOWN: a 4-char string is two tokens by this estimate, not
    // one, because rounding down is how a document sneaks over the cap.
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});
