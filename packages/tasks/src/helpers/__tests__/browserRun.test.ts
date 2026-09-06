/**
 * The Browser Run screenshot call: what we send, and how we read what comes
 * back.
 *
 * Two things here are load-bearing and neither is obvious from the code:
 *
 *  - the RETRYABLE classification. 429 and 5xx are worth another attempt and
 *    the task rethrows them into its retry policy; 400 and 422 are the page
 *    saying it will not render, and retrying those three times just spends
 *    browser-hours to reach the same answer.
 *  - the RESPONSE SHAPE. `encoding: 'base64'` makes a 200 `text/plain` holding
 *    a bare base64 string, but the endpoint can also answer image bytes or a
 *    JSON envelope, and reading one as another commits a corrupt file into a
 *    classroom's content repo where nothing would notice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserRunError, isBrowserRunConfigured, screenshotToBase64 } from '../browserRun.ts';

const IMAGE = Buffer.from('webp-ish bytes');
const IMAGE_BASE64 = IMAGE.toString('base64');

function response(
  body: BodyInit,
  { status = 200, headers = {} }: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(body, { status, headers });
}

const request = (fetchImpl: typeof fetch) => ({
  url: 'https://slides.classmoji.test/deck/thumbnail-source?render=1.sig',
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
      url: 'https://slides.classmoji.test/deck/thumbnail-source?render=1.sig',
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      gotoOptions: { waitUntil: 'networkidle0', timeout: 30000 },
      waitForSelector: { selector: '[data-thumbnail-ready]', timeout: 15000 },
      screenshotOptions: { type: 'webp', quality: 80, encoding: 'base64' },
      rejectResourceTypes: ['media', 'websocket'],
      bestAttempt: true,
    });
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

  it('never puts the token in the error it throws', async () => {
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
});
