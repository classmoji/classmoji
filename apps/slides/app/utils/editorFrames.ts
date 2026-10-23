/**
 * editorFrames.ts — the editor's frames: how a deck's stored frame references
 * are shown while editing, and turned back into what is stored before
 * anything is written.
 *
 * A frame of ours (a file in this classroom's content repo: an iframe's
 * `src`/`data-src`, a section's `data-background-iframe`, an html block's
 * `data-cm-src`) is shown through the editor frame route,
 * `/<slideId>/frame/<repoPath>`, which redirects to a freshly signed URL on
 * the content service. The editor never holds a signed URL, so none can reach
 * a save. An external frame is left as written; one that must not load is
 * renamed for display under this page's session marker, so it is written
 * back exactly as stored (`restoreRenamed`).
 *
 * Every write path runs {@link storeFrames} first: editor frame URLs back to
 * references relative to the deck folder, and an html block's frame back to
 * `data-cm-src`/`data-cm-rev` alone.
 *
 * Pure DOM and strings, no React: the unit suite runs it under jsdom.
 */
import {
  classifyFrameRef,
  fromEditorFrameUrl,
  isEditorFrameUrl,
  normalizeFrameRepoPath,
  relativeToDeck,
  toEditorFrameUrl,
  type FrameRefOptions,
  type RepoFrameTarget,
} from '@classmoji/services/slides/frame-refs';
import {
  HTML_BLOCK_REV_ATTR,
  HTML_BLOCK_SELECTOR,
  HTML_BLOCK_SRC_ATTR,
  isSafeHtmlBlockSandbox,
} from '@classmoji/services/slides/runtime-attrs';
import { pageSessionMarker, sessionInertName } from '@classmoji/services/slides/safe-markup';

/**
 * What the editor needs to show one deck's frames. Present only when the
 * classroom is served by the content service (the editor frame route can sign
 * for it); without it frames are shown exactly as stored.
 */
export interface EditorFrames {
  slideId: string;
  /** The deck folder (`slides/<seg>`): stored references are relative to it. */
  deckFolder: string;
  classroomId: string;
  /** The content repo's owner login and name (its URL shapes are ours). */
  repoLogin: string;
  repo: string;
  /** The app's own hosts (a frame never loads one); `.domain` covers every host under it. */
  ourHosts: string[];
  /** The content service origin. */
  contentOrigin: string | null;
}

/** Attributes holding a frame's source, on any element. */
const FRAME_VALUE_ATTRS = ['src', 'data-src', 'data-background-iframe'] as const;

/**
 * On a frame that shows nothing because its source may not load (or names
 * nothing of ours): the placeholder's hook in the stylesheet. The same
 * attribute the server's read pass marks (`FRAME_MISSING_ATTR`, deckFrames.ts);
 * in the editor it is display only and never written back.
 */
export const FRAME_MISSING_ATTR = 'data-cm-missing';

// ─── The repo's own URL shapes, client side ──────────────────────────────────

/**
 * This repo's URL shapes → the repo path, else null: the slides content proxy
 * (`/content/{login}/{repo}/…`), GitHub Pages and raw (any branch, never a
 * commit). The browser twin of `extractOwnRepoPath` (services contentRefs.ts).
 */
