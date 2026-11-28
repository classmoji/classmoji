/**
 * The Worker with SENTRY_DSN unset (the local and test default): the same
 * failures as sentry.test.ts answer exactly as before and nothing is sent
 * anywhere. Its own file, because the SDK keeps the first client options an
 * isolate sees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index.ts';
import { clearOriginCache } from '../src/token.ts';
import { BLOB_SHA, fakeBucket, fakeContext, fakeEnv, signedBlobUrl } from './helpers.ts';
import * as secrets from './sentrySecrets.ts';

const realFetch = globalThis.fetch;
const requested: string[] = [];
let serveText = false;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    if (url.includes('/api/content/token')) {
      return new Response(
        JSON.stringify({
          org: 'classmoji',
          repo: 'content-cs1',
          token: secrets.INSTALLATION_TOKEN,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        })
      );
    }
    if (serveText) return new Response('plain origin text');
    return new Response('rate limited', { status: 403 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

async function call(url: string, bucket = fakeBucket()) {
  clearOriginCache();
  const ctx = fakeContext();
  const response = await worker.fetch(
    new Request(url, { headers: secrets.REQUEST_HEADERS }),
    fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
    ctx
  );
  const body = await response.text();
  await ctx.settled();
  return { status: response.status, body };
}

/**
 * How many promises the invocation has handed to `ctx.waitUntil` at the
 * moment `fetch` resolves, before the body is read.
 */
async function waitUntilsAtResponse(url: string): Promise<number> {
  clearOriginCache();
  const ctx = fakeContext();
  let count = 0;
  const waitUntil = ctx.waitUntil.bind(ctx);
  ctx.waitUntil = (promise: Promise<unknown>) => {
    count += 1;
    waitUntil(promise);
  };
  const response = await worker.fetch(new Request(url), fakeEnv(), ctx);
  const atResponse = count;
  await response.arrayBuffer();
  await ctx.settled();
  return atResponse;
}

describe('content Worker with SENTRY_DSN unset', () => {
  it('never re-wraps a body, even with Sentry off', async () => {
    // text/plain with no Content-Length is the shape the SDK would otherwise
    // treat as streaming. A re-wrapped body defers the SDK's end-of-request
    // flush until it is read; unwrapped, the flush is registered (beside the
    // cache write) by the time the response is handed back.
    serveText = true;
    try {
      const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'txt' });
      expect(await waitUntilsAtResponse(url)).toBe(2);
    } finally {
      serveText = false;
    }
  });

  it('answers failures as before and sends nothing to Sentry', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });

    const origin = await call(url);
    expect(origin.status).toBe(502);
    expect(origin.body).toContain('origin unavailable');

    const bucket = fakeBucket();
    bucket.get = async () => {
      throw new Error('R2 read failed');
    };
    const unhandled = await call(url, bucket);
    expect(unhandled.status).toBe(500);
    expect(unhandled.body).toContain('internal error');

    expect(requested.length).toBeGreaterThan(0);
    for (const url of requested) expect(new URL(url).host).not.toBe(secrets.INGEST_HOST);
    expect(requested.some(url => url.includes('sentry'))).toBe(false);
  });
});
