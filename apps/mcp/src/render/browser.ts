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
 * except the render origin itself. Media and WebSockets are refused outright
 * (nothing on a slide needs them for a still frame). Browser Run's browsers
 * run on Cloudflare's network, not ours, so they cannot reach our private
 * addresses at all; intercepting there would cost a round trip per request.
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

/** A render that could not happen. `code` is safe to show the caller. */
export class RenderError extends Error {
  readonly code: 'RENDER_UNAVAILABLE' | 'RENDER_FAILED' | 'RENDER_BUSY';
  constructor(code: RenderError['code'], message: string) {
    super(redactRenderToken(message));
    this.name = 'RenderError';
    this.code = code;
  }
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

async function guardContext(context: BrowserContext, allowedOrigins: string[]): Promise<void> {
  const allowedHosts = new Set(allowedOrigins.map(origin => new URL(origin).host));
  const verdicts: HostVerdicts = new Map();
  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    const allowed = await allowRequest(
      request.url(),
      request.resourceType(),
      allowedHosts,
      verdicts
    ).catch(() => false);
    if (allowed) await route.continue().catch(() => {});
    else await route.abort('blockedbyclient').catch(() => {});
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

/**
 * Run `work` with a fresh page in its own context on the shared browser. The
 * context (cookies, cache) is closed afterwards whatever happens.
 */
export async function withRenderPage<T>(
  session: PageSession,
  work: (page: Page, backend: RenderBackend) => Promise<T>
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
    });
    await context.addCookies([session.cookie]);
    if (current.backend === 'local') await guardContext(context, [session.origin]);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    return await work(page, current.backend);
  } finally {
    if (context) await context.close().catch(() => {});
    release();
  }
}