export function ownRepoPathMatcher(login: string, repo: string): (value: string) => string | null {
  const proxy = `/content/${login}/${repo}/`;
  const pages = `https://${login}.github.io/${repo}/`;
  const raw = `https://raw.githubusercontent.com/${login}/${repo}/`;
  const decoded = (path: string): string | null => {
    let out = path;
    try {
      out = decodeURIComponent(path);
    } catch {
      // A malformed escape is left as written.
    }
    out = out.replace(/^\/+/, '');
    return out.length > 0 ? out : null;
  };
  return value => {
    if (typeof value !== 'string' || value.length === 0) return null;
    const cut = value.search(/[?#]/);
    const bare = cut === -1 ? value : value.slice(0, cut);
    if (bare.startsWith(proxy)) return decoded(bare.slice(proxy.length));
    if (bare.startsWith(pages)) return decoded(bare.slice(pages.length));
    if (bare.startsWith(raw)) {
      const rest = bare.slice(raw.length);
      const qualified = /^(refs\/(?:heads|tags)\/[^/]+)\/(.+)$/.exec(rest);
      const slash = rest.indexOf('/');
      const split = qualified
        ? { ref: qualified[1], path: qualified[2] }
        : slash > 0
          ? { ref: rest.slice(0, slash), path: rest.slice(slash + 1) }
          : null;
      if (!split || /^[0-9a-f]{40}$/i.test(split.ref)) return null;
      return decoded(split.path);
    }
    return null;
  };
}

/**
 * A files URL of THIS classroom on the content origin
 * (`/c/<classroom>/files/<grant>/<signature>/<repoPath>`) → the repo path and
 * query it was minted for. Structural only: the signature is not checked, so
 * this only ever turns a URL back into the reference behind it.
 */
export function ownFilesRef(url: string, frames: EditorFrames): RepoFrameTarget | null {
  if (!frames.contentOrigin) return null;
  let parsed: URL;
  let origin: URL;
  try {
    parsed = new URL(url);
    origin = new URL(frames.contentOrigin);
  } catch {
    return null;
  }
  if (parsed.host.toLowerCase() !== origin.host.toLowerCase()) return null;
  const match = /^\/c\/([^/]+)\/files\/[^/]+\/[^/]+\/(.+)$/.exec(parsed.pathname);
  if (!match || match[1].toLowerCase() !== frames.classroomId.toLowerCase()) return null;
  const segments: string[] = [];
  for (const segment of match[2].split('/')) {
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  if (segments.some(segment => segment.includes('/'))) return null;
  const repoPath = normalizeFrameRepoPath(segments.join('/'));
  return repoPath ? { repoPath, query: `${parsed.search}${parsed.hash}` } : null;
}

/** The frame rule's inputs for this deck. */
export function editorFrameRefOptions(frames: EditorFrames): FrameRefOptions {
  return {
    deckFolder: frames.deckFolder,
    ownRepoPath: ownRepoPathMatcher(frames.repoLogin, frames.repo),
    ourHosts: frames.ourHosts,
    contentOrigin: frames.contentOrigin,
    slideId: frames.slideId,
    filesRef: url => ownFilesRef(url, frames),
  };
}

// ─── One value ───────────────────────────────────────────────────────────────

export type FrameDisplay = { kind: 'keep' } | { kind: 'set'; value: string } | { kind: 'inert' };

/** How a stored frame source is shown in the editor. */
export function displayFrameValue(value: string, frames: EditorFrames): FrameDisplay {
  const ref = classifyFrameRef(value, editorFrameRefOptions(frames));
  if (ref.kind === 'external') return { kind: 'keep' };
  if (ref.kind === 'inert') return { kind: 'inert' };
  const shown = toEditorFrameUrl(ref.repoPath, ref.query, { slideId: frames.slideId });
  return shown === value ? { kind: 'keep' } : { kind: 'set', value: shown };
}

/** A frame source as stored: an editor frame URL (of any deck) → its reference relative to this deck; anything else as it is. */
export function storedFrameValue(value: string, frames: EditorFrames | null): string {
  if (!frames || !isEditorFrameUrl(value)) return value;
  return fromEditorFrameUrl(value, { deckFolder: frames.deckFolder }) ?? value;
}

/**
 * A stored frame source in its one stored spelling: a reference of ours as
 * written relative to the deck folder (what a round trip through the editor
 * writes back); anything else as it is. For comparing a stored document with
 * the editor's.
 */
export function canonicalFrameValue(value: string, frames: EditorFrames): string {
  const ref = classifyFrameRef(value, editorFrameRefOptions(frames));
  if (ref.kind !== 'ours') return value;
  return `${relativeToDeck(ref.repoPath, frames.deckFolder)}${ref.query}`;
}

// ─── A subtree ───────────────────────────────────────────────────────────────

function elementsUnder(root: Element | DocumentFragment): Element[] {
  const out: Element[] = [];
  if ((root as Element).attributes) out.push(root as Element);
  out.push(...Array.from(root.querySelectorAll('*')));
  return out;
}

/** Rename `name` on `el` in place (same position) to `next`. */
function renameAttr(el: Element, name: string, next: string): void {
  const attrs = Array.from(el.attributes, a => [a.name, a.value] as const);
  for (const [n] of attrs) el.removeAttribute(n);
  for (const [n, v] of attrs) el.setAttribute(n === name ? next : n, v);
}

function isHtmlBlockFrame(el: Element): boolean {
  return (
    el.localName === 'iframe' &&
    el.hasAttribute(HTML_BLOCK_SRC_ATTR) &&
    el.closest(HTML_BLOCK_SELECTOR) !== null
  );
}

/**
 * The editor URL an html block's frame shows, for its stored `data-cm-src`
 * (`cm-rev` added, so a new revision reloads) — or null when it shows nothing:
 * a sandbox that would let it out, or a reference that is not a file of ours.
 */
export function htmlBlockDisplaySrc(frame: Element, frames: EditorFrames): string | null {
  if (!isSafeHtmlBlockSandbox(frame.getAttribute('sandbox'))) return null;
  const stored = frame.getAttribute(HTML_BLOCK_SRC_ATTR) ?? '';
  const ref = classifyFrameRef(stored, editorFrameRefOptions(frames));
  if (ref.kind !== 'ours') return null;
  return toEditorFrameUrl(ref.repoPath, ref.query, {
    slideId: frames.slideId,
    rev: frame.getAttribute(HTML_BLOCK_REV_ATTR),
  });
}

/**
 * Display, in place: every frame under `root` (and `root` itself) shown the
 * way the editor shows it. Idempotent — a frame already shown is left alone
 * (setting the same `src` again would reload it).
 */
export function showFrames(root: Element | DocumentFragment, frames: EditorFrames | null): void {
  if (!frames) return;
  const marker = pageSessionMarker();
  for (const el of elementsUnder(root)) {
    if (isHtmlBlockFrame(el)) {
      // The file is the block's only source: inline code never shows over it.
      el.removeAttribute('srcdoc');
      const src = htmlBlockDisplaySrc(el, frames);
      if (src === null) {
        el.removeAttribute('src');
        el.setAttribute(FRAME_MISSING_ATTR, '1');
      } else {
        if (el.getAttribute('src') !== src) el.setAttribute('src', src);
        el.removeAttribute(FRAME_MISSING_ATTR);
      }
      continue;
    }
    for (const name of FRAME_VALUE_ATTRS) {
      if (name !== 'data-background-iframe' && el.localName !== 'iframe') continue;
      const value = el.getAttribute(name);
      if (value === null) continue;
      const shown = displayFrameValue(value, frames);
      if (shown.kind === 'set') el.setAttribute(name, shown.value);
      else if (shown.kind === 'inert') {
        renameAttr(el, name, sessionInertName(marker, name));
        if (el.localName === 'iframe') el.setAttribute(FRAME_MISSING_ATTR, '1');
      }
    }
  }
}

/**
 * Before any write, in place: editor frame URLs back to their stored
 * references (relative to this deck), an html block's frame back to its file
 * reference alone (no `src`, `srcdoc` or `data-src`), and the editor's
 * placeholder mark dropped. Safe without a context: then only the html-block
 * rule and the mark apply.
 */
export function storeFrames(root: Element | DocumentFragment, frames: EditorFrames | null): void {
  for (const el of elementsUnder(root)) {
    if (el.localName === 'iframe') el.removeAttribute(FRAME_MISSING_ATTR);
    if (el.localName === 'iframe' && el.hasAttribute(HTML_BLOCK_SRC_ATTR)) {
      el.removeAttribute('src');
      el.removeAttribute('srcdoc');
      el.removeAttribute('data-src');
      el.removeAttribute('data-lazy-loaded');
      continue;
    }
    if (!frames) continue;
    for (const name of FRAME_VALUE_ATTRS) {
      if (name !== 'data-background-iframe' && el.localName !== 'iframe') continue;
      const value = el.getAttribute(name);
      if (value === null) continue;
      const stored = storedFrameValue(value, frames);
      if (stored !== value) el.setAttribute(name, stored);
    }
  }
}

/**
 * A stored document's frames in their stored spelling ({@link
 * canonicalFrameValue}), in place — so a stored document compares equal to
 * the same deck read back from the editor.
 */
export function canonicalFrames(
  root: Element | DocumentFragment,
  frames: EditorFrames | null
): void {
  if (!frames) return;
  for (const el of elementsUnder(root)) {
    if (el.localName === 'iframe' && el.hasAttribute(HTML_BLOCK_SRC_ATTR)) continue;
    for (const name of FRAME_VALUE_ATTRS) {
      if (name !== 'data-background-iframe' && el.localName !== 'iframe') continue;
      const value = el.getAttribute(name);
      if (value === null) continue;
      const canonical = canonicalFrameValue(value, frames);
      if (canonical !== value) el.setAttribute(name, canonical);
    }
  }
}

/**
 * Html blocks just pasted onto a slide, in place, before they are shown: a
 * block copied from another deck still names its file relative to THAT deck
 * (`blocks/x.html`), but the frame's editor URL carries the file's repo path.
 * The block's `data-cm-src` is written again from that URL, relative to this
 * deck (`../other/blocks/x.html`), so it shows the same file; its first Apply
 * here writes a file of this deck. Blocks of this deck come out unchanged.
 */
export function adoptPastedHtmlBlocks(
  root: Element | DocumentFragment,
  frames: EditorFrames | null
): void {
  if (!frames) return;
  for (const el of elementsUnder(root)) {
    if (!isHtmlBlockFrame(el)) continue;
    const shown = el.getAttribute('src');
    if (!shown || !isEditorFrameUrl(shown)) continue;
    const stored = fromEditorFrameUrl(shown, { deckFolder: frames.deckFolder });
    if (stored && stored !== el.getAttribute(HTML_BLOCK_SRC_ATTR)) {
      el.setAttribute(HTML_BLOCK_SRC_ATTR, stored);
    }
  }
}

/** Section attributes for display (`data-background-iframe` shown as the editor shows it). */
export function displaySectionAttrs(
  attrs: Record<string, string>,
  frames: EditorFrames | null
): Record<string, string> {
  if (!frames || !('data-background-iframe' in attrs)) return attrs;
  const value = attrs['data-background-iframe'];
  const shown = displayFrameValue(value, frames);
  if (shown.kind === 'keep') return attrs;
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(attrs)) {
    if (name !== 'data-background-iframe') out[name] = v;
    else if (shown.kind === 'set') out[name] = shown.value;
    else out[sessionInertName(pageSessionMarker(), name)] = v;
  }
  return out;
}

// ─── The frame an iframe panel edits ─────────────────────────────────────────

/** The sandbox a new iframe block starts with (external sites; our frames are boxed anyway). */
export const DEFAULT_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';

/**
 * Which attribute of a plain iframe holds its stored source: `data-src` (also
 * while Reveal has it loaded: `src` + `data-lazy-loaded`), else `src`.
 */
export function iframeSourceAttr(frame: Element): 'src' | 'data-src' {
  if (frame.hasAttribute('data-src') || frame.hasAttribute('data-lazy-loaded')) return 'data-src';
  if (frame.hasAttribute('src')) return 'src';
  const marker = pageSessionMarker();
  return frame.hasAttribute(sessionInertName(marker, 'data-src')) ? 'data-src' : 'src';
}

/** The iframe's source as stored (never the editor's display URL). */
export function readStoredIframeSrc(frame: Element, frames: EditorFrames | null): string {
  const attr = iframeSourceAttr(frame);
  const marker = pageSessionMarker();
  const live =
    attr === 'data-src'
      ? (frame.getAttribute('data-src') ??
        (frame.hasAttribute('data-lazy-loaded') ? frame.getAttribute('src') : null))
      : frame.getAttribute('src');
  const value = live ?? frame.getAttribute(sessionInertName(marker, attr)) ?? '';
  return storedFrameValue(value, frames);
}

/**
 * Point the iframe at `stored` (what the author typed): the stored attribute
 * gets its display form, every other attribute stays as it is.
 */
export function writeStoredIframeSrc(
  frame: Element,
  stored: string,
  frames: EditorFrames | null
): void {
  const attr = iframeSourceAttr(frame);
  const marker = pageSessionMarker();
  frame.removeAttribute(sessionInertName(marker, attr));
  // Loaded by Reveal: the value lives in `src` until the slide unloads.
  const target =
    attr === 'data-src' && !frame.hasAttribute('data-src') && frame.hasAttribute('data-lazy-loaded')
      ? 'src'
      : attr;
  let value = stored;
  let inert = false;
  if (frames) {
    const shown = displayFrameValue(stored, frames);
    if (shown.kind === 'set') value = shown.value;
    else if (shown.kind === 'inert') inert = true;
  }
  // Both `data-src` and `src` without Reveal's lazy-load mark: `src` mirrors
  // `data-src` (a frame Reveal loaded before marking it). Both move together.
  const mirrored =
    attr === 'data-src' &&
    target === 'data-src' &&
    frame.hasAttribute('src') &&
    !frame.hasAttribute('data-lazy-loaded');
  if (inert) {
    frame.removeAttribute(target);
    if (mirrored) frame.removeAttribute('src');
    frame.setAttribute(sessionInertName(marker, attr), stored);
    if (target !== attr) frame.removeAttribute('data-lazy-loaded');
    frame.setAttribute(FRAME_MISSING_ATTR, '1');
    return;
  }
  frame.setAttribute(target, value);
  if (mirrored) frame.setAttribute('src', value);
  frame.removeAttribute(FRAME_MISSING_ATTR);
}
