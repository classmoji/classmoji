/**
 * The Worker with Sentry ON: the real default export (`withSentry` and the
 * real `@sentry/cloudflare` transport), with `globalThis.fetch` standing in
 * for the token endpoint, GitHub and Sentry's ingest, so what is checked is
 * the serialized envelope exactly as it would leave the isolate.
 *
 * This Worker's URLs are credentials (a signature in the query or the path, a
 * files grant in the path) and its upstream calls carry tokens, so every case
 * drives a validly signed URL plus credential headers into a failure and then
 * looks for each of those values in what was sent.
 *
 * The SDK keeps one client per isolate (the first options it is given), so
 * Sentry OFF lives in its own file (sentry-off.test.ts). Nothing here calls
 * `Sentry.flush`: only the promises the Worker hands to `ctx.waitUntil` are
 * awaited, which is also what proves those promises deliver the events.
 */
import type { FilesFolder } from '@classmoji/content-signing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker, { clearRotationLog, resetNotConfiguredReport } from '../src/index.ts';
import { resetMediaBindingReport } from '../src/media.ts';
import { clearOriginCache } from '../src/token.ts';
import {
  BLOB_SHA,
  CLASSROOM,
  TREE_SHA,
  fakeBucket,
  fakeContext,
  fakeEnv,
  signedBlobUrl,
  signedFilesUrl,
  signedMediaUrl,
  signedThemeUrl,
} from './helpers.ts';
import * as secrets from './sentrySecrets.ts';
import type { Env } from '../src/env.ts';

type Upstream = (url: string, init?: RequestInit) => Response | Promise<Response>;

const realFetch = globalThis.fetch;
const sent: string[] = [];
let upstream: Upstream = () => new Response('unexpected', { status: 599 });

/**
 * Every outgoing request: Sentry's ingest is recorded, the rest goes to
 * `upstream`. An envelope counts as sent only once its (slow) request has
 * finished, so a test sees it only if something kept the invocation waiting
 * for it, as the Workers runtime would require.
 */
const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (new URL(url).host === secrets.INGEST_HOST) {
    await new Promise(resolve => setTimeout(resolve, 25));
    const body = init?.body;
    sent.push(typeof body === 'string' ? body : new TextDecoder().decode(body as Uint8Array));
    return new Response('{}', { status: 200 });
  }
  return upstream(url, init);
}) as typeof fetch;

