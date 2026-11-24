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
 *  - a URL on one of our own hosts is never framed (a link instead): the
 *    page's own origin, the web app, the pages app, the content delivery
 *    origin and every class site (`FrameHosts`). The one exception is a file
 *    of the class's own, below. The slides app and the sites' base domain
 *    itself (the marketing and docs site) are framed like any other site: a
 *    deck embedded in a page is a real use;
 *  - media of our own (a `media:` reference, a signed media URL, the
 *    placeholder for one that could not be signed) is never framed: it plays
 *    in a `<video>` or not at all. Judged by path shape, because refusing
 *    needs no origin (`hasMediaUrlShape`);
 *  - a PDF is framed WITHOUT a sandbox only when it is a file of the class's
 *    own: the stored reference has an entry in the display map the server
 *    sent (it resolved it from the class's content repository) and that entry
 *    is on the delivery host the server named. Every other `.pdf` URL is a
 *    card that opens it in a new tab (`FrameDecision.file`), never a frame;
 *  - the frame may run scripts, submit forms, open pop-ups and dialogs and
 *    download, and can never navigate the whole tab (`FRAME_SANDBOX`).
 */

/**
 * Our own hosts, as the server knows them for this deployment
 * (`utils/frameHosts.server.ts`), handed to the blocks through the reader
 * payload and the editor's loader data. Hostnames only, lower case.
 */
export interface FrameHosts {
  /** Exact hostnames never framed: the web app, the pages app, the delivery origin. */
  hosts: string[];
  /**
   * The class sites' base domain: every STRICT subdomain of it is a class
   * site (or another host of ours) and is never framed, except the hosts in
   * `framed`. The base domain itself is not refused by this rule.
   */
  siteDomain: string | null;
  /** Our hosts that ARE framed (sandboxed) even under `siteDomain`: the slides app. */
  framed: string[];
  /**
   * The content delivery origin's hostname: the only host a file of the
   * class's own is framed from. Null where nothing is delivered.
   */
  delivery: string | null;
}

/** What a block knows beyond the URLs: our hosts, and whether the server resolved the reference. */
export interface FrameContext {
  /** Our hosts (null: none known here, so only the page's own origin is refused). */
  hosts?: FrameHosts | null;
  /**
   * The stored reference has a non-identity entry in the display map the
   * server sent (`useAssetDisplayUrl`): the server resolved it to a file of
   * the class's own. Never decided from the shape of the URL.
   */
  serverResolved?: boolean;
}

/**
 * The sandbox every embedded frame gets (a PDF of the class's own excepted,
 * see `decideFrame`).
 *
 * No `allow-top-navigation` of any kind: with it, anything an instructor
 * pasted, or whatever later appears at that URL, could send the reader's
 * whole tab somewhere else. Forms, pop-ups (outside the sandbox, so a page
 * opened from an embed works normally), dialogs and downloads are allowed: a
 * Google Form embed has to submit, "open in a new tab" links have to open,
 * and the `alert`/`prompt`/`confirm` in an embedded code demo has to work.
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
   * `sandboxed` is false only for a PDF of the class's own: Chrome's PDF
   * viewer refuses to run in a sandboxed frame (any sandbox value), so a
   * sandboxed PDF is a blank box.
   */
  | { kind: 'frame'; src: string; sandboxed: boolean }
  /** Shown as text; `href` only when it is an http(s) URL, never a script. */
  | { kind: 'link'; text: string; href: string | null }
  /** A PDF that is not the class's own: a card naming the file and its host, opening it in a new tab. */
  | { kind: 'file'; href: string; name: string; host: string }
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

/** The path of what the author stored: a URL's path, else the reference up to any query. */
function storedPath(storedUrl: string): string {
  try {
    return new URL(withDefaultScheme(storedUrl)).pathname;
  } catch {
    return storedUrl.split(/[?#]/)[0];
  }
}

const PDF_PATH = /\.pdf$/i;

/** The resolver's placeholder for a repository file it has no record of. */
const MISSING_DELIVERY_PATH = /^\/c\/[0-9a-f-]{36}\/missing\//i;

/** A hostname as compared here: lower case, no trailing dot. */
function normalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

/**
 * Is this hostname one of ours that is never framed: one of `FrameHosts.hosts`,
 * or a strict subdomain of `FrameHosts.siteDomain` (a class site) that is not
 * one of `FrameHosts.framed`?
 */
export function isOwnFrameHost(hostname: string, hosts: FrameHosts | null | undefined): boolean {
  if (!hosts) return false;
  const host = normalHost(hostname);
  if (!host) return false;
  if (hosts.hosts.some(own => normalHost(own) === host)) return true;
  if (hosts.framed.some(own => normalHost(own) === host)) return false;
  const site = hosts.siteDomain ? normalHost(hosts.siteDomain) : '';
  return site !== '' && host.endsWith(`.${site}`);
}

/**
 * Characters a file name on a card never carries: controls, zero-width and
 * format characters, and bidirectional controls (U+200B-U+200F,
 * U+2028-U+202F, U+2060-U+2069, U+061C, U+FEFF).
 */
const UNSAFE_NAME_CHARS =
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point: they are removed.
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202f\u2060-\u2069\ufeff]/g;

/** The most of a file name a card shows. */
const FILE_NAME_MAX = 120;

/**
 * The file name a card shows: the URL path's last segment, percent-decoded
 * when it decodes (left as it is when it does not), and again only the part
 * after the last `/` or `\` (a decoded slash adds no path to the name), with
 * control, zero-width, format and bidirectional characters removed, and cut
 * to `FILE_NAME_MAX`. Text only: the card renders it as a string.
 */
export function fileNameFromUrl(url: URL): string {
  const segment = url.pathname.split('/').filter(Boolean).pop() ?? '';
  let name = segment;
  try {
    name = decodeURIComponent(segment);
  } catch {
    // Not valid percent-encoding: shown as it is.
  }
  name = name.replace(UNSAFE_NAME_CHARS, '');
  name = (
    name
      .split(/[\\/]/)
      .filter(part => part.trim() !== '')
      .pop() ?? ''
  ).trim();
  if (name.length > FILE_NAME_MAX) name = `${name.slice(0, FILE_NAME_MAX - 1)}…`;
  return name || 'Document.pdf';
}

/**
 * What to show for a frame-shaped block.
 *
 * `storedUrl` is what the author stored (decides the provider conversion and
 * is the fallback link's text); `resolvedUrl` is the display URL the block
 * resolved it to (`useResolvedFileUrl`), which is what a repo reference frames
 * from. A recognised provider is converted from the stored URL and never
 * resolved: it is external by construction. `pageOrigin` is the page's own
 * origin (`currentPageOrigin()`), never framed. `context` carries our hosts
 * and whether the server resolved the stored reference (`FrameContext`).
 */
export function decideFrame(
  storedUrl: string,
  resolvedUrl: string,
  pageOrigin: string | null = null,
  context: FrameContext = {}
): FrameDecision {
  if (!storedUrl) return NONE;
  const stored = withDefaultScheme(storedUrl);
  const converted = toEmbedUrl(stored);
  const provider = converted !== stored;
  const candidate = provider ? converted : withDefaultScheme(resolvedUrl || storedUrl);

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

  // A file of the class's own: the server resolved the stored reference, and
  // what it resolved to is on the delivery host it named. Decided from the
  // display map and the server's host, never from the URL's shape.
  const delivery = context.hosts?.delivery ? normalHost(context.hosts.delivery) : null;
  const ownFile =
    !provider &&
    context.serverResolved === true &&
    delivery !== null &&
    normalHost(url.hostname) === delivery;
  if (ownFile) {
    // A placeholder for a file the class does not have is not a file.
    if (MISSING_DELIVERY_PATH.test(url.pathname)) return NONE;
    // Chrome's PDF viewer is blocked by ANY sandbox, so a sandboxed PDF is a
    // blank box: the class's own PDF alone is framed without one.
    const pdf = PDF_PATH.test(url.pathname) || PDF_PATH.test(storedPath(storedUrl));
    return { kind: 'frame', src: candidate, sandboxed: !pdf };
  }

  if (isOwnFrameHost(url.hostname, context.hosts)) {
    return { kind: 'link', text: storedUrl, href: candidate };
  }
  if (PDF_PATH.test(url.pathname)) {
    return { kind: 'file', href: candidate, name: fileNameFromUrl(url), host: url.host };
  }
  return { kind: 'frame', src: candidate, sandboxed: true };
}
