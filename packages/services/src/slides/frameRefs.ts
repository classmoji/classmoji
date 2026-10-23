/**
 * frameRefs.ts — where a slide frame's source points, as a pure string rule.
 *
 * A frame in a deck (an iframe's `src`/`data-src`, an html block's
 * `data-cm-src`, a section's `data-background-iframe`) names one of three
 * things, and every surface has to agree on which:
 *
 *   - **ours**: a file in this classroom's content repo. Loaded from the
 *     content service under a signed folder grant, in a sandboxed origin.
 *   - **external**: a page somewhere else (`https://www.youtube.com/...`).
 *     Left exactly as the author wrote it.
 *   - **inert**: something no frame in a deck should load — a script or data
 *     URL, one of the app's own pages, another classroom's content, a path
 *     outside the repo. Shown as an empty frame.
 *
 * Also the editor's display form: the editor never holds a signed URL. It
 * shows our frames through `/<slideId>/frame/<repoPath>` (a redirect to a fresh
 * signature) and turns that back into the stored deck-relative reference
 * before anything is saved. The repo path is in the URL, so an editor URL of
 * ANY deck (one pasted from another deck, or another classroom) names that
 * path in the current deck's repo, written relative to the current deck.
 *
 * ZERO imports, so the browser (editor) and the server (read surfaces, save
 * backstop, frame route) apply the same rule.
 */

/** Base the relative-URL arithmetic runs against. Never fetched. */
const BASE_ORIGIN = 'https://frame-ref.invalid';
/** A sentinel first segment: a `..` that climbs past it left the repo. */
const ROOT_SEGMENT = '__repo_root__';

/** The editor route segment: `/<slideId>/frame/<repoPath>`. */
export const EDITOR_FRAME_SEGMENT = 'frame';
/** The query param the editor adds so a changed html block file reloads. Never signed, never stored. */
export const EDITOR_FRAME_REV_PARAM = 'cm-rev';

/** A deck's or a page's stored document. Never served to a frame. */
const REPO_DOCUMENT_RE =
  /^(?:slides\/[^/]+\/(?:index\.html|deck\.json)|pages\/[^/]+\/(?:content\.json|index\.html))$/i;

/** A deck's or a page's stored document (`slides/x/deck.json`, `pages/y/content.json`, …). */
export function isRepoDocumentPath(repoPath: string): boolean {
  return REPO_DOCUMENT_RE.test(repoPath);
}

/** A repo path and what followed it (`?query#hash`, verbatim, '' for none). */
export interface RepoFrameTarget {
  repoPath: string;
  query: string;
}

export type FrameRef =
  | { kind: 'ours'; repoPath: string; query: string }
  | { kind: 'external' }
  | { kind: 'inert' };

export interface FrameRefOptions {
  /** The deck folder (`slides/<seg>`): relative references resolve against it. */
  deckFolder: string;
  /** This classroom's own repo URL shapes (`/content/{org}/{repo}/…`, raw, Pages) → the repo path, else null. */
  ownRepoPath: (value: string) => string | null;
  /**
   * The app's own hosts, which a deck frame never loads: exact hosts
   * (`slides.classmoji.io`, `localhost:6500`) or `.domain` for every host
   * under it (the session cookie's domain). The content origin is never one
   * of them, whatever the suffix says.
   */
  ourHosts: readonly string[];
  /** The content delivery origin (`https://content.classmoji.io`). */
  contentOrigin?: string | null;
  /**
   * @deprecated Ignored: an editor frame URL of any deck is ours (its repo
   * path is read in this classroom's repo).
   */
  slideId?: string | null;
  /** A files URL of THIS classroom on the content origin → its target; null otherwise. */
  filesRef?: (url: string) => RepoFrameTarget | null;
}

const OURS = (target: RepoFrameTarget): FrameRef => ({ kind: 'ours', ...target });
const EXTERNAL: FrameRef = { kind: 'external' };
const INERT: FrameRef = { kind: 'inert' };

/** `a b/c` → `a%20b/c`: each segment encoded, the separators kept. */
export function encodeRepoPath(repoPath: string): string {
  return repoPath.split('/').map(encodeURIComponent).join('/');
}

/**
 * A decoded repo path in its one spelling: no leading/trailing slash, no
 * empty, `.` or `..` segment, no backslash or control character. Null when it
 * cannot be one (or is the repo root).
 */
export function normalizeFrameRepoPath(path: string): string | null {
  const segments = path.split('/');
  while (segments.length > 0 && segments[0] === '') segments.shift();
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    if (segment.includes('\\')) return null;
    for (const char of segment) {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return null;
    }
  }
  return segments.join('/');
}

/** A folder reference (`games/snake/`) names its index page, as a static host would serve it. */
function withIndexPage(path: string): string {
  return path.endsWith('/') ? `${path}index.html` : path;
}

/** A decoded repo path from one of the repo's URL shapes → its one spelling, or null. */
function ownTargetPath(path: string): string | null {
  return normalizeFrameRepoPath(withIndexPage(path));
}

