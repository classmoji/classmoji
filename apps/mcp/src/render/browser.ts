/**
 * The render browser: one headless Chromium per MCP process, shared by every
 * `deck_render` / `page_render` call, each call in its own context.
 *
 * ── Backends ───────────────────────────────────────────────────────────────
 *  - Cloudflare Browser Run, over CDP (`connectOverCDP` to the account's
 *    `/browser-run/devtools/browser` WebSocket), whenever CLOUDFLARE_ACCOUNT_ID
 *    and CLOUDFLARE_BROWSER_RENDERING_TOKEN are set — the same credentials the
 *    deck-thumbnail task uses. Production and staging.
 *  - A LOCAL headless Chrome (the installed Chrome channel, else Playwright's
 *    bundled Chromium), only when NODE_ENV is not 'production' and Browser Run
 *    is not configured — a dev stack, where Browser Run could not reach
 *    localhost anyway. Production never launches a browser of its own.
 *
 * ── Lifetime ───────────────────────────────────────────────────────────────
 * Opened lazily on the first render, closed after IDLE_CLOSE_MS without one,
 * reopened on demand (and whenever the connection drops). Browser Run sessions
 * are acquired with a short `keep_alive`, so even a session this process never
 * got to close stops billing within a minute. A local Chrome is Playwright's
 * child: it is killed on SIGINT/SIGTERM/SIGHUP and when this process exits.
 *
 * ── Network guard ──────────────────────────────────────────────────────────
 * A rendered deck loads whatever its HTML names. In the LOCAL backend every
 * request the page makes is intercepted: only http(s), and a host that is (or
 * resolves to) a private, loopback, link-local or otherwise non-public address
 * is refused — the same rule file_import_url applies (`isBlockedAddress`) —
 * except the render origin itself. Requests are made from Node
 * (`route.fetch`, no automatic redirects), so every redirect hop's Location is
 * checked by the same rule before it is followed, and the browser never
 * resolves a third-party host itself. Media is refused outright. Browser Run's
 * browsers run on Cloudflare's network, not ours, so they cannot reach our
 * private addresses at all; intercepting there would cost a round trip per
 * request. In BOTH backends every WebSocket is closed on open and service
 * workers are blocked — nothing on a still frame needs either.
 *
 * ── Deadlines ──────────────────────────────────────────────────────────────
 * The rendered page runs the deck author's own scripts. `page.evaluate` has
 * no timeout of its own, so a script that busy-loops (or patches the timers
 * the driver waits on) would hang a render forever and keep its slot. Every
 * evaluate goes through `within` (a Node-side deadline), and the whole render
 * has one overall deadline; on either, the context is torn down — and if even
 * that hangs, the browser is closed — so the slot is always released.
 */

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';
import { isBrowserRunConfigured, redactRenderToken } from '@classmoji/tasks/browser-run';
import { isBlockedAddress } from '@classmoji/tasks/safe-url';
import type { ViewTokenCookie } from '@classmoji/services/render-contract';

export type RenderBackend = 'browser-run' | 'local';

/** Close the shared browser after this long without a render. */
const IDLE_CLOSE_MS = 60_000;
/** Browser Run session keep-alive (ms): bounds an orphaned session. */
const BROWSER_RUN_KEEP_ALIVE_MS = 60_000;
/** At most this many renders drive the shared browser at once. */
const MAX_CONCURRENT = 2;
/** The longest one render may hold a slot, start to finish. */
export const RENDER_DEADLINE_MS = 60_000;
/** The longest one call into the page may take. */
export const EVALUATE_DEADLINE_MS = 15_000;
/** Closing a context whose renderer is wedged: past this, close the browser. */
const CONTEXT_CLOSE_DEADLINE_MS = 5_000;
/** Redirect hops the guard follows itself before refusing. */
const MAX_REDIRECTS = 5;

