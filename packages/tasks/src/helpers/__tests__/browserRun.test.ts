/**
 * The Browser Run screenshot call: what we send, and how we read what comes
 * back.
 *
 * Four things here are load-bearing and none of them is obvious from the code:
 *
 *  - the RETRYABLE classification. 429 and 5xx are worth another attempt and
 *    the task rethrows them into its retry policy; 400 and 422 are the page
 *    saying it will not render, and retrying those three times just spends
 *    browser-hours to reach the same answer.
 *  - the RESPONSE SHAPE. `encoding: 'base64'` makes a 200 `text/plain` holding
 *    a bare base64 string, but the endpoint can also answer image bytes or a
 *    JSON envelope, and reading one as another commits a corrupt file into a
 *    classroom's content repo where nothing would notice.
 *  - the SIZE WINDOW. A render that goes wrong usually succeeds at
 *    photographing the WRONG THING — an error page is a perfectly valid WebP,
 *    and a few hundred bytes of it would be committed as a deck's card. Bytes
 *    are the cheapest thing that tells that apart from a slide.
 *  - REDACTION. The render token is a credential, and Cloudflare quotes the
 *    request back in several of its error messages.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BrowserRunError,
  MAX_IMAGE_BYTES,
  MIN_IMAGE_BYTES,
  isBrowserRunConfigured,
  redactRenderToken,
  screenshotToBase64,
} from '../browserRun.ts';

/** Comfortably inside the window; the bytes themselves are never inspected. */
const IMAGE = Buffer.alloc(MIN_IMAGE_BYTES + 1024, 7);
const IMAGE_BASE64 = IMAGE.toString('base64');

const RENDER_TOKEN = '1767225720.c2lnbmF0dXJl';

function response(
  body: BodyInit,
  { status = 200, headers = {} }: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(body, { status, headers });
}

const request = (fetchImpl: typeof fetch) => ({
  url: 'https://slides.classmoji.test/deck/thumbnail-source',
  headers: { 'X-Render-Token': RENDER_TOKEN },
  width: 1280,
  height: 720,
  readySelector: '[data-thumbnail-ready]',
  quality: 80,
  fetchImpl,
});

beforeEach(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct-1234';
  process.env.CLOUDFLARE_BROWSER_RENDERING_TOKEN = 'super-secret-token';
});

afterEach(() => {
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_BROWSER_RENDERING_TOKEN;
});

describe('isBrowserRunConfigured', () => {
  it('needs both the account and the token', () => {
    expect(isBrowserRunConfigured()).toBe(true);
    delete process.env.CLOUDFLARE_BROWSER_RENDERING_TOKEN;
    expect(isBrowserRunConfigured()).toBe(false);
  });
});

