/**
 * What an origin pull costs, and what happens when it costs too much.
 *
 * An R2 hit is milliseconds; a miss was measured on staging at 4–25 seconds of
 * wall time against ~5ms of CPU. That is all waiting, and it can only be
 * waiting on one of two things — minting an installation token from the webapp,
 * or reading the blob out of GitHub. This suite pins the line that tells them
 * apart, and the two timeouts that stop either one waiting forever.
 *
 * The log assertions are as much about what the line does NOT contain. The
 * Worker's only secrets are the shared secret it presents to the token endpoint
 * and the installation token it presents to GitHub, and both pass through the
 * exact code path this line is emitted from.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { clearRotationLog } from '../src/index.ts';
import { clearOriginCache, TOKEN_FETCH_TIMEOUT_MS } from '../src/token.ts';
import { BLOB_FETCH_TIMEOUT_MS, GitHubOrigin } from '../src/origins/github.ts';
import { OriginError } from '../src/origins/types.ts';
import { BLOB_SHA, CLASSROOM, fakeContext, fakeEnv, signedBlobUrl } from './helpers.ts';

const realFetch = globalThis.fetch;

const TOKEN_BODY = JSON.stringify({
  org: 'classmoji',
  repo: 'content-cs1',
  token: 'ghs_super_secret',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});

/** The token endpoint and GitHub, each answerable independently. */
function stubUpstreams(
  handlers: { token?: () => Promise<Response>; blob?: () => Promise<Response> } = {}
) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/content/token')) {
      return (
        handlers.token?.() ??
        new Response(TOKEN_BODY, { headers: { 'Content-Type': 'application/json' } })
      );
    }
    if (url.includes('/git/blobs/')) return handlers.blob?.() ?? new Response('origin-bytes');
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

/** What `AbortSignal.timeout` rejects with — the shape the runtime really throws. */
function timeoutRejection(): Promise<Response> {
  return Promise.reject(
    new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  );
}

function pullLines(info: { mock: { calls: unknown[][] } }): string[] {
  return info.mock.calls
    .map(call => String(call[0]))
    .filter(line => line.startsWith('[content] origin pull '));
}

beforeEach(() => {
  clearOriginCache();
  clearRotationLog();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('the origin pull log line', () => {
  it('reports both legs, the status and the size — and no secret', async () => {
    stubUpstreams({
      blob: async () => new Response('origin-bytes', { headers: { 'Content-Length': '12' } }),
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });
    const response = await worker.fetch(new Request(url), fakeEnv(), fakeContext());
    expect(response.status).toBe(200);

    const lines = pullLines(info);
    expect(lines).toHaveLength(1);
    // The shape, exactly. `minted` because this isolate's token cache is empty,
    // which is the cold case the line exists to identify.
    expect(lines[0]).toMatch(
      new RegExp(
        `^\\[content\\] origin pull sha=${BLOB_SHA} token=\\d+ms \\(minted\\) ` +
          `blob=\\d+ms status=200 bytes=12$`
      )
    );
    // Neither credential, and no query string — the signature travels in one.
    expect(lines[0]).not.toContain('ghs_super_secret');
    expect(lines[0]).not.toContain('shared');
    expect(lines[0]).not.toContain('sig=');
    expect(lines[0]).not.toContain('?');
  });

  it('says `cached` for the second pull, so a slow token is never blamed twice', async () => {
    stubUpstreams();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });
    await worker.fetch(new Request(url), fakeEnv(), fakeContext());
    await worker.fetch(new Request(url), fakeEnv(), fakeContext());

    const lines = pullLines(info);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('(minted)');
    expect(lines[1]).toContain('(cached)');
  });

  it('reports bytes=unknown when the origin encoded the body', async () => {
    // GitHub gzips text, so `Content-Length` describes bytes the runtime has
    // already decoded. Refusing to name a number is the honest answer, and it
    // is ordinary traffic rather than a fault.
    stubUpstreams({
      blob: async () =>
        new Response('{"blocks":[]}', {
          headers: { 'Content-Length': '999', 'Content-Encoding': 'gzip' },
        }),
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'json' });
    await worker.fetch(new Request(url), fakeEnv(), fakeContext());

    expect(pullLines(info)[0]).toContain('bytes=unknown');
  });

  it('bills a silent token endpoint to the token leg, not to the blob', async () => {
    // The regression this pins: the timing callback used to fire only after a
    // mint RESOLVED, so the one case the bound exists for — the endpoint going
    // quiet for the whole of `TOKEN_FETCH_TIMEOUT_MS` — reported nothing at
    // all. Its time then fell through into the remainder, and the line read
    // `token=0ms (cached) blob=25000ms`: an operator sent to GitHub for a stall
    // the webapp caused. The mint below is slow and then fails, which is that
    // timeout in miniature.
    stubUpstreams({
      token: async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return timeoutRejection();
      },
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });
    const response = await worker.fetch(new Request(url), fakeEnv(), fakeContext());
    expect(response.status).toBe(502);

    const lines = pullLines(info);
    expect(lines).toHaveLength(1);

    // `minted` on the failing path always: a cache hit is a map lookup and has
    // nothing to fail on, so an acquisition that threw was a mint.
    const token = lines[0].match(/token=(\d+)ms \(minted\)/);
    expect(token).not.toBeNull();
    expect(Number(token?.[1])).toBeGreaterThanOrEqual(25);

    // And GitHub is credited with nothing, because that leg never ran. The
    // accounting is a difference of two clocks, so allow a tick of drift.
    const blob = lines[0].match(/blob=(\d+)ms/);
    expect(blob).not.toBeNull();
    expect(Number(blob?.[1])).toBeLessThanOrEqual(2);
    expect(lines[0]).toContain('status=0');
  });

  it('still logs the pull that never got a response', async () => {
    // The timeout case is the one most worth seeing, so it is timed and logged
    // like any other. `status=0` is the marker for "no response existed".
    stubUpstreams({ blob: timeoutRejection });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });
    await worker.fetch(new Request(url), fakeEnv(), fakeContext());

    const lines = pullLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      new RegExp(
        `^\\[content\\] origin pull sha=${BLOB_SHA} token=\\d+ms \\(minted\\) ` +
          `blob=\\d+ms status=0 bytes=unknown$`
      )
    );
  });
});

