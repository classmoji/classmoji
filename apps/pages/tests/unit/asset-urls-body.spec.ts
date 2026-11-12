/**
 * The asset-url lookup reads its JSON body through the byte-counting reader,
 * with a limit a full batch of the longest references fits in.
 *
 * Every case here is answered before the route looks a page up, so the action
 * runs as it is, without Postgres.
 */

import { test, expect } from '@playwright/test';
import { action } from '../../app/routes/api.asset-urls/route.ts';
import { ASSET_URLS_MAX_REFS } from '../../app/utils/liveAssets.ts';

const post = (body: BodyInit, init: RequestInit = {}) =>
  new Request('http://pages.test/api/asset-urls', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    ...init,
  });

/** A stream over `text`, handed over 64 KiB at a time, with no declared length. */
function chunked(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(at, at + 65_536));
      at += 65_536;
    },
  });
}

test.describe('the asset-url lookup request size', () => {
  test('a body over the limit is refused with a 413', async () => {
    const response = await action({ request: post('x'.repeat(2 * 1024 * 1024)) });
    expect(response.status).toBe(413);
  });

  test('a body over the limit that declares no length is refused with a 413', async () => {
    const request = post(chunked(JSON.stringify({ refs: ['a'.repeat(2 * 1024 * 1024)] })), {
      duplex: 'half',
    } as RequestInit);
    const response = await action({ request });
    expect(response.status).toBe(413);
  });

  test('a full batch of the longest references is read', async () => {
    // Each reference at the longest the client asks about, every character one
    // JSON writes in six bytes. No page id, so the route answers before any
    // lookup.
    const refs = Array.from(
      { length: ASSET_URLS_MAX_REFS },
      (_, n) => `${String(n).padStart(4, '0')}${'\u0001'.repeat(2048 - 4)}`
    );
    const response = await action({ request: post(JSON.stringify({ refs })) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'A page is required.' });
  });

  test('a body that is not JSON keeps its answer', async () => {
    const response = await action({ request: post('{') });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Expected JSON' });
  });
});