describe('the request', () => {
  it('posts the account screenshot endpoint with cacheTTL=0 and the deck options', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response(IMAGE_BASE64, { headers: { 'content-type': 'text/plain' } }));

    await screenshotToBase64(request(fetchImpl as unknown as typeof fetch));

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-1234/browser-rendering/screenshot?cacheTTL=0'
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer super-secret-token');

    expect(JSON.parse(init.body)).toEqual({
      url: 'https://slides.classmoji.test/deck/thumbnail-source',
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      gotoOptions: { waitUntil: 'networkidle0', timeout: 30000 },
      waitForSelector: { selector: '[data-thumbnail-ready]', timeout: 15000 },
      screenshotOptions: { type: 'webp', quality: 80, encoding: 'base64' },
      rejectResourceTypes: ['media', 'websocket'],
      setExtraHTTPHeaders: { 'X-Render-Token': RENDER_TOKEN },
    });
  });

  it('never sets bestAttempt — a waitForSelector timeout MUST fail the render', async () => {
    // `bestAttempt` returns a picture even when the readiness selector never
    // arrives, and the page that never raises it is precisely the one that did
    // not render: a 403 body, a Cloudflare error page, a blank frame. Any of
    // those would be committed into a classroom's repo as that deck's card.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response(IMAGE_BASE64, { headers: { 'content-type': 'text/plain' } }));

    await screenshotToBase64(request(fetchImpl as unknown as typeof fetch));

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty('bestAttempt');
  });

  it('omits setExtraHTTPHeaders entirely when there are none', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response(IMAGE_BASE64, { headers: { 'content-type': 'text/plain' } }));

    const { headers: _headers, ...noHeaders } = request(fetchImpl as unknown as typeof fetch);
    await screenshotToBase64(noHeaders);

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty('setExtraHTTPHeaders');
  });

  it('refuses to call at all when unconfigured', async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    const fetchImpl = vi.fn();
    await expect(
      screenshotToBase64(request(fetchImpl as unknown as typeof fetch))
    ).rejects.toBeInstanceOf(BrowserRunError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('reading the response', () => {
  it('takes a text/plain body as the base64 image', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response(`${IMAGE_BASE64}\n`, { headers: { 'content-type': 'text/plain' } })
      );
    await expect(screenshotToBase64(request(fetchImpl as unknown as typeof fetch))).resolves.toBe(
      IMAGE_BASE64
    );
  });

  it('encodes image bytes itself when the endpoint answers binary anyway', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response(IMAGE, { headers: { 'content-type': 'image/webp' } }));
    await expect(screenshotToBase64(request(fetchImpl as unknown as typeof fetch))).resolves.toBe(
      IMAGE_BASE64
    );
  });

  it('unwraps a JSON envelope', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(JSON.stringify({ success: true, result: { screenshot: IMAGE_BASE64 } }), {
        headers: { 'content-type': 'application/json' },
      })
    );
    await expect(screenshotToBase64(request(fetchImpl as unknown as typeof fetch))).resolves.toBe(
      IMAGE_BASE64
    );
  });

  it('refuses a 200 that is not an image rather than committing it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response('<html>gateway error</html>', { headers: { 'content-type': 'text/html' } })
      );
    await expect(screenshotToBase64(request(fetchImpl as unknown as typeof fetch))).rejects.toThrow(
      /not an image/
    );
  });
});

describe('the size window', () => {
  const asBase64 = (bytes: number) => Buffer.alloc(bytes, 7).toString('base64');

  it('rejects an image under the floor — a blank or error page, not a slide', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response(asBase64(MIN_IMAGE_BYTES - 1), { headers: { 'content-type': 'text/plain' } })
      );

    const error = (await screenshotToBase64(request(fetchImpl as unknown as typeof fetch)).catch(
      (e: unknown) => e
    )) as BrowserRunError;

    expect(error).toBeInstanceOf(BrowserRunError);
    expect(error.message).toMatch(/floor/);
    // NOT retryable: the same page produces the same bytes next time.
    expect(error.retryable).toBe(false);
  });

  it('rejects an image over the ceiling rather than committing it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response(asBase64(MAX_IMAGE_BYTES + 1), { headers: { 'content-type': 'text/plain' } })
      );

    const error = (await screenshotToBase64(request(fetchImpl as unknown as typeof fetch)).catch(
      (e: unknown) => e
    )) as BrowserRunError;

    expect(error).toBeInstanceOf(BrowserRunError);
    expect(error.message).toMatch(/ceiling/);
    expect(error.retryable).toBe(false);
  });

  it('applies to every response shape, not just the text one', async () => {
    // A JSON envelope and raw image bytes are the same commit with a different
    // wrapper; a window that only guarded one of them would not be a window.
    const tooSmall = Buffer.alloc(MIN_IMAGE_BYTES - 1, 7);

    const json = vi.fn().mockResolvedValue(
      response(JSON.stringify({ success: true, result: tooSmall.toString('base64') }), {
        headers: { 'content-type': 'application/json' },
      })
    );
    await expect(screenshotToBase64(request(json as unknown as typeof fetch))).rejects.toThrow(
      /floor/
    );

    const binary = vi
      .fn()
      .mockResolvedValue(response(tooSmall, { headers: { 'content-type': 'image/webp' } }));
    await expect(screenshotToBase64(request(binary as unknown as typeof fetch))).rejects.toThrow(
      /floor/
    );
  });

  it('accepts the ordinary case in between', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response(IMAGE_BASE64, { headers: { 'content-type': 'text/plain' } }));
    await expect(
      screenshotToBase64(request(fetchImpl as unknown as typeof fetch))
    ).resolves.toBeTruthy();
  });
});

