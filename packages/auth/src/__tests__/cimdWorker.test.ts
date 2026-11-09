/**
 * The Workers CIMD transport (../cimdWorker.ts), swapped in for
 * `@better-auth/cimd/node` on Cloudflare Workers builds. It must refuse what
 * the Node transport refuses (checked side by side below), never follow a
 * redirect, honour the caller's abort signal, and hand the body back as a
 * stream so the caller's 5120-byte cap and 5 s timeout apply to it.
 *
 * `fetch` is mocked: nothing here touches the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint's resolver misses this subpath export; TypeScript resolves it.
// eslint-disable-next-line import/no-unresolved
import { fetchClientMetadataResource as nodeTransport } from '@better-auth/cimd/node';
import { fetchClientMetadataResource as workerTransport } from '../cimdWorker.ts';

const DOC = 'https://client.example.com/oauth/client.json';

function mockFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return response();
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refuses what the Node transport refuses, without fetching', () => {
  it.each([
    ['http://client.example.com/oauth/client.json', 'plain http', /HTTPS/],
    ['https://127.0.0.1/c.json', 'loopback', /public-routable/],
    ['https://[::1]/c.json', 'loopback (IPv6)', /public-routable/],
    ['https://localhost/c.json', 'the name localhost', /public-routable/],
    ['https://app.localhost/c.json', 'a .localhost name', /public-routable/],
    ['https://10.1.2.3/c.json', 'private', /public-routable/],
    ['https://192.168.0.10/c.json', 'private', /public-routable/],
    ['https://169.254.169.254/c.json', 'link-local (cloud metadata)', /public-routable/],
    ['https://metadata.google.internal/c.json', 'cloud metadata name', /public-routable/],
    ['https://100.64.0.1/c.json', 'shared address space', /public-routable/],
    ['https://[::ffff:127.0.0.1]/c.json', 'IPv4-mapped loopback', /public-routable/],
  ])('%s (%s)', async (url, _kind, reason) => {
    const calls = mockFetch(() => new Response('{}'));
    await expect(workerTransport(url)).rejects.toThrow(reason);
    expect(calls).toHaveLength(0);
    // The Node transport refuses the same URL (by DNS answer for names).
    await expect(nodeTransport(url)).rejects.toThrow();
  });

  it.each(['POST', 'PUT', 'DELETE'])('the %s method', async method => {
    const calls = mockFetch(() => new Response('{}'));
    await expect(workerTransport(DOC, { method })).rejects.toThrow(/only GET and HEAD/);
    await expect(nodeTransport(DOC, { method })).rejects.toThrow(/only GET and HEAD/);
    expect(calls).toHaveLength(0);
  });
});

describe('a public HTTPS document', () => {
  it('is fetched with redirects off, whatever the caller asked', async () => {
    const calls = mockFetch(
      () =>
        new Response('{"client_id":"x"}', {
          headers: { 'content-type': 'application/json' },
        })
    );
    const response = await workerTransport(DOC, {
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(DOC);
    expect(calls[0].init.redirect).toBe('manual');
    expect(calls[0].init.method).toBe('GET');
    expect(new Headers(calls[0].init.headers).get('accept')).toBe('application/json');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ client_id: 'x' });
  });

  it('hands a redirect back instead of following it', async () => {
    const calls = mockFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://127.0.0.1/evil.json' },
        })
    );
    const response = await workerTransport(DOC);
    expect(calls).toHaveLength(1);
    expect(response.status).toBe(302);
    expect(response.redirected).toBe(false);
  });

  it("passes the caller's abort signal through", async () => {
    const controller = new AbortController();
    const calls = mockFetch(() => new Response('{}'));
    await workerTransport(DOC, { signal: controller.signal });
    const signal = calls[0].init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it('streams an oversized body back untouched (the caller caps it)', async () => {
    const big = 'x'.repeat(64 * 1024);
    mockFetch(() => new Response(big, { headers: { 'content-type': 'application/json' } }));
    const response = await workerTransport(DOC);
    expect(response.body).toBeInstanceOf(ReadableStream);
    expect((await response.text()).length).toBe(big.length);
  });

  it.each([204, 205, 304])('has no body on a %s', async status => {
    mockFetch(() => new Response(null, { status, headers: { etag: '"v1"' } }));
    const response = await workerTransport(DOC);
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(response.headers.get('etag')).toBe('"v1"');
  });

  it('has no body on a HEAD', async () => {
    const calls = mockFetch(() => new Response('{}', { status: 200 }));
    const response = await workerTransport(DOC, { method: 'HEAD' });
    expect(calls[0].init.method).toBe('HEAD');
    expect(response.body).toBeNull();
  });
});
