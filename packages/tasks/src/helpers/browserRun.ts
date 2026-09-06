/**
 * browserRun.ts — the one call we make to Cloudflare Browser Run.
 *
 * Browser Run (renamed from Browser Rendering on 2026-04-15) exposes a REST
 * `/screenshot` quick action: hand it a URL and a viewport, get back an image.
 * We use it for exactly one thing — a deck's first slide at 1280×720 — so this
 * is a single function rather than a client, and every knob it does not need is
 * absent rather than defaulted.
 *
 * ── Credentials ────────────────────────────────────────────────────────────
 * `CLOUDFLARE_BROWSER_RENDERING_TOKEN` is an API token scoped to **Browser
 * Rendering – Edit** and nothing else, and `CLOUDFLARE_ACCOUNT_ID` names the
 * account it belongs to. Neither is ever logged, and neither appears in a
 * thrown error: `BrowserRunError` carries the status and the API's own message,
 * both of which are safe, and the request URL is reconstructed from the account
 * id rather than echoed.
 *
 * ── Response shapes ────────────────────────────────────────────────────────
 * With `screenshotOptions.encoding = 'base64'` a 200 comes back as `text/plain`
 * holding a bare base64 string. The default (`binary`) answers `image/webp`
 * bytes, and the JSON envelope `{ success, result }` is what the multi-format
 * endpoints use. All three are accepted here — the endpoint is versionless and
 * the cost of tolerating the other two is four lines, whereas the cost of
 * getting it wrong is a silently corrupt image committed into a content repo.
 *
 * ── Failures ───────────────────────────────────────────────────────────────
 * `retryable` is the whole contract this hands its caller. 429 (rate limited,
 * with `Retry-After` in seconds) and 5xx are worth another attempt; 400 and 422
 * — a malformed request, or a page that would not load — are not, and the
 * thumbnail task answers those by keeping the thumbnail it already has.
 */

/** A Browser Run call that did not produce an image. */
export class BrowserRunError extends Error {
  readonly status: number;
  /** Worth another attempt: rate limiting and server-side faults. */
  readonly retryable: boolean;
  /** Seconds from a 429's `Retry-After`, when it sent one. */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    {
      status,
      retryable,
      retryAfterSeconds = null,
    }: { status: number; retryable: boolean; retryAfterSeconds?: number | null }
  ) {
    super(message);
    this.name = 'BrowserRunError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ScreenshotRequest {
  url: string;
  width: number;
  height: number;
  /** CSS selector the page raises once it has painted. */
  readySelector: string;
  /** WebP quality, 1-100. */
  quality: number;
  /** Whole-navigation budget in ms (Browser Run caps `gotoOptions.timeout` at 60000). */
  navigationTimeoutMs?: number;
  /** How long to wait for `readySelector` after navigation, in ms. */
  readyTimeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function isBrowserRunConfigured(): boolean {
  return Boolean(
    process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_BROWSER_RENDERING_TOKEN
  );
}

function retryAfterFrom(response: {
  headers: { get(name: string): string | null };
}): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** The API's own message, or a bare status line. Never the request or the token. */
async function describeFailure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      errors?: Array<{ message?: string }>;
      message?: string;
    };
    const first = body?.errors?.[0]?.message ?? body?.message;
    if (first) return first;
  } catch {
    // Not JSON, or an empty body. The status alone is the message then.
  }
  return `HTTP ${response.status}`;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/\r\n]+={0,2}$/;

/**
 * Screenshot one page, returning the image as base64 (what a git blob wants).
 *
 * `cacheTTL=0`: the default is five seconds, and every request here carries a
 * freshly minted render token anyway, so a cache entry could only ever serve a
 * URL that no longer verifies.
 *
 * `bestAttempt: true` lets a page whose `networkidle0` never quite settles —
 * one slow font, one image on a CDN having a moment — still produce a picture,
 * which is the right trade for a decorative image. `waitForSelector` is what
 * keeps that from degenerating into screenshotting a blank or error page: the
 * selector only appears on a page that rendered.
 */
export async function screenshotToBase64(request: ScreenshotRequest): Promise<string> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_BROWSER_RENDERING_TOKEN;
  if (!accountId || !token) {
    throw new BrowserRunError('Browser Run is not configured', {
      status: 0,
      retryable: false,
    });
  }

  const doFetch = request.fetchImpl ?? fetch;
  const response = await doFetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/screenshot?cacheTTL=0`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: request.url,
        viewport: { width: request.width, height: request.height, deviceScaleFactor: 1 },
        gotoOptions: {
          waitUntil: 'networkidle0',
          timeout: request.navigationTimeoutMs ?? 30000,
        },
        waitForSelector: {
          selector: request.readySelector,
          timeout: request.readyTimeoutMs ?? 15000,
        },
        screenshotOptions: { type: 'webp', quality: request.quality, encoding: 'base64' },
        // Nothing on a slide is a video or a socket, and both are ways for
        // `networkidle0` to never arrive.
        rejectResourceTypes: ['media', 'websocket'],
        bestAttempt: true,
      }),
    }
  );

  if (!response.ok) {
    const status = response.status;
    throw new BrowserRunError(await describeFailure(response), {
      status,
      retryable: status === 429 || status >= 500,
      retryAfterSeconds: status === 429 ? retryAfterFrom(response) : null,
    });
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const body = (await response.json()) as {
      success?: boolean;
      result?: string | { screenshot?: string };
      errors?: Array<{ message?: string }>;
    };
    if (body?.success === false) {
      throw new BrowserRunError(body?.errors?.[0]?.message ?? 'Browser Run refused the render', {
        status: 200,
        retryable: false,
      });
    }
    const image =
      typeof body?.result === 'string' ? body.result : (body?.result?.screenshot ?? null);
    if (!image) {
      throw new BrowserRunError('Browser Run returned no image', { status: 200, retryable: false });
    }
    return image;
  }

  if (contentType.startsWith('image/')) {
    // `encoding: 'base64'` was asked for, so this is the endpoint disagreeing
    // with us rather than an error — take the bytes and encode them ourselves.
    return Buffer.from(await response.arrayBuffer()).toString('base64');
  }

  const text = (await response.text()).trim();
  if (!text || !BASE64_PATTERN.test(text)) {
    throw new BrowserRunError('Browser Run returned a body that is not an image', {
      status: 200,
      retryable: false,
    });
  }
  return text.replace(/\s+/g, '');
}