/** The token endpoint answers with a working token; GitHub as the case says. */
const withGithub =
  (github: Upstream): Upstream =>
  (url, init) => {
    if (url.includes('/api/content/token')) {
      return new Response(
        JSON.stringify({
          org: 'classmoji',
          repo: 'content-cs1',
          token: secrets.INSTALLATION_TOKEN,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    return github(url, init);
  };

type SentEvent = {
  environment?: string;
  level?: string;
  tags?: Record<string, unknown>;
  request?: Record<string, unknown>;
  exception?: { values?: Array<{ type?: string; value?: string }> };
};

/** Events in the envelopes sent so far (an envelope is newline-delimited JSON). */
function events(): SentEvent[] {
  const out: SentEvent[] = [];
  for (const envelope of sent) {
    const lines = envelope.split('\n').filter(Boolean);
    for (let i = 1; i + 1 < lines.length; i += 2) {
      if ((JSON.parse(lines[i]) as { type?: string }).type === 'event') {
        out.push(JSON.parse(lines[i + 1]) as SentEvent);
      }
    }
  }
  return out;
}

function sentEnv(overrides: Partial<Env> = {}): Env {
  return fakeEnv({
    CONTENT_SIGNING_SECRET: secrets.MASTER_SECRET,
    CONTENT_WORKER_SHARED_SECRET: secrets.SHARED_SECRET,
    SENTRY_DSN: secrets.DSN,
    SENTRY_ENVIRONMENT: 'staging',
    ...overrides,
  });
}

async function call(url: string, env: Env, headers: Record<string, string> = {}) {
  const ctx = fakeContext();
  const response = await worker.fetch(
    new Request(url, { headers: { ...secrets.REQUEST_HEADERS, ...headers } }),
    env,
    ctx
  );
  const body = await response.arrayBuffer();
  await ctx.settled();
  return { response, body: new TextDecoder().decode(body) };
}

/**
 * How many promises the invocation has handed to `ctx.waitUntil` at the
 * moment `fetch` resolves, before the body is read.
 */
async function waitUntilsAtResponse(url: string, env: Env): Promise<number> {
  const ctx = fakeContext();
  let count = 0;
  const waitUntil = ctx.waitUntil.bind(ctx);
  ctx.waitUntil = (promise: Promise<unknown>) => {
    count += 1;
    waitUntil(promise);
  };
  const response = await worker.fetch(new Request(url), env, ctx);
  const atResponse = count;
  await response.arrayBuffer();
  await ctx.settled();
  return atResponse;
}

/** The credential parts of a signed URL: its query signature and its path-borne policy and grant. */
function credentialsOf(url: string): string[] {
  const parsed = new URL(url);
  const out = parsed.searchParams.getAll('sig');
  const segments = parsed.pathname.split('/');
  const policy = segments.find(segment => /^[a-z]+\.\d+\.\d+\.[A-Za-z0-9_-]{20,}$/.test(segment));
  if (policy) {
    const [, , exp, sig] = policy.split('.');
    out.push(policy, `${exp}.${sig}`, sig);
  }
  if (segments[3] === 'files') out.push(segments[4]);
  return out;
}

function expectNothingSecret(urls: string[]) {
  const text = sent.join('\n');
  expect(text).not.toBe('');
  for (const url of urls) expect(credentialsOf(url), url).not.toHaveLength(0);
  const forbidden = [...secrets.ALWAYS_FORBIDDEN, ...urls.flatMap(credentialsOf)];
  for (const secret of forbidden) expect(text, `leaked ${secret}`).not.toContain(secret);
}

function expectTagged(event: SentEvent) {
  expect(event.environment).toBe('staging');
  expect(event.tags).toMatchObject({ app: 'content', runtime: 'worker' });
}

const GAME: FilesFolder = { path: 'games/snake', treeSha: TREE_SHA };

beforeAll(() => {
  globalThis.fetch = stubFetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  sent.length = 0;
  clearOriginCache();
  clearRotationLog();
});

describe('content Worker with Sentry on (real @sentry/cloudflare, fake ingest)', () => {
  it('reports a failing origin from a theme URL as content.origin, scrubbed', async () => {
    const url = await signedThemeUrl({
      theme: 'night',
      treeSha: TREE_SHA,
      relPath: 'theme.css',
      master: secrets.MASTER_SECRET,
    });
    upstream = withGithub(target => {
      // The runtime's own message for a refused socket, quoting the URL and
      // the header it was sent with.
      throw new Error(`connect refused ${target} Bearer ${secrets.INSTALLATION_TOKEN}`);
    });

    const { response, body } = await call(url, sentEnv());

    expect(response.status).toBe(502);
    expect(body).toContain('origin unavailable');
    const [event, ...rest] = events();
    expect(rest).toHaveLength(0);
    expectTagged(event);
    expect(event.level).toBe('warning');
    expect(event.tags).toMatchObject({
      surface: 'content.origin',
      kind: 'theme',
      classroom: CLASSROOM,
      status: 502,
    });
    expect(event.exception?.values?.[0]?.value).toMatch(
      /^github tree a{40} unreachable: connect refused https:\/\/api\.github\.com\/repos\/classmoji\/content-cs1\/git\/trees\/a{40} Bearer \[redacted\]$/
    );
    expect(event.request?.url).toMatch(/\/c\/[^/]+\/theme\/night\/a{40}\/\[sig\]\/theme\.css$/);
    expectNothingSecret([url]);
  });

  it('does not report an origin 404 (a tree that is gone)', async () => {
    const url = await signedThemeUrl({
      theme: 'night',
      treeSha: TREE_SHA,
      relPath: 'theme.css',
      master: secrets.MASTER_SECRET,
    });
    upstream = withGithub(() => new Response('Not Found', { status: 404 }));

    const { response } = await call(url, sentEnv());

    expect(response.status).toBe(502);
    expect(events()).toHaveLength(0);
  });

  it('reports a non-404 origin blob status, and not a 404 one', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png', master: secrets.MASTER_SECRET });

    upstream = withGithub(() => new Response('rate limited', { status: 403 }));
    expect((await call(url, sentEnv())).response.status).toBe(502);
    const [event, ...rest] = events();
    expect(rest).toHaveLength(0);
    expectTagged(event);
    expect(event.level).toBe('warning');
    expect(event.tags).toMatchObject({ surface: 'content.origin', kind: 'blob', status: 403 });
    expect(event.exception?.values?.[0]?.value).toBe('origin blob read answered 403');
    expectNothingSecret([url]);

    sent.length = 0;
    upstream = withGithub(() => new Response('Not Found', { status: 404 }));
    expect((await call(url, sentEnv())).response.status).toBe(502);
    expect(events()).toHaveLength(0);
  });

  it('reports an unhandled error from a files URL as content.unhandled, scrubbed', async () => {
    const url = await signedFilesUrl({
      folders: [GAME],
      repoPath: 'games/snake/app.js',
      master: secrets.MASTER_SECRET,
    });
    const bucket = fakeBucket();
    // A failure whose message quotes the full request URL and a credential:
    // the worst a library error could carry.
    bucket.get = async () => {
      throw new Error(`R2 read failed for ${url} with Bearer ${secrets.SHARED_SECRET}`);
    };

    const { response, body } = await call(
      `${url}?deck=x&sig=pagesecretvalue`,
      sentEnv({ CACHE: bucket as unknown as R2Bucket })
    );

    expect(response.status).toBe(500);
    expect(body).toContain('internal error');
    const [event, ...rest] = events();
    expect(rest).toHaveLength(0);
    expectTagged(event);
    expect(event.level).toBe('error');
    expect(event.tags).toMatchObject({
      surface: 'content.unhandled',
      kind: 'files',
      classroom: CLASSROOM,
    });
    expect(event.exception?.values?.[0]?.value).toBe(
      `R2 read failed for https://content-staging.classmoji.io/c/${CLASSROOM}/files/[grant]/[sig]/games/snake/app.js with Bearer [redacted]`
    );
    expect(event.request?.url).toBe(
      `https://content-staging.classmoji.io/c/${CLASSROOM}/files/[grant]/[sig]/games/snake/app.js`
    );
    expectNothingSecret([url, `${url}?deck=x&sig=pagesecretvalue`]);
    expect(sent.join('\n')).not.toContain('pagesecretvalue');
  });

  it('reports an unhandled error from a blob URL with its signature in the query', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png', master: secrets.MASTER_SECRET });
    const bucket = fakeBucket();
    bucket.get = async () => {
      throw new Error(`R2 read failed for ${url}`);
    };

    const { response } = await call(url, sentEnv({ CACHE: bucket as unknown as R2Bucket }));

    expect(response.status).toBe(500);
    const [event] = events();
    expect(event.tags).toMatchObject({ surface: 'content.unhandled', kind: 'blob' });
    const plain = `https://content-staging.classmoji.io/c/${CLASSROOM}/blob/${BLOB_SHA}.png`;
    expect(event.exception?.values?.[0]?.value).toBe(`R2 read failed for ${plain}`);
    expect(event.request?.url).toBe(plain);
    expectNothingSecret([url]);
  });

  it('reports a failed cache write from inside waitUntil, after the response', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png', master: secrets.MASTER_SECRET });
    const bucket = fakeBucket();
    // Fails well after the response has gone and the SDK's own end-of-request
    // flush has run, as a slow R2 write does.
    bucket.put = async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      throw new Error('R2 put failed: internal error');
    };
    upstream = withGithub(
      () => new Response('origin-bytes', { headers: { 'Content-Length': '12' } })
    );

    const { response, body } = await call(url, sentEnv({ CACHE: bucket as unknown as R2Bucket }));

    expect(response.status).toBe(200);
    expect(body).toBe('origin-bytes');
    const [event, ...rest] = events();
    expect(rest).toHaveLength(0);
    expectTagged(event);
    expect(event.level).toBe('warning');
    expect(event.tags).toMatchObject({ surface: 'content.cache_put' });
    expect(event.exception?.values?.[0]?.value).toBe('R2 put failed: internal error');
    expectNothingSecret([url]);
  });

  it('reports a Worker without its secrets once per isolate, not per request', async () => {
    resetNotConfiguredReport();
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png', master: secrets.MASTER_SECRET });
    const env = sentEnv({ CONTENT_SIGNING_SECRET: undefined });

    expect((await call(url, env)).response.status).toBe(503);
    expect((await call(url, env)).response.status).toBe(503);

    const reported = events();
    expect(reported).toHaveLength(1);
    expectTagged(reported[0]);
    expect(reported[0].tags).toMatchObject({ surface: 'content.not_configured' });
    expectNothingSecret([url]);
  });

  it('reports a missing MEDIA binding once per isolate', async () => {
    resetMediaBindingReport();
    const url = await signedMediaUrl({ variant: 'orig.mp4', master: secrets.MASTER_SECRET });
    const env = sentEnv({ MEDIA: undefined as unknown as R2Bucket });

    expect((await call(url, env)).response.status).toBe(503);
    expect((await call(url, env)).response.status).toBe(503);

    const reported = events();
    expect(reported).toHaveLength(1);
    expect(reported[0].tags).toMatchObject({ surface: 'content.media_binding' });
    expectNothingSecret([url]);
  });

  it('leaves served bodies alone: a streamed text miss and a 206 come back exactly', async () => {
    // text/plain with no Content-Length is the shape the SDK would otherwise
    // re-wrap as a "streaming" response.
    const textUrl = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'txt',
      master: secrets.MASTER_SECRET,
    });
    upstream = withGithub(() => new Response('plain origin text'));
    // A re-wrapped body would defer the SDK's end-of-request flush until the
    // body is read; unwrapped, it is registered (beside the cache write) by
    // the time the response is handed back.
    expect(await waitUntilsAtResponse(textUrl, sentEnv())).toBe(2);
    const text = await call(textUrl, sentEnv());
    expect(text.response.status).toBe(200);
    expect(text.body).toBe('plain origin text');
    expect(text.response.headers.get('Content-Type')).toMatch(/^text\/plain/);
    expect(text.response.headers.get('Content-Length')).toBeNull();

    const rangeUrl = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'png',
      master: secrets.MASTER_SECRET,
    });
    const bucket = fakeBucket({ [`blobs/${BLOB_SHA}`]: { body: '0123456789' } });
    const ranged = await call(rangeUrl, sentEnv({ CACHE: bucket as unknown as R2Bucket }), {
      Range: 'bytes=2-5',
    });
    expect(ranged.response.status).toBe(206);
    expect(ranged.body).toBe('2345');
    expect(ranged.response.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(ranged.response.headers.get('Content-Length')).toBe('4');

    expect(events()).toHaveLength(0);
  });
});
