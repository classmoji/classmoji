import { hasMediaPlaceholderShape, hasMediaScheme, hasMediaUrlShape } from '~/utils/mediaRefs.ts';

/**
 * What the embed block and the video block's iframe branch may put in a frame,
 * decided in one place for both, in the editor and in the reader alike.
 *
 * Pure and JSX-free on purpose: the unit suite imports it directly (the
 * Playwright test transform rewrites JSX in app files), and `frameElement.ts` is
 * the only thing that turns a decision into elements.
 *
 * The rules:
 *  - only `https:` is framed (a protocol-relative `//host/path` counts as
 *    https). `http:` would be blocked as mixed content (an empty box where the
 *    author expected content), and every other scheme (`javascript:`, `data:`,
 *    a malformed string) is refused outright; each becomes a link instead
 *    (`FrameDecision.link`);
 *  - a URL on the page's own origin is never framed (a link instead): a
 *    same-origin frame with `allow-scripts allow-same-origin` is the app;
 *  - media of our own (a `media:` reference, a signed media URL, the
 *    placeholder for one that could not be signed) is never framed: it plays
 *    in a `<video>` or not at all. Judged by path shape, because the browser is
 *    never told the delivery origin (`hasMediaUrlShape`); a signed REPO file (a
 *    PDF in the content repository) is not media and still frames;
 *  - the frame may run scripts, submit forms, open pop-ups and dialogs and
 *    download, and can never navigate the whole tab (`FRAME_SANDBOX`). A PDF is
 *    the one exception: it is framed without a sandbox (`FrameDecision.frame`).
 */

/**
 * The sandbox every embedded frame gets (a PDF excepted, see `decideFrame`).
 *
 * No `allow-top-navigation` of any kind: with it, anything an instructor
 * pasted, or whatever later appears at that URL, could send the reader's
 * whole tab somewhere else. Forms, pop-ups (outside the sandbox, so a page
 * opened from an embed works normally), dialogs and downloads are allowed: a
 * Google Form embed has to submit, and "open in a new tab" links have to open.
 */
export const FRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-presentation allow-forms allow-popups ' +
  'allow-popups-to-escape-sandbox allow-modals allow-downloads';

/** The feature list the app's embeds have always had (players need autoplay, copy buttons the clipboard). */
export const FRAME_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';

/**
 * The frame learns the page's origin, never its path. Not `no-referrer`:
 * YouTube refuses to play an embed that sends no referrer at all.
 */
export const FRAME_REFERRER_POLICY = 'strict-origin-when-cross-origin';

export type FrameDecision =
  /**
   * `sandboxed` is false for a PDF only: Chrome's PDF viewer refuses to run in
   * a sandboxed frame (any sandbox value), so a sandboxed PDF is a blank box.
   */
  | { kind: 'frame'; src: string; sandboxed: boolean }
  /** Shown as text; `href` only when it is an http(s) URL, never a script. */
  | { kind: 'link'; text: string; href: string | null }
  /** Nothing a reader can be shown (media that cannot play in a frame). */
  | { kind: 'none' };

const NONE: FrameDecision = { kind: 'none' };