describe('classifying failures', () => {
  it('marks a 429 retryable and carries its Retry-After', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(JSON.stringify({ success: false, errors: [{ message: 'Rate limited' }] }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '12' },
      })
    );

    const error = await screenshotToBase64(request(fetchImpl as unknown as typeof fetch)).catch(
      (e: unknown) => e as BrowserRunError
    );

    expect(error).toBeInstanceOf(BrowserRunError);
    expect(error).toMatchObject({
      status: 429,
      retryable: true,
      retryAfterSeconds: 12,
      message: 'Rate limited',
    });
  });

  it('reads a Retry-After sent as an HTTP-date, which RFC 9110 also allows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response('', {
        status: 429,
        headers: {
          'content-type': 'text/plain',
          'retry-after': new Date(Date.now() + 30_000).toUTCString(),
        },
      })
    );

    const error = (await screenshotToBase64(request(fetchImpl as unknown as typeof fetch)).catch(
      (e: unknown) => e
    )) as BrowserRunError;

    // Second-resolution header against a millisecond clock: the useful
    // assertion is "about thirty seconds", not an exact integer.
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(28);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(31);
  });

  it('reads a Retry-After date already in the past as no wait at all', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response('', {
        status: 429,
        headers: {
          'content-type': 'text/plain',
          'retry-after': new Date(Date.now() - 60_000).toUTCString(),
        },
      })
    );

    const error = (await screenshotToBase64(request(fetchImpl as unknown as typeof fetch)).catch(
      (e: unknown) => e
    )) as BrowserRunError;

    expect(error.retryAfterSeconds).toBe(0);
  });

  it('marks a 5xx retryable and a 4xx not', async () => {
    for (const [status, retryable] of [
      [400, false],
      [422, false],
      [500, true],
      [503, true],
    ] as const) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(response('', { status, headers: { 'content-type': 'text/plain' } }));
      const error = (await screenshotToBase64(request(fetchImpl as unknown as typeof fetch)).catch(
        (e: unknown) => e
      )) as BrowserRunError;
      expect(error.status).toBe(status);
      expect(error.retryable).toBe(retryable);
    }
  });

  it('never puts the CLOUDFLARE token in the error it throws', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(JSON.stringify({ errors: [{ message: 'Bad request' }] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    );
    const error = (await screenshotToBase64(request(fetchImpl as unknown as typeof fetch)).catch(
      (e: unknown) => e
    )) as BrowserRunError;
    expect(`${error.message}${error.stack ?? ''}`).not.toContain('super-secret-token');
  });

  it('never puts the RENDER token in the error, even when Cloudflare echoes it', async () => {
    // Cloudflare's own message quotes the request back. Both shapes the token
    // has ever travelled in have to come out: the header it uses now, and the
    // `?render=` query string it used to.
    const fetchImpl = vi.fn().mockResolvedValue(
      response(
        JSON.stringify({
          errors: [
            {
              message: `Navigation failed for https://slides.classmoji.test/d/thumbnail-source?render=${RENDER_TOKEN} with headers {"X-Render-Token":"${RENDER_TOKEN}"}`,
            },
          ],
        }),
        { status: 422, headers: { 'content-type': 'application/json' } }
      )
    );

    const error = (await screenshotToBase64(request(fetchImpl as unknown as typeof fetch)).catch(
      (e: unknown) => e
    )) as BrowserRunError;

    expect(error.message).not.toContain(RENDER_TOKEN);
    expect(error.message).toContain('render=[redacted]');
    expect(error.message).toContain('[redacted]');
    // Still legible as an error: the redaction takes the credential, not the
    // diagnosis.
    expect(error.message).toContain('Navigation failed');
  });
});

describe('redactRenderToken', () => {
  it('takes the query-string form wherever it appears', () => {
    expect(redactRenderToken(`https://x.test/a/thumbnail-source?render=${RENDER_TOKEN}`)).toBe(
      'https://x.test/a/thumbnail-source?render=[redacted]'
    );
    expect(redactRenderToken(`?a=1&render=${RENDER_TOKEN}&b=2`)).toBe('?a=1&render=[redacted]&b=2');
  });

  it('takes the header form in either quoting style', () => {
    expect(redactRenderToken(`X-Render-Token: ${RENDER_TOKEN}`)).not.toContain(RENDER_TOKEN);
    expect(redactRenderToken(`{"x-render-token":"${RENDER_TOKEN}"}`)).not.toContain(RENDER_TOKEN);
  });

  it('leaves ordinary text alone', () => {
    expect(redactRenderToken('Navigation timed out after 30000ms')).toBe(
      'Navigation timed out after 30000ms'
    );
  });
});