/** A URL pathname (percent-encoded) → the decoded repo path, or null. */
function decodePathname(pathname: string): string | null {
  const path = withIndexPage(pathname);
  const decoded: string[] = [];
  for (const segment of path.split('/')) {
    try {
      decoded.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  // A decoded `/` inside a segment would change which folder is meant.
  if (decoded.some(segment => segment.includes('/'))) return null;
  return normalizeFrameRepoPath(decoded.join('/'));
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

/**
 * A reference relative to the deck folder → the repo path it names, with its
 * query and hash, by URL semantics (`games/a/index.html`,
 * `../../games/sketchkit/draw.html?deck=x`). Null when it is not relative, or
 * resolves to the repo root or outside the repo.
 */
export function resolveDeckRelative(ref: string, deckFolder: string): RepoFrameTarget | null {
  const folder = trimSlashes(deckFolder);
  const value = ref.trim();
  if (!folder || !value) return null;
  // A scheme, `//host` or `/path` is not relative to anything in the repo.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/') || value.startsWith('\\')) {
    return null;
  }

  const base = `${BASE_ORIGIN}/${ROOT_SEGMENT}/${encodeRepoPath(folder)}/`;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.origin !== BASE_ORIGIN) return null;
  const rootPrefix = `/${ROOT_SEGMENT}/`;
  if (!url.pathname.startsWith(rootPrefix)) return null;
  const repoPath = decodePathname(url.pathname.slice(rootPrefix.length - 1));
  if (!repoPath) return null;
  return { repoPath, query: url.search + url.hash };
}

/** `?a=1#h` → what follows the path in `value` (from the first `?` or `#`). */
function tailOf(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? '' : value.slice(cut);
}

/** Whether `host` (lowercase, with any port) is one of the app's own. */
function isAppHost(host: string, opts: FrameRefOptions): boolean {
  for (const entry of opts.ourHosts) {
    const rule = entry.toLowerCase();
    if (!rule) continue;
    if (rule.startsWith('.')) {
      const bare = host.replace(/:\d+$/, '');
      if (bare === rule.slice(1) || bare.endsWith(rule)) return true;
    } else if (host === rule) {
      return true;
    }
  }
  return false;
}

function contentHostOf(opts: FrameRefOptions): string | null {
  if (!opts.contentOrigin) return null;
  try {
    return new URL(opts.contentOrigin).host.toLowerCase();
  } catch {
    return null;
  }
}

/** A path on one of the app's hosts (`/content/…`, `/<id>/frame/…`). */
function classifyAppPath(url: URL, opts: FrameRefOptions): FrameRef {
  const pathAndTail = `${url.pathname}${url.search}${url.hash}`;
  if (url.pathname.startsWith('/content/')) {
    const own = opts.ownRepoPath(pathAndTail);
    const repoPath = own === null ? null : ownTargetPath(own);
    return repoPath ? OURS({ repoPath, query: url.search + url.hash }) : INERT;
  }
  const editor = parseEditorFrameUrl(pathAndTail);
  return editor ? OURS(editor) : INERT;
}

/** An absolute http(s) URL; `written` is how the deck spelled it. */
function classifyAbsolute(url: URL, written: string, opts: FrameRefOptions): FrameRef {
  const host = url.host.toLowerCase();
  const contentHost = contentHostOf(opts);
  if (contentHost && host === contentHost) {
    const files = opts.filesRef?.(url.href);
    if (files) return OURS(files);
    // Another classroom's folder grant is not this deck's to embed.
    if (/^\/c\/[^/]+\/files\//.test(url.pathname)) return INERT;
    return EXTERNAL;
  }
  if (isAppHost(host, opts)) return classifyAppPath(url, opts);

  // This repo addressed through GitHub (raw, Pages). Matched on the spelling
  // the deck stored: a parsed URL lowercases the host, and a login need not be.
  const own = opts.ownRepoPath(written);
  if (own !== null) {
    const repoPath = ownTargetPath(own);
    return repoPath ? OURS({ repoPath, query: tailOf(written) }) : INERT;
  }
  return EXTERNAL;
}

/**
 * Which of the three a frame source is. `external` also covers the values
 * that load nothing (`''`, `about:blank`): leave them as they are.
 *
 * A path that resolves to a deck's or a page's stored document is inert: those
 * are never framed.
 */
export function classifyFrameRef(value: string, opts: FrameRefOptions): FrameRef {
  const result = classifyRaw(value, opts);
  if (result.kind === 'ours' && isRepoDocumentPath(result.repoPath)) return INERT;
  return result;
}

function classifyRaw(value: string, opts: FrameRefOptions): FrameRef {
  // Browsers strip leading and trailing C0 controls and spaces from a URL.
  // eslint-disable-next-line no-control-regex -- the point is to find them
  const v = value.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
  if (v === '') return EXTERNAL;
  // eslint-disable-next-line no-control-regex -- a control character inside a URL is never a reference
  if (/[\u0000-\u001f\u007f]/.test(v)) return INERT;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (scheme) {
    const protocol = scheme[1].toLowerCase();
    if (protocol === 'about') return v.toLowerCase() === 'about:blank' ? EXTERNAL : INERT;
    if (protocol !== 'http' && protocol !== 'https') return INERT;
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      return INERT;
    }
    return classifyAbsolute(url, v, opts);
  }

  if (v.startsWith('//') || v.startsWith('\\')) {
    const written = `https:${v.replace(/\\/g, '/')}`;
    let url: URL;
    try {
      url = new URL(written);
    } catch {
      return INERT;
    }
    return classifyAbsolute(url, written, opts);
  }

  if (v.startsWith('/')) {
    let url: URL;
    try {
      url = new URL(v, BASE_ORIGIN);
    } catch {
      return INERT;
    }
    // A root-relative path is a page of the app that serves the deck.
    return classifyAppPath(url, opts);
  }

  const relative = resolveDeckRelative(v, opts.deckFolder);
  return relative ? OURS(relative) : INERT;
}

// ─── The editor's display form ───────────────────────────────────────────────

/** `query` (`?a=1#h`) with `name=value` added before the hash. */
function withParam(query: string, name: string, value: string): string {
  const hashAt = query.indexOf('#');
  const search = hashAt === -1 ? query : query.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : query.slice(hashAt);
  const param = `${name}=${encodeURIComponent(value)}`;
  const joined = search === '' || search === '?' ? `?${param}` : `${search}&${param}`;
  return `${joined}${hash}`;
}

/** `query` without any `name=…` param (and without a `?` left alone). */
function withoutParam(query: string, name: string): string {
  const hashAt = query.indexOf('#');
  const search = hashAt === -1 ? query : query.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : query.slice(hashAt);
  if (!search.startsWith('?')) return `${search}${hash}`;
  const kept = search
    .slice(1)
    .split('&')
    .filter(part => part !== '' && part.split('=')[0] !== name);
  return `${kept.length > 0 ? `?${kept.join('&')}` : ''}${hash}`;
}

/**
 * The editor's URL for one of our frames: `/<slideId>/frame/<repoPath><query>`,
 * plus `cm-rev=<rev>` when given (an html block's file revision, so a new
 * revision is a new URL and the frame reloads).
 */
export function toEditorFrameUrl(
  repoPath: string,
  query: string,
  { slideId, rev }: { slideId: string; rev?: string | null }
): string {
  const path = `/${encodeURIComponent(slideId)}/${EDITOR_FRAME_SEGMENT}/${encodeRepoPath(repoPath)}`;
  return `${path}${rev ? withParam(query, EDITOR_FRAME_REV_PARAM, rev) : query}`;
}

/**
 * `[https://host]/<slide id>/frame/<repoPath>[?query][#hash]`. The first
 * segment must be a slide id (a uuid): an absolute URL of any host is accepted,
 * so the id's shape is what keeps an external page that happens to have a
 * `/x/frame/` path from being read as one of ours.
 */
const EDITOR_FRAME_RE = new RegExp(
  `^(?:https?://[^/?#]+)?/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/${EDITOR_FRAME_SEGMENT}/([^?#]+)([?#].*)?$`,
  'i'
);

/** Whether `url` has the editor frame route's shape (any deck). */
export function isEditorFrameUrl(url: string): boolean {
  return typeof url === 'string' && EDITOR_FRAME_RE.test(url.trim());
}

/**
 * An editor frame URL of any deck → the repo path and query it names
 * (`cm-rev` removed; a path ending in `/` names its `index.html`). Null for any
 * other string. Which classroom's repo the path is read in is the caller's:
 * always its own.
 *
 * `slideId` is accepted and ignored (see `FrameRefOptions.slideId`).
 */
export function parseEditorFrameUrl(
  url: string,
  _opts?: { slideId?: string | null }
): RepoFrameTarget | null {
  if (typeof url !== 'string') return null;
  const match = EDITOR_FRAME_RE.exec(url.trim());
  if (!match) return null;
  const repoPath = decodePathname(match[1]);
  if (!repoPath) return null;
  return { repoPath, query: withoutParam(match[2] ?? '', EDITOR_FRAME_REV_PARAM) };
}

/** `repoPath` written relative to `deckFolder` (`blocks/x.html`, `../../games/a/i.html`). */
export function relativeToDeck(repoPath: string, deckFolder: string): string {
  const from = trimSlashes(deckFolder).split('/').filter(Boolean);
  const to = repoPath.split('/');
  const file = to.pop() as string;
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const up = from.slice(common).map(() => '..');
  return [...up, ...to.slice(common), file]
    .map(s => (s === '..' ? s : encodeURIComponent(s)))
    .join('/');
}

/**
 * An editor frame URL of any deck → the stored reference, relative to THIS
 * deck's folder (`blocks/x.html`, `games/a/index.html?y=1`,
 * `../../games/sketchkit/draw.html?deck=x`, `../other/blocks/x.html` for a
 * block pasted from another deck). Null for anything else.
 */
export function fromEditorFrameUrl(
  url: string,
  { deckFolder }: { deckFolder: string; slideId?: string | null }
): string | null {
  const target = parseEditorFrameUrl(url);
  if (!target) return null;
  return `${relativeToDeck(target.repoPath, deckFolder)}${target.query}`;
}