/** Parses as an absolute URL with exactly this protocol. */
function hasProtocol(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function isHttpsUrl(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && hasProtocol(value, ['https:']);
}

/**
 * The `href` a fallback link may carry: an absolute http(s) URL, or null.
 * `javascript:`, `data:` and anything malformed are shown as text only.
 */
export function safeLinkHref(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && hasProtocol(value, ['http:', 'https:'])
    ? value
    : null;
}

/** `//host/path` is read as `https://host/path`; anything else is unchanged. */
export function withDefaultScheme(value: string): string {
  return value.startsWith('//') ? `https:${value}` : value;
}

/** The page's own origin, or null outside a browser. */
export function currentPageOrigin(): string | null {
  return typeof window === 'undefined' ? null : window.location.origin;
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YOUTUBE_NOCOOKIE_HOSTS = new Set(['youtube-nocookie.com', 'www.youtube-nocookie.com']);
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com']);
const VIDEO_ID = /^[\w-]+$/;

/** `90`, `90s`, `1m30s`, `1h2m3s` → seconds; anything else → null. */
function parseSeconds(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(withDefaultScheme(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function youtubeEmbed(url: URL, nocookie: boolean): string | null {
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  let id: string | null = null;
  let params = new URLSearchParams();

  if (host === 'youtu.be') {
    id = segments[0] ?? null;
  } else if (segments[0] === 'watch') {
    id = url.searchParams.get('v');
  } else if (['embed', 'shorts', 'live'].includes(segments[0] ?? '')) {
    id = segments[1] ?? null;
    // Already a player URL: its own options (`rel`, `autoplay`, ...) stay.
    if (segments[0] === 'embed') params = new URLSearchParams(url.searchParams);
  }
  if (!id || !VIDEO_ID.test(id)) return null;

  const start = parseSeconds(url.searchParams.get('start') ?? url.searchParams.get('t'));
  params.delete('t');
  params.delete('start');
  if (start !== null) params.set('start', String(start));
  const list = url.searchParams.get('list');
  if (list) params.set('list', list);

  const query = params.toString();
  const origin = nocookie ? 'https://www.youtube-nocookie.com' : 'https://www.youtube.com';
  return `${origin}/embed/${id}${query ? `?${query}` : ''}`;
}

function vimeoEmbed(url: URL): string | null {
  const [id, hash] = url.pathname.split('/').filter(Boolean);
  if (!id || !/^\d+$/.test(id)) return null;
  const h = hash && /^[0-9a-f]+$/i.test(hash) ? `?h=${hash}` : '';
  return `https://player.vimeo.com/video/${id}${h}`;
}

/**
 * YouTube and Vimeo page URLs to their player URLs; anything else comes back
 * unchanged. Decided on the parsed HOST, never on a substring, so a URL that
 * merely mentions `youtube.com` in its query is left alone.
 *
 * YouTube: `/watch?v=`, `/embed/`, `/shorts/`, `/live/` and `youtu.be/`, with
 * `t=`/`start=` (seconds, or `1m30s`) as `start=` and `list=` kept; a
 * `youtube-nocookie.com` URL stays on that host. Vimeo: `vimeo.com/<id>` and
 * `vimeo.com/<id>/<hash>` (an unlisted video) to `player.vimeo.com`; a
 * `player.vimeo.com` URL is already a player URL and is left as it is.
 */
export function toEmbedUrl(value: string): string {
  if (!value) return '';
  const url = parseHttpUrl(value);
  if (!url) return value;
  const host = url.hostname.toLowerCase();
  let embed: string | null = null;
  if (YOUTUBE_HOSTS.has(host) || host === 'youtu.be') embed = youtubeEmbed(url, false);
  else if (YOUTUBE_NOCOOKIE_HOSTS.has(host)) embed = youtubeEmbed(url, true);
  else if (VIMEO_HOSTS.has(host)) embed = vimeoEmbed(url);
  return embed ?? value;
}

/** A repository reference (no scheme, not `//host`), as an author stores one. */
function isRepoRelative(value: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//');
}

/**
 * A PDF: the URL's path ends `.pdf`, or what the author stored is a repo
 * reference ending `.pdf` (its signed URL need not say so).
 */
function isPdf(frameUrl: URL, storedUrl: string): boolean {
  if (/\.pdf$/i.test(frameUrl.pathname)) return true;
  return isRepoRelative(storedUrl) && /\.pdf$/i.test(storedUrl.split(/[?#]/)[0]);
}

/**
 * What to show for a frame-shaped block.
 *
 * `storedUrl` is what the author stored (decides the provider conversion and
 * is the fallback link's text); `resolvedUrl` is the display URL the block
 * resolved it to (`useResolvedFileUrl`), which is what a repo reference frames
 * from. A recognised provider is converted from the stored URL and never
 * resolved: it is external by construction. `pageOrigin` is the page's own
 * origin (`currentPageOrigin()`), never framed.
 */
export function decideFrame(
  storedUrl: string,
  resolvedUrl: string,
  pageOrigin: string | null = null
): FrameDecision {
  if (!storedUrl) return NONE;
  const stored = withDefaultScheme(storedUrl);
  const converted = toEmbedUrl(stored);
  const candidate = converted !== stored ? converted : withDefaultScheme(resolvedUrl || storedUrl);

  if (
    hasMediaScheme(storedUrl) ||
    hasMediaScheme(candidate) ||
    hasMediaPlaceholderShape(candidate) ||
    hasMediaUrlShape(candidate)
  ) {
    return NONE;
  }
  if (!isHttpsUrl(candidate)) {
    return { kind: 'link', text: storedUrl, href: safeLinkHref(candidate) };
  }
  const url = new URL(candidate);
  if (pageOrigin && url.origin === pageOrigin) {
    return { kind: 'link', text: storedUrl, href: candidate };
  }
  // Chrome's PDF viewer is blocked by ANY sandbox, so a sandboxed PDF is a
  // blank box. PDFs alone keep today's unsandboxed frame; everything else
  // gets FRAME_SANDBOX.
  return { kind: 'frame', src: candidate, sandboxed: !isPdf(url, storedUrl) };
}