describe('origin timeouts', () => {
  it('bounds the token endpoint and the blob read', () => {
    // Both are generous on purpose — the token endpoint can be a cold start,
    // and a large blob is exactly what the Worker proxies so a browser need
    // not. They are bounds so a silent upstream cannot hold an invocation.
    expect(TOKEN_FETCH_TIMEOUT_MS).toBe(25_000);
    expect(BLOB_FETCH_TIMEOUT_MS).toBe(30_000);
  });

  it('asks GitHub with the blob deadline attached', async () => {
    const fetchMock = vi.fn(async () => new Response('bytes'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await new GitHubOrigin().fetchBlob({
      org: 'classmoji',
      repo: 'content-cs1',
      token: 'ghs_x',
      sha: BLOB_SHA,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { signal?: AbortSignal }];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks GitHub with the same deadline attached for a tree', async () => {
    // The tree listing is a plain fetch to the same upstream, so it can hang in
    // exactly the same way. An unbounded call here would hold the invocation
    // open no matter how carefully the blob read beside it is bounded.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tree: [] })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await new GitHubOrigin().fetchTree({
      org: 'classmoji',
      repo: 'content-cs1',
      token: 'ghs_x',
      treeSha: 'main',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { signal?: AbortSignal }];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('turns a tree timeout into an origin error rather than a raw rejection', async () => {
    globalThis.fetch = (() => timeoutRejection()) as unknown as typeof fetch;

    await expect(
      new GitHubOrigin().fetchTree({
        org: 'classmoji',
        repo: 'content-cs1',
        token: 'ghs_x',
        treeSha: 'main',
      })
    ).rejects.toBeInstanceOf(OriginError);
  });

  it('turns a blob timeout into an origin error rather than a raw rejection', async () => {
    // Not the runtime's own DOMException: the router answers `OriginError` with
    // a 502 the app falls back from, and anything else with an opaque 500.
    globalThis.fetch = (() => timeoutRejection()) as unknown as typeof fetch;

    await expect(
      new GitHubOrigin().fetchBlob({
        org: 'classmoji',
        repo: 'content-cs1',
        token: 'ghs_x',
        sha: BLOB_SHA,
      })
    ).rejects.toBeInstanceOf(OriginError);
  });

  it('502s `origin unavailable` when the blob read times out', async () => {
    stubUpstreams({ blob: timeoutRejection });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });
    const response = await worker.fetch(new Request(url), fakeEnv(), fakeContext());

    expect(response.status).toBe(502);
    expect(await response.text()).toContain('origin unavailable');
  });

  it('502s `origin unavailable` when the token endpoint times out', async () => {
    stubUpstreams({ token: timeoutRejection });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });
    const response = await worker.fetch(new Request(url), fakeEnv(), fakeContext());

    expect(response.status).toBe(502);
    expect(await response.text()).toContain('origin unavailable');
  });

  it('does not spend the budget twice on a silent token endpoint', async () => {
    // A timeout is an unreachable origin, not a rejected credential, so it must
    // NOT be an OriginAuthError — that would send `withOriginRetry` back for a
    // second mint against the same silence.
    let tokenCalls = 0;
    stubUpstreams({
      token: () => {
        tokenCalls += 1;
        return timeoutRejection();
      },
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const url = await signedBlobUrl({ classroomId: CLASSROOM, sha: BLOB_SHA, ext: 'png' });
    await worker.fetch(new Request(url), fakeEnv(), fakeContext());

    expect(tokenCalls).toBe(1);
  });
});