/** A render that could not happen. `code` is safe to show the caller. */
export class RenderError extends Error {
  readonly code: 'RENDER_UNAVAILABLE' | 'RENDER_FAILED' | 'RENDER_BUSY';
  constructor(code: RenderError['code'], message: string) {
    super(redactRenderToken(message));
    this.name = 'RenderError';
    this.code = code;
  }
}

/**
 * `promise`, or a RenderError after `ms`. The deadline is Node-side, so it
 * fires even when the page's main thread never yields.
 */
export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RenderError(
            'RENDER_FAILED',
            `${what} did not finish within ${Math.round(ms / 1000)}s.`
          )
        ),
      ms
    );
  });
  // The loser of the race must never surface as an unhandled rejection.
  promise.catch(() => {});
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Which backend this process would use, or null when it has none. */
export function renderBackend(
  env: Record<string, string | undefined> = process.env
): RenderBackend | null {
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_BROWSER_RENDERING_TOKEN) return 'browser-run';
  if (env.NODE_ENV === 'production') return null;
  return 'local';
}

interface Shared {
  browser: Browser;
  backend: RenderBackend;
}

let shared: Shared | null = null;
let opening: Promise<Shared> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let active = 0;
const waiters: Array<() => void> = [];

async function open(): Promise<Shared> {
  const backend = renderBackend();
  if (!backend) {
    throw new RenderError(
      'RENDER_UNAVAILABLE',
      'Rendering is not configured on this server (no Browser Run credentials).'
    );
  }
  const { chromium } = await import('playwright-core');
  let browser: Browser;
  if (backend === 'browser-run' && isBrowserRunConfigured()) {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const endpoint =
      `wss://api.cloudflare.com/client/v4/accounts/${account}/browser-run/devtools/browser` +
      `?keep_alive=${BROWSER_RUN_KEEP_ALIVE_MS}`;
    browser = await chromium.connectOverCDP(endpoint, {
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_BROWSER_RENDERING_TOKEN}` },
      timeout: 30_000,
    });
  } else {
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true });
    } catch {
      // No installed Chrome: Playwright's own Chromium, when it is downloaded.
      browser = await chromium.launch({ headless: true });
    }
  }
  const opened: Shared = { browser, backend };
  browser.on('disconnected', () => {
    if (shared === opened) shared = null;
  });
  return opened;
}

async function acquireBrowser(): Promise<Shared> {
  if (shared?.browser.isConnected()) return shared;
  if (!opening) {
    opening = open()
      .then(result => {
        shared = result;
        return result;
      })
      .finally(() => {
        opening = null;
      });
  }
  return opening;
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (active > 0) return;
    void closeRenderBrowser();
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

/** Close the shared browser now (idle timer, tests, shutdown). */
export async function closeRenderBrowser(): Promise<void> {
  const current = shared;
  shared = null;
  if (!current) return;
  try {
    await current.browser.close();
  } catch {
    // Already gone.
  }
}

async function slot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const at = waiters.indexOf(go);
      if (at !== -1) waiters.splice(at, 1);
      reject(new RenderError('RENDER_BUSY', 'The renderer is busy; retry in a few seconds.'));
    }, 20_000);
    const go = () => {
      clearTimeout(timer);
      active += 1;
      resolve();
    };
    waiters.push(go);
  });
}

function release(): void {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
  scheduleIdleClose();
}

// ─── Network guard (local backend) ────────────────────────────────────────

/** A per-render DNS answer cache, so the guard costs one lookup per host. */
type HostVerdicts = Map<string, Promise<boolean>>;

async function hostIsPublic(hostname: string): Promise<boolean> {
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (isIP(bare)) return !isBlockedAddress(bare);
  try {
    const records = await dns.lookup(bare, { all: true, verbatim: true });
    return records.length > 0 && records.every(r => !isBlockedAddress(r.address));
  } catch {
    return false;
  }
}

/** Decide one request. Exported for tests. */
export async function allowRequest(
  rawUrl: string,
  resourceType: string,
  allowedHosts: ReadonlySet<string>,
  verdicts: HostVerdicts,
  lookup: (host: string) => Promise<boolean> = hostIsPublic
): Promise<boolean> {
  // WebSockets never reach here (context.route does not see them); they are
  // closed by routeWebSocket in withRenderPage. 'websocket' stays for safety.
  if (resourceType === 'media' || resourceType === 'websocket') return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (allowedHosts.has(url.host)) return true;
  let verdict = verdicts.get(url.hostname);
  if (!verdict) {
    verdict = lookup(url.hostname);
    verdicts.set(url.hostname, verdict);
  }
  return verdict;
}

/**
 * Every request the page makes, decided here (local backend). The render
 * origin's own requests continue as they are; anything else is fetched from
 * Node with redirects OFF, each hop's Location checked by `allowRequest`
 * before it is followed, and the final response handed back to the page.
 */
async function guardContext(context: BrowserContext, allowedOrigins: string[]): Promise<void> {
  const allowedHosts = new Set(allowedOrigins.map(origin => new URL(origin).host));
  const verdicts: HostVerdicts = new Map();
  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    const type = request.resourceType();
    try {
      let url = request.url();
      if (!(await allowRequest(url, type, allowedHosts, verdicts))) {
        await route.abort('blockedbyclient');
        return;
      }
      if (allowedHosts.has(new URL(url).host)) {
        await route.continue();
        return;
      }
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const response = await route.fetch({ url, maxRedirects: 0, timeout: 15_000 });
        const status = response.status();
        const location = response.headers()['location'];
        if (status < 300 || status >= 400 || !location) {
          await route.fulfill({ response });
          return;
        }
        const next = new URL(location, url).toString();
        if (!(await allowRequest(next, type, allowedHosts, verdicts))) break;
        url = next;
      }
      await route.abort('blockedbyclient');
    } catch {
      await route.abort('failed').catch(() => {});
    }
  });
}

// ─── One render ──────────────────────────────────────────────────────────

export interface PageSession {
  /** CSS viewport. */
  width: number;
  height: number;
  /** The view-token cookie (host-scoped to the render origin). */
  cookie: ViewTokenCookie;
  /** The render origin; the only private host the guard lets through. */
  origin: string;
}

/** Close a context; if its renderer is wedged and that hangs, close the browser. */
async function disposeContext(context: BrowserContext): Promise<void> {
  try {
    await within(context.close(), CONTEXT_CLOSE_DEADLINE_MS, 'Closing the render page');
  } catch {
    await closeRenderBrowser();
  }
}

/**
 * Run `work` with a fresh page in its own context on the shared browser,
 * within `deadlineMs` overall. The context (cookies, cache) is closed
 * afterwards whatever happens, and the slot is released.
 */
export async function withRenderPage<T>(
  session: PageSession,
  work: (page: Page, backend: RenderBackend) => Promise<T>,
  deadlineMs: number = RENDER_DEADLINE_MS
): Promise<T> {
  await slot();
  let context: BrowserContext | null = null;
  try {
    let current: Shared;
    try {
      current = await acquireBrowser();
    } catch (error) {
      if (error instanceof RenderError) throw error;
      throw new RenderError(
        'RENDER_UNAVAILABLE',
        `Could not start the render browser: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    context = await current.browser.newContext({
      viewport: { width: session.width, height: session.height },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      reducedMotion: 'reduce',
      javaScriptEnabled: true,
      serviceWorkers: 'block',
    });
    await context.addCookies([session.cookie]);
    // No socket of any kind: a still frame needs none, and deck scripts could
    // otherwise reach local services (collab, ai-agent) from a dev browser.
    await context.routeWebSocket(/.*/, ws => ws.close());
    if (current.backend === 'local') await guardContext(context, [session.origin]);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    return await within(work(page, current.backend), deadlineMs, 'The render');
  } finally {
    if (context) await disposeContext(context);
    release();
  }
}
