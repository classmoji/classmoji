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
 *
 * ── Redaction ──────────────────────────────────────────────────────────────
 * The render token authorises reading one deck. Cloudflare's own error strings
 * routinely echo back the request they were given, so every message that leaves
 * here goes through `redactRenderToken` first. It is applied at the BOUNDARY
 * rather than at each log site, because a log site that forgets is exactly how
 * a credential reaches a log aggregator.
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

/**
 * Below this, the "image" is a blank or an error page, not a slide.
 *
 * A 1280×720 WebP of a real slide is ~40-70 KB; the smallest plausible one — a
 * single flat background colour — is still several KB. Two kilobytes is well
 * under anything a rendered deck produces and well over what a solid-colour
 * frame compresses to, so it separates "nothing rendered" from "a minimal deck"
 * without needing to decode the image.
 */
export const MIN_IMAGE_BYTES = 2 * 1024;

/**
 * Above this, something has gone wrong in a way we do not want in a git repo.
 *
 * WebP q80 at this size does not reach 600 KB from slide content. A file that
 * does is a viewport that was not honoured, a full-page capture, or a format
 * that is not what we asked for — and every commit here is a whole new object
 * in the classroom's repo history, because compressed formats do not delta.
 */
export const MAX_IMAGE_BYTES = 600 * 1024;

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
  /**
   * Extra request headers the headless browser sends — how the render token
   * travels. Puppeteer's `setExtraHTTPHeaders` applies them to every request the
   * PAGE makes, subresources included; that is acceptable only because the token
   * is bound to the render host and is worthless anywhere else.
   */
  headers?: Record<string, string>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Scrub a render token out of anything about to be logged or returned.
 *
 * Two shapes, because the token has had two homes: the `?render=` query string
 * it used to travel in (still worth stripping — an old URL can turn up in a
 * cached error string), and the `X-Render-Token` header it travels in now.
 * Cloudflare quotes the request back in several of its error messages, so this
 * runs on every message that leaves this module and on the task's own logging.
 */
export function redactRenderToken(text: string): string {
  return text
    .replace(/render=[^&\s"'\\]*/gi, 'render=[redacted]')
    .replace(/(x-render-token["']?\s*[:=]\s*["']?)[^\s"',}\]&]+/gi, '$1[redacted]');
}

export function isBrowserRunConfigured(): boolean {
  return Boolean(
    process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_BROWSER_RENDERING_TOKEN
  );
}

/**
 * `Retry-After`, in seconds from now.
 *
 * RFC 9110 allows either a delta in seconds or an HTTP-date, and Cloudflare has
 * sent both. A date in the past reads as zero rather than as a negative wait,
 * and anything unparseable reads as absent — the caller then falls back to its
 * own retry backoff, which is the safe direction.
 */
function retryAfterFrom(response: {
  headers: { get(name: string): string | null };
}): number | null {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds : null;

  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** The API's own message, or a bare status line. Never the token. */
async function describeFailure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      errors?: Array<{ message?: string }>;
      message?: string;
    };
    const first = body?.errors?.[0]?.message ?? body?.message;
    if (first) return redactRenderToken(first);
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
 * request that no longer verifies.
 *
 * NO `bestAttempt`. It used to be set, on the reasoning that a decorative image
 * is better slightly incomplete than missing — but it also means a
 * `waitForSelector` TIMEOUT still returns a picture, and the page that times out
 * is precisely the one that did not render: a 403 body, a Cloudflare error page,
 * a blank frame. Screenshotting one of those commits it into a classroom's
 * content repo as that deck's card, where nothing would ever notice. A timeout
 * has to be a failed render, and a failed render keeps the thumbnail already
 * there.
 *
 * The size window below is the second half of the same guard: `waitForSelector`
 * proves the page raised our attribute, and the byte count proves what came back
 * is plausibly a picture of a slide.
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
        ...(request.headers ? { setExtraHTTPHeaders: request.headers } : {}),
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
    return withinSizeWindow(image);
  }

  if (contentType.startsWith('image/')) {
    // `encoding: 'base64'` was asked for, so this is the endpoint disagreeing
    // with us rather than an error — take the bytes and encode them ourselves.
    return withinSizeWindow(Buffer.from(await response.arrayBuffer()).toString('base64'));
  }

  const text = (await response.text()).trim();
  if (!text || !BASE64_PATTERN.test(text)) {
    throw new BrowserRunError('Browser Run returned a body that is not an image', {
      status: 200,
      retryable: false,
    });
  }
  return withinSizeWindow(text.replace(/\s+/g, ''));
}

/**
 * The last thing between a 200 and a commit into somebody's content repo.
 *
 * A render that goes wrong does not usually fail — it succeeds at photographing
 * the wrong thing. An error page, a 403 body, a blank viewport: all of them are
 * valid WebPs and all of them are a few hundred bytes. This is the cheapest
 * check that tells those apart from a slide without decoding the image, and a
 * rejection here is a FAILED render, which means the deck keeps whatever
 * thumbnail it already had and nothing is written.
 *
 * Not retryable: the same page will produce the same bytes on the next attempt.
 */
function withinSizeWindow(base64: string): string {
  const bytes = Buffer.from(base64, 'base64').length;
  if (bytes < MIN_IMAGE_BYTES) {
    throw new BrowserRunError(
      `Browser Run returned ${bytes} bytes, under the ${MIN_IMAGE_BYTES}-byte floor — a blank or error page, not a slide`,
      { status: 200, retryable: false }
    );
  }
  if (bytes > MAX_IMAGE_BYTES) {
    throw new BrowserRunError(
      `Browser Run returned ${bytes} bytes, over the ${MAX_IMAGE_BYTES}-byte ceiling — not committing it`,
      { status: 200, retryable: false }
    );
  }
  return base64;
}
