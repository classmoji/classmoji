/**
 * deckBlocks.ts — svg and html slide blocks: their markup, and the rules that
 * keep an html block's code to itself.
 *
 * - An **html block** is an `.sl-block[data-block-type="html"]` holding one
 *   `<iframe sandbox srcdoc>`. The frame's `srcdoc` IS the block's source, so
 *   every surface (editor, viewer, presenter, follow, render-view, thumbnail)
 *   shows it without hydration, and its scripts run in an opaque origin: no
 *   access to the page around it, its cookies, or the live session. The rule:
 *   a frame inside an html block loads only while its `sandbox` is present and
 *   holds nothing beyond {@link HTML_BLOCK_SANDBOX_ALLOWED}; otherwise its
 *   source attributes are renamed to `data-cm-inert-*` for display.
 * - An **svg block** is an `.sl-block[data-block-type="svg"]` holding inline
 *   SVG, so `currentColor` and theme CSS apply. Its content is held to a list
 *   of drawing elements and attributes (no script, no foreignObject, no event
 *   handlers, links only to `#fragment`, `https:` or `data:image/…`).
 *
 * ZERO runtime imports, like deckRuntimeAttrs.ts (which re-exports this
 * module for the `@classmoji/services/slides/runtime-attrs` subpath): the
 * slides editor applies these lists with the DOM, the server with cheerio
 * (deckHtml.ts), from the same predicates.
 */

// ─── Shared names ────────────────────────────────────────────────────────────

export type DeckBlockType = 'svg' | 'html' | 'iframe';

export const HTML_BLOCK_SELECTOR = '.sl-block[data-block-type="html"]';
export const SVG_BLOCK_SELECTOR = '.sl-block[data-block-type="svg"]';

/** The attribute that names a block for block-level edits (MCP block ops, the inspector). */
export const BLOCK_ID_ATTR = 'data-cm-block-id';

/** Prefix of an attribute renamed so that it does nothing on display. */
export const INERT_ATTR_PREFIX = 'data-cm-inert-';

// ─── html blocks: the isolation rule ─────────────────────────────────────────

/** The sandbox every html block's frame is built with. */
export const HTML_BLOCK_SANDBOX = 'allow-scripts allow-pointer-lock allow-modals allow-popups';

/**
 * Sandbox tokens an html block's frame may carry and still load. Anything
 * else — above all `allow-same-origin` and `allow-top-navigation*`, which
 * would hand the frame the page's origin or its window — makes it inert.
 */
export const HTML_BLOCK_SANDBOX_ALLOWED: ReadonlySet<string> = new Set([
  'allow-scripts',
  'allow-pointer-lock',
  'allow-modals',
  'allow-popups',
  'allow-forms',
  'allow-downloads',
  'allow-presentation',
  'allow-orientation-lock',
]);

/**
 * Whether a frame with this `sandbox` value may load inside an html block.
 * A missing attribute is unsafe (no sandbox at all); tokens are ASCII
 * case-insensitive and split on ASCII whitespace, as the browser reads them.
 */
export function isSafeHtmlBlockSandbox(value: string | null | undefined): boolean {
  if (value == null) return false;
  return value
    .split(/[\t\n\f\r ]+/)
    .filter(Boolean)
    .every(token => HTML_BLOCK_SANDBOX_ALLOWED.has(token.toLowerCase()));
}

/**
 * Elements that load a document (or attach one), and the attributes that
 * tell them which. Only an iframe has a sandbox; inside an html block the
 * others never load, and a `<template>` never becomes a shadow root.
 */
const FRAME_SOURCE_ATTRS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['iframe', new Set(['srcdoc', 'src', 'data-src'])],
  ['object', new Set(['data', 'data-src'])],
  ['embed', new Set(['src', 'data-src'])],
  ['template', new Set(['shadowrootmode', 'shadowroot'])],
]);

/**
 * Every element {@link FRAME_SOURCE_ATTRS} names inside an html block, or that
 * is itself one (for `querySelectorAll` and cheerio alike).
 */
export const HTML_BLOCK_FRAME_SELECTOR = Array.from(FRAME_SOURCE_ATTRS.keys())
  .flatMap(tag => [`${HTML_BLOCK_SELECTOR} ${tag}`, `${tag}${HTML_BLOCK_SELECTOR}`])
  .join(', ');

/** The permissions an html block's frame may delegate: fullscreen, nothing else. */
export const HTML_BLOCK_FRAME_ALLOW = 'fullscreen';

/**
 * Whether an `allow` value is the one an html block's frame may carry:
 * `fullscreen` (case, surrounding space and a trailing `;` aside) or empty.
 */
export function isPinnedHtmlBlockAllow(value: string): boolean {
  const v = value.trim().replace(/;\s*$/, '').trim().toLowerCase();
  return v === '' || v === HTML_BLOCK_FRAME_ALLOW;
}

/**
 * Whether attribute `name` of an element named `tagName` must not render,
 * given the element's `sandbox` and whether it sits inside an html block.
 * Shared by the DOM pass below and the cheerio pass in deckHtml.ts.
 *
 * `value` is the attribute's value; it decides `allow` on a frame (anything
 * beyond {@link HTML_BLOCK_FRAME_ALLOW} does not render). Without it, `allow`
 * is left as it is.
 */
export function isBlockedFrameAttr(
  tagName: string,
  name: string,
  sandbox: string | null | undefined,
  insideHtmlBlock: boolean,
  value?: string | null
): boolean {
  if (!insideHtmlBlock) return false;
  const tag = tagName.toLowerCase();
  const attr = name.toLowerCase();
  if (tag === 'iframe' && attr === 'allow') {
    return value != null && !isPinnedHtmlBlockAllow(value);
  }
  const sources = FRAME_SOURCE_ATTRS.get(tag);
  if (!sources || !sources.has(attr)) return false;
  return tag !== 'iframe' || !isSafeHtmlBlockSandbox(sandbox);
}

/** {@link isBlockedFrameAttr} for a DOM element. */
export function isBlockedHtmlBlockAttr(el: Element, name: string): boolean {
  const tag = el.localName;
  if (!FRAME_SOURCE_ATTRS.has(tag)) return false;
  return isBlockedFrameAttr(
    tag,
    name,
    el.getAttribute('sandbox'),
    el.closest(HTML_BLOCK_SELECTOR) !== null,
    el.getAttribute(name)
  );
}

/**
 * Display pass: every frame source an html block may not load is renamed in
 * place to `data-cm-inert-<name>` (same position, so the rename is reversible
 * byte for byte). Returns how many attributes were renamed.
 */
export function neutralizeHtmlBlockFrames(root: Element | Document | DocumentFragment): number {
  let renamed = 0;
  const frames = Array.from(root.querySelectorAll(HTML_BLOCK_FRAME_SELECTOR));
  if ((root as Element).matches?.(HTML_BLOCK_FRAME_SELECTOR)) frames.unshift(root as Element);
  for (const el of frames) {
    const attrs = Array.from(el.attributes);
    if (!attrs.some(attr => isBlockedHtmlBlockAttr(el, attr.name))) continue;
    const entries = attrs.map(attr => {
      if (!isBlockedHtmlBlockAttr(el, attr.name)) return [attr.name, attr.value] as const;
      renamed++;
      return [`${INERT_ATTR_PREFIX}${attr.name}`, attr.value] as const;
    });
    for (const attr of attrs) el.removeAttribute(attr.name);
    for (const [name, value] of entries) el.setAttribute(name, value);
  }
  return renamed;
}

// ─── html blocks: source ⇄ srcdoc ────────────────────────────────────────────

/**
 * Runs first in every html block: an opaque origin has no storage, so
 * `localStorage` / `sessionStorage` throw there. This puts an in-memory
 * stand-in in their place (it lasts as long as the frame) when the real one
 * is unavailable. Stored as part of the srcdoc, never shown as source.
 */
export const HTML_BLOCK_STORAGE_SHIM =
  '<script data-cm-storage-shim>(function(){function m(){var d=new Map();return{get length(){' +
  'return d.size},key:function(i){var k=Array.from(d.keys());return i>=0&&i<k.length?k[i]:null},' +
  'getItem:function(k){k=String(k);return d.has(k)?d.get(k):null},setItem:function(k,v){' +
  'd.set(String(k),String(v))},removeItem:function(k){d.delete(String(k))},clear:function(){' +
  "d.clear()}}}['localStorage','sessionStorage'].forEach(function(n){try{if(window[n])return}" +
  'catch(e){}try{Object.defineProperty(window,n,{value:m(),configurable:true,enumerable:true})}' +
  'catch(e){}})})();</script>';

/**
 * The leading doctype (after whitespace and comments) of `html`, or '' — the
 * shim goes after it, keeping standards mode. A scan, not a regex: linear in
 * the input whatever it holds.
 */
function leadingDoctype(html: string): string {
  let at = 0;
  for (;;) {
    while (at < html.length && /\s/.test(html[at])) at++;
    if (!html.startsWith('<!--', at)) break;
    const end = html.indexOf('-->', at + 4);
    if (end === -1) return '';
    at = end + 3;
  }
  if (html.slice(at, at + 9).toLowerCase() !== '<!doctype') return '';
  const close = html.indexOf('>', at);
  return close === -1 ? '' : html.slice(0, close + 1);
}

/** The srcdoc for an html block's source: the storage shim, then the source. */
export function htmlBlockSrcdoc(source: string): string {
  const doctype = leadingDoctype(source);
  if (doctype) return doctype + HTML_BLOCK_STORAGE_SHIM + source.slice(doctype.length);
  return HTML_BLOCK_STORAGE_SHIM + source;
}

/** The source an author wrote, from a frame's srcdoc (the storage shim taken out). */
export function htmlBlockSource(srcdoc: string): string {
  const doctype = leadingDoctype(srcdoc);
  if (srcdoc.startsWith(HTML_BLOCK_STORAGE_SHIM, doctype.length)) {
    return doctype + srcdoc.slice(doctype.length + HTML_BLOCK_STORAGE_SHIM.length);
  }
  if (srcdoc.startsWith(HTML_BLOCK_STORAGE_SHIM)) {
    return srcdoc.slice(HTML_BLOCK_STORAGE_SHIM.length);
  }
  return srcdoc;
}

// ─── svg blocks: the element and attribute lists ─────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Drawing, paint server, filter, text, link and animation elements (lowercase local names). */
const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'title',
  'desc',
  'metadata',
  'switch',
  'view',
  'a',
  'style',
  'image',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textpath',
  'lineargradient',
  'radialgradient',
  'stop',
  'pattern',
  'clippath',
  'mask',
  'marker',
  'filter',
  'feblend',
  'fecolormatrix',
  'fecomponenttransfer',
  'fecomposite',
  'feconvolvematrix',
  'fediffuselighting',
  'fedisplacementmap',
  'fedistantlight',
  'fedropshadow',
  'feflood',
  'fefunca',
  'fefuncb',
  'fefuncg',
  'fefuncr',
  'fegaussianblur',
  'feimage',
  'femerge',
  'femergenode',
  'femorphology',
  'feoffset',
  'fepointlight',
  'fespecularlighting',
  'fespotlight',
  'fetile',
  'feturbulence',
  'animate',
  'animatemotion',
  'animatetransform',
  'mpath',
  'set',
]);

const SVG_ANIMATION_ELEMENTS: ReadonlySet<string> = new Set([
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
]);

// eslint-disable-next-line no-control-regex -- browsers ignore these inside a URL scheme
const URL_NOISE_RE = /[\u0000- \u007f]/g;
const SCRIPT_SCHEME_RE = /(?:javascript|vbscript):/;
const ATTR_NAME_RE = /^[a-zA-Z_][\w:.-]*$/;
const LINK_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i;

/** Whether an SVG element (local name, namespace URI) may stay in an svg block. */
export function isAllowedSvgElement(localName: string, namespaceUri: string | null): boolean {
  return namespaceUri === SVG_NS && SVG_ELEMENTS.has(localName.toLowerCase());
}

/** A link target an svg block may carry: `#fragment`, `https:`, or an image `data:` URL. */
export function isAllowedSvgLink(value: string): boolean {
  const v = value.trim();
  return v.startsWith('#') || /^https:\/\//i.test(v) || LINK_DATA_IMAGE_RE.test(v);
}

function hasScriptScheme(value: string): boolean {
  return SCRIPT_SCHEME_RE.test(value.replace(URL_NOISE_RE, '').toLowerCase());
}

/** Whether an attribute may stay on an element inside an svg block (no script URL anywhere in it). */
export function isAllowedSvgAttr(name: string, value: string): boolean {
  if (!ATTR_NAME_RE.test(name)) return false;
  const lower = name.toLowerCase();
  if (lower.startsWith('on')) return false;
  const local = lower.replace(/^xlink:/, '');
  if (local === 'href' || local === 'src') return isAllowedSvgLink(value);
  return !hasScriptScheme(value);
}

/** An element's attributes as `[name, value]` pairs, or a record of them. */
export type SvgAttrList =
  | ReadonlyArray<readonly [string, string]>
  | Readonly<Record<string, string>>;

const ANIMATED_VALUE_ATTRS: ReadonlySet<string> = new Set(['values', 'to', 'from', 'by']);

/**
 * Whether an animation element may stay: SMIL may animate geometry, colour or
 * transforms, never a link target or a handler (`attributeName` href/src/on*,
 * under any prefix), and no animated value may hold a script URL. Every
 * attribute is read, whatever its case, so names that differ only in case
 * (possible in parsed XML) cannot hide one another.
 */
export function isAllowedSvgAnimation(localName: string, attrs: SvgAttrList): boolean {
  if (!SVG_ANIMATION_ELEMENTS.has(localName.toLowerCase())) return true;
  const pairs = Array.isArray(attrs)
    ? (attrs as ReadonlyArray<readonly [string, string]>)
    : Object.entries(attrs as Readonly<Record<string, string>>);
  for (const [rawName, value] of pairs) {
    const name = rawName.toLowerCase();
    if (name === 'attributename') {
      const target = value.trim().toLowerCase();
      const local = target.slice(target.lastIndexOf(':') + 1);
      if (local === 'href' || local === 'src' || local.startsWith('on')) return false;
    } else if (ANIMATED_VALUE_ATTRS.has(name) && hasScriptScheme(value)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether attribute `name` of `el` must not render in an svg block, on display
 * (the live editor renames it inert rather than dropping it): it is off the
 * list, or it drives an animation that is.
 */
export function isBlockedSvgBlockAttr(el: Element, name: string): boolean {
  if (el.namespaceURI !== SVG_NS || el.closest(SVG_BLOCK_SELECTOR) === null) return false;
  if (!isAllowedSvgAttr(name, el.getAttribute(name) ?? '')) return true;
  const lower = name.toLowerCase();
  if (lower !== 'attributename' && !ANIMATED_VALUE_ATTRS.has(lower)) return false;
  return !isAllowedSvgAnimation(el.localName, attrPairs(el));
}

function attrPairs(el: Element): Array<[string, string]> {
  return Array.from(el.attributes, attr => [attr.name, attr.value] as [string, string]);
}

/** Two attribute names that differ only in case (parsed XML can carry both). */
function hasCaseTwins(el: Element): boolean {
  const seen = new Set<string>();
  for (const attr of Array.from(el.attributes)) {
    const lower = attr.name.toLowerCase();
    if (seen.has(lower)) return true;
    seen.add(lower);
  }
  return false;
}

/**
 * Whether an element inside an svg block may stay there (DOM): on the
 * element list, no two attribute names that differ only in case, and an
 * animation only of what may be animated.
 */
export function isKeptSvgElement(el: Element): boolean {
  return (
    isAllowedSvgElement(el.localName, el.namespaceURI) &&
    !hasCaseTwins(el) &&
    isAllowedSvgAnimation(el.localName, attrPairs(el))
  );
}

/**
 * The nodes under `root` (not `root` itself) the svg-block lists keep out,
 * outermost first: elements off the list (everything inside them goes with
 * them, and nothing inside one is listed), comments, CDATA and processing
 * instructions.
 */
export function offListSvgNodes(root: Element): ChildNode[] {
  const out: ChildNode[] = [];
  const visit = (parent: Element): void => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 1) {
        if (isKeptSvgElement(node as Element)) visit(node as Element);
        else out.push(node);
      } else if (node.nodeType !== 3) {
        out.push(node);
      }
    }
  };
  visit(root);
  return out;
}

function svgBlocksUnder(root: Element | Document | DocumentFragment): Element[] {
  const blocks = Array.from(root.querySelectorAll(SVG_BLOCK_SELECTOR));
  if ((root as Element).matches?.(SVG_BLOCK_SELECTOR)) blocks.unshift(root as Element);
  return blocks;
}

function isBlockContent(node: ChildNode): boolean {
  return node.nodeType === 1 && (node as Element).classList.contains('sl-block-content');
}

/**
 * Every node the svg-block lists keep out of the svg blocks under `root`,
 * outermost first: what {@link offListSvgNodes} lists inside each block's
 * `.sl-block-content`, and any child of a block other than its content (text
 * aside). The one list every display path acts on — the viewer and presenter
 * remove these ({@link sanitizeSvgBlocks}); attributes are judged by
 * {@link isBlockedSvgBlockAttr}.
 */
export function offListSvgBlockNodes(root: Element | Document | DocumentFragment): ChildNode[] {
  const out: ChildNode[] = [];
  for (const block of svgBlocksUnder(root)) {
    for (const child of Array.from(block.childNodes)) {
      if (isBlockContent(child)) out.push(...offListSvgNodes(child as Element));
      else if (child.nodeType !== 3) out.push(child);
    }
  }
  return out;
}

function dropHandlers(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.toLowerCase().startsWith('on')) el.removeAttribute(attr.name);
  }
}

/** Every attribute off the list dropped, on each element under `root`. */
function dropOffListAttrs(root: Element): void {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (!isAllowedSvgAttr(attr.name, attr.value)) el.removeAttribute(attr.name);
    }
  }
}

/**
 * Hold every descendant of `root` to the svg-block lists (DOM): elements off
 * the list are removed with everything inside them, as are comments and
 * processing instructions; attributes off the list are dropped; `<style>`
 * sheets are scoped to their drawing ({@link scopeSvgStyles}). `root` itself
 * keeps its element and loses only event handlers (it is the block content
 * wrapper, or an `<svg>`).
 */
export function sanitizeSvgTree(root: Element): void {
  dropHandlers(root);
  for (const node of offListSvgNodes(root)) node.parentNode?.removeChild(node);
  dropOffListAttrs(root);
  scopeSvgStyles(root);
}

/**
 * Every svg block under `root` held to the lists (DOM): the nodes
 * {@link offListSvgBlockNodes} lists are removed, attributes off the list
 * dropped, styles scoped. The block and its `.sl-block-content` keep their
 * own attributes (minus handlers).
 */
export function sanitizeSvgBlocks(root: Element | Document | DocumentFragment): void {
  for (const node of offListSvgBlockNodes(root)) node.parentNode?.removeChild(node);
  for (const block of svgBlocksUnder(root)) {
    dropHandlers(block);
    for (const child of Array.from(block.children)) {
      if (!isBlockContent(child)) continue;
      dropHandlers(child);
      dropOffListAttrs(child);
      scopeSvgStyles(child);
    }
  }
}

// ─── svg blocks: styles stay in their drawing ───────────────────────────────
//
// A drawing's `<style>` sheets are rewritten so that every rule applies only
// to the drawing: its outermost `<svg>` carries `data-cm-scope="<key>"` and
// every selector gets `:where([data-cm-scope="<key>"], [data-cm-scope="<key>"] *)`
// on its subject (no specificity), so `.st0` / `.cls-1` from drawing tools
// never reach another drawing or the page, while selectors naming the drawing
// itself (`svg rect`, `#diagram-id .node`) still match. `:root` / `:scope`
// mean the drawing. `@keyframes` names get `_cm-<key>` (and the drawing's
// `animation` declarations follow), so two drawings' `spin` — or the page's —
// never collide. `@import` and rules that cannot be held to the drawing are
// dropped. Plain selector syntax, so every browser applies it (no `@scope`).
//
// The key is a hash of the drawing's sheets in their scoped form (with a
// placeholder key), so it is the same however often, and wherever (server or
// browser), the sheets are scoped: the rewrite is idempotent.

/** The attribute on a drawing's `<svg>` naming its scope. */
export const SVG_SCOPE_ATTR = 'data-cm-scope';

const KEY_PLACEHOLDER = 'dk';

/** Appended to a selector's subject: the drawing's root or anything inside it. */
export function svgScopeSuffix(key: string): string {
  return `:where(${svgScopeRoot(key)}, ${svgScopeRoot(key)} *)`;
}

/** The drawing's root as a selector (the key is an identifier: no quotes needed, none used). */
function svgScopeRoot(key: string): string {
  return `[${SVG_SCOPE_ATTR}=${key}]`;
}

const ANY_SUFFIX_RE = /:where\(\[data-cm-scope=[0-9a-z]+\], \[data-cm-scope=[0-9a-z]+\] \*\)/g;
const ANY_ROOT_RE = /\[data-cm-scope=[0-9a-z]+\]/g;
const ROOT_PSEUDO_RE = /:(?:root|scope)(?![\w-])/gi;
const KEYFRAMES_SUFFIX_RE = /_cm-[0-9a-z]+$/;

/** Statement at-rules a scoped sheet keeps (they select nothing). */
const KEPT_STATEMENTS: ReadonlySet<string> = new Set(['charset', 'namespace', 'layer']);

/** Block at-rules a scoped sheet keeps as written (they define, never select). */
const KEPT_BLOCKS: ReadonlySet<string> = new Set([
  'font-face',
  'property',
  'counter-style',
  'font-feature-values',
  'font-palette-values',
  'page',
]);

/** Keyframes at-rules (their names get the drawing's key). */
const KEYFRAMES_RULES: ReadonlySet<string> = new Set([
  'keyframes',
  '-webkit-keyframes',
  '-moz-keyframes',
  '-o-keyframes',
]);

/** Conditional group rules whose style rules are scoped like top-level ones. */
const GROUP_AT_RULES: ReadonlySet<string> = new Set([
  'media',
  'supports',
  'layer',
  'container',
  'starting-style',
]);

const ANIMATION_PROPS: ReadonlySet<string> = new Set([
  'animation',
  'animation-name',
  '-webkit-animation',
  '-webkit-animation-name',
]);

interface CssChunk {
  text: string;
  /** Lower-case at-rule name (`keyframes`), or null for a style rule. */
  at: string | null;
  /** The text between the at-rule's name (or the start) and its block, trimmed. */
  prelude: string;
  /** Where the chunk's block opens in `text`, or -1 for a statement. */
  open: number;
  /** True when it ended in a closed block. */
  block: boolean;
}

// Any non-ASCII code point is an identifier character in CSS.
// eslint-disable-next-line no-control-regex
const IDENT_CHAR_RE = /[\w-]|[^\x00-\x7f]/;

/** The decoded name of the ident at `at` (escapes read), and where it ends. */
function readIdent(css: string, at: number): { name: string; end: number } {
  let name = '';
  let i = at;
  while (i < css.length) {
    const c = css[i];
    if (c === '\\' && i + 1 < css.length && css[i + 1] !== '\n') {
      const hex = /^[0-9a-fA-F]{1,6}/.exec(css.slice(i + 1, i + 7));
      if (hex) {
        name += String.fromCodePoint(Math.min(parseInt(hex[0], 16), 0x10ffff) || 0xfffd);
        i += 1 + hex[0].length;
        if (/\s/.test(css[i] ?? '')) i++;
      } else {
        name += css[i + 1];
        i += 2;
      }
    } else if (IDENT_CHAR_RE.test(c)) {
      name += c;
      i++;
    } else {
      break;
    }
  }
  return { name, end: i };
}

/**
 * A sheet's rules at one level, in order, read the way CSS tokenizes them
 * (comments, strings, escapes, and an unquoted `url(…)` as one token). A `}`
 * with no block open is dropped; a rule cut off at the end is closed
 * (comment, string and blocks), so the result is balanced.
 */
function cssChunks(css: string): CssChunk[] {
  const chunks: CssChunk[] = [];
  let start = 0;
  let depth = 0;
  let text = '';
  let open = -1;
  const push = (end: number, block: boolean, tail = '') => {
    const piece = text + css.slice(start, end) + tail;
    const at = open;
    text = '';
    open = -1;
    if (!piece.trim()) return;
    const lead = /^(?:\s|\/\*[\s\S]*?\*\/)*/.exec(piece)?.[0].length ?? 0;
    const name = piece[lead] === '@' ? readIdent(piece, lead + 1) : null;
    const preludeFrom = name ? name.end : lead;
    const prelude = piece.slice(preludeFrom, at === -1 ? piece.length : at).trim();
    chunks.push({
      text: piece,
      at: name ? name.name.toLowerCase() : null,
      prelude,
      open: at,
      block,
    });
  };
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      if (close === -1) {
        push(css.length, depth > 0, '*/' + '}'.repeat(depth));
        return chunks;
      }
      i = close + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      if (j >= css.length) {
        push(css.length, depth > 0, c + '}'.repeat(depth));
        return chunks;
      }
      i = j + 1;
    } else if (c === '\\' || IDENT_CHAR_RE.test(c)) {
      const ident = readIdent(css, i);
      if (ident.end === i) {
        i++; // a lone backslash before a newline
        continue;
      }
      i = ident.end;
      if (ident.name.toLowerCase() === 'url' && css[i] === '(') {
        let j = i + 1;
        while (j < css.length && /\s/.test(css[j])) j++;
        if (css[j] !== '"' && css[j] !== "'") {
          // An unquoted url runs to its `)`: nothing inside it is structure.
          while (j < css.length && css[j] !== ')') j += css[j] === '\\' ? 2 : 1;
          if (j >= css.length) {
            push(css.length, depth > 0, ')' + '}'.repeat(depth));
            return chunks;
          }
          i = j + 1;
        }
      }
    } else if (c === '{') {
      if (depth === 0) open = text.length + (i - start);
      depth++;
      i++;
    } else if (c === '}') {
      if (depth === 0) {
        // A stray close: dropped, or it would end the scope early. An empty
        // comment takes its place, keeping the tokens on either side apart
        // (a space could be read as part of an escape before it).
        text += css.slice(start, i) + '/**/';
        start = i + 1;
      } else if (--depth === 0) {
        push(i + 1, true);
        start = i + 1;
      }
      i++;
    } else if (c === ';' && depth === 0) {
      push(i + 1, false);
      start = i + 1;
      i++;
    } else {
      i++;
    }
  }
  push(css.length, depth > 0, '}'.repeat(depth));
  return chunks;
}

/** `list` split at its top-level commas (strings, comments, brackets and parens read). */
function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '\\') i++;
    else if (c === '"' || c === "'") {
      for (i++; i < list.length && list[i] !== c; i++) if (list[i] === '\\') i++;
    } else if (c === '/' && list[i + 1] === '*') {
      const close = list.indexOf('*/', i + 2);
      i = close === -1 ? list.length : close + 1;
    } else if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    else if (c === ',' && depth === 0) {
      out.push(list.slice(from, i));
      from = i + 1;
    }
  }
  out.push(list.slice(from));
  return out;
}

/** Whether every string and comment in `text` closes (on its line, for a string). */
function closesItsTokens(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++) {
        if (text[i] === '\n') return false;
        if (text[i] === '\\') i++;
      }
      if (i >= text.length) return false;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return false;
      i = close + 1;
    }
  }
  return true;
}

const LEGACY_PSEUDO_ELEMENT_RE = /^:(?:before|after|first-line|first-letter)(?![\w-])/i;

/**
 * `text` with `fn` applied to the runs outside strings, comments and escapes
 * (those are copied as they are).
 */
function mapPlainCss(text: string, fn: (plain: string) => string): string {
  let out = '';
  let plain = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    let end = -1;
    if (c === '\\') {
      end = Math.min(i + 2, text.length);
    } else if (c === '"' || c === "'") {
      end = i + 1;
      while (end < text.length && text[end] !== c && text[end] !== '\n') {
        end += text[end] === '\\' ? 2 : 1;
      }
      end = Math.min(end + 1, text.length);
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      end = close === -1 ? text.length : close + 2;
    }
    if (end === -1) {
      plain += c;
      continue;
    }
    out += fn(plain) + text.slice(i, end);
    plain = '';
    i = end - 1;
  }
  return out + fn(plain);
}

/**
 * One selector held to the drawing: `:root` / `:scope` become the drawing's
 * root, and the scope suffix goes on the subject — after its last token,
 * before a pseudo-element. A selector already scoped (any key) is re-keyed.
 * Null when it cannot be held to the drawing (empty, or ending in a
 * combinator or a bare colon): its rule is dropped.
 */
function scopeSelector(selector: string, key: string): string | null {
  const sel = mapPlainCss(selector, plain =>
    plain
      .replace(ANY_SUFFIX_RE, '')
      .replace(ANY_ROOT_RE, ':root')
      .replace(ROOT_PSEUDO_RE, svgScopeRoot(key))
  );
  let end = -1;
  let pseudo = -1;
  let depth = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '/' && sel[i + 1] === '*') {
      const close = sel.indexOf('*/', i + 2);
      i = close === -1 ? sel.length : close + 1;
      continue;
    }
    if (/\s/.test(c)) continue;
    if (c === '\\') {
      i++;
    } else if (c === '"' || c === "'") {
      for (i++; i < sel.length && sel[i] !== c; i++) if (sel[i] === '\\') i++;
    } else if (c === '(' || c === '[') {
      depth++;
    } else if ((c === ')' || c === ']') && depth > 0) {
      depth--;
    } else if (
      c === ':' &&
      depth === 0 &&
      pseudo === -1 &&
      (sel[i + 1] === ':' || LEGACY_PSEUDO_ELEMENT_RE.test(sel.slice(i)))
    ) {
      pseudo = i;
    }
    end = Math.min(i + 1, sel.length);
  }
  // Empty, unbalanced, or ending in a backslash that would escape the suffix.
  const tailSlashes = /\\+$/.exec(sel.slice(0, end))?.[0].length ?? 0;
  if (end === -1 || depth !== 0 || tailSlashes % 2 === 1) return null;
  const cut = pseudo !== -1 ? pseudo : end;
  if (/[:>+~([,]$/.test(sel.slice(0, cut).trimEnd()) || !sel.slice(0, cut).trim()) return null;
  return (sel.slice(0, cut) + svgScopeSuffix(key) + sel.slice(cut)).trim();
}

/** `name` with its drawing key, when it is a keyframes name the drawing defines. */
function keyedName(name: string, names: ReadonlySet<string>, key: string): string {
  const base = name.replace(KEYFRAMES_SUFFIX_RE, '');
  return names.has(base) ? `${base}_cm-${key}` : name;
}

/**
 * Declarations with `animation` / `animation-name` values pointing at the
 * drawing's own keyframes by their keyed names. Nested rules are left as
 * written. Also used for `style` attributes inside the drawing.
 */
export function scopeAnimationNames(
  decls: string,
  names: ReadonlySet<string>,
  key: string
): string {
  if (names.size === 0 || !/animation/i.test(decls)) return decls;
  const out: string[] = [];
  let from = 0;
  let depth = 0;
  const flush = (to: number) => {
    const decl = decls.slice(from, to);
    const colon = decl.indexOf(':');
    const prop = colon === -1 ? '' : decl.slice(0, colon).trim().toLowerCase();
    if (!ANIMATION_PROPS.has(prop) || decl.includes('{')) {
      out.push(decl);
      return;
    }
    const value = decl
      .slice(colon + 1)
      .replace(
        /(^|[\s,])(-?[A-Za-z_][\w-]*)(?=$|[\s,!;])/g,
        (_m, lead: string, ident: string) => lead + keyedName(ident, names, key)
      );
    out.push(decl.slice(0, colon + 1) + value);
  };
  for (let i = 0; i < decls.length; i++) {
    const c = decls[i];
    if (c === '\\') i++;
    else if (c === '"' || c === "'") {
      for (i++; i < decls.length && decls[i] !== c && decls[i] !== '\n'; i++) {
        if (decls[i] === '\\') i++;
      }
    } else if (c === '/' && decls[i + 1] === '*') {
      const close = decls.indexOf('*/', i + 2);
      i = close === -1 ? decls.length : close + 1;
    } else if (c === '{' || c === '(') depth++;
    else if ((c === '}' || c === ')') && depth > 0) depth--;
    else if (c === ';' && depth === 0) {
      flush(i);
      out.push(';');
      from = i + 1;
    }
  }
  flush(decls.length);
  return out.join('');
}

/** Keyframes names a sheet defines (keys taken off), at any group depth. */
function keyframesNames(css: string, out: Set<string>): Set<string> {
  for (const chunk of cssChunks(css)) {
    if (chunk.at === null || chunk.open === -1) continue;
    if (KEYFRAMES_RULES.has(chunk.at)) {
      if (/^-?[A-Za-z_][\w-]*$/.test(chunk.prelude)) {
        out.add(chunk.prelude.replace(KEYFRAMES_SUFFIX_RE, ''));
      }
    } else if (GROUP_AT_RULES.has(chunk.at)) {
      keyframesNames(chunk.text.slice(chunk.open + 1, chunk.block ? -1 : undefined), out);
    }
  }
  return out;
}

/** A rule list held to the drawing (see the section comment). */
function scopeRuleList(css: string, key: string, names: ReadonlySet<string>): string {
  return cssChunks(css)
    .map(chunk => {
      if (chunk.open === -1) {
        if (chunk.at === null || !KEPT_STATEMENTS.has(chunk.at)) return '';
        // Ended by its own `;`, so what follows is never read as part of it.
        return chunk.text.trimEnd().endsWith(';') ? chunk.text : `${chunk.text};`;
      }
      const head = chunk.text.slice(0, chunk.open);
      const body = chunk.text.slice(chunk.open + 1, chunk.block ? -1 : undefined);
      const close = chunk.block ? '}' : '';
      if (chunk.at === null) {
        const lead = /^\s*/.exec(head)?.[0] ?? '';
        const trail = /\s*$/.exec(head.slice(lead.length))?.[0] ?? '';
        const core = head.slice(lead.length, head.length - trail.length);
        if (!core || !closesItsTokens(core)) return '';
        const selectors = splitSelectorList(core).map(s => scopeSelector(s, key));
        // A selector that cannot be held to the drawing drops its rule; so
        // does one that would read back as an at-rule.
        if (selectors.some(s => s === null) || selectors[0]?.startsWith('@')) return '';
        return `${lead}${selectors.join(', ')}${trail}{${scopeAnimationNames(body, names, key)}${close}`;
      }
      if (GROUP_AT_RULES.has(chunk.at)) {
        return `${head}{${scopeRuleList(body, key, names)}${close}`;
      }
      if (KEYFRAMES_RULES.has(chunk.at)) {
        const named = /^(\s*(?:\/\*[\s\S]*?\*\/\s*)*@[-\w]+\s+)(-?[A-Za-z_][\w-]*)(\s*)$/.exec(
          head
        );
        if (!named) return chunk.text;
        return `${named[1]}${keyedName(named[2], names, key)}${named[3]}{${body}${close}`;
      }
      return KEPT_BLOCKS.has(chunk.at) ? chunk.text : '';
    })
    .join('');
}

/** `css` trimmed, keeping one space after a final backslash (it would escape what follows). */
function trimCss(css: string): string {
  const trimmed = css.trim();
  const slashes = /\\+$/.exec(trimmed)?.[0].length ?? 0;
  return slashes % 2 === 1 ? `${trimmed} ` : trimmed;
}

/** As CSS reads it: one kind of newline; a backslash at the very end escapes nothing. */
function preprocessCss(css: string): string {
  const src = css.replace(/\r\n?|\f/g, '\n');
  const trailing = /\\+$/.exec(src)?.[0].length ?? 0;
  return trailing % 2 === 1 ? src.slice(0, -1) : src;
}

/** One sheet held to the drawing with scope `key` (names: the drawing's keyframes). */
export function scopeSvgStyleText(
  css: string,
  key: string,
  names: ReadonlySet<string> = keyframesNames(preprocessCss(css), new Set())
): string {
  if (!css.trim()) return '';
  return trimCss(scopeRuleList(trimCss(preprocessCss(css)), key, names));
}

/** A string hash (cyrb53), base 36: the same in every engine. */
function hashKey(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A drawing's sheets held to it: the sheets' new text, the scope key (null: nothing to scope), the keyframes names. */
export interface ScopedSvgSheets {
  key: string | null;
  sheets: string[];
  names: ReadonlySet<string>;
}

/**
 * All `<style>` sheets of one drawing, scoped together (one key; keyframes
 * defined in one sheet and used in another follow). Idempotent, and the same
 * on the server and in the browser.
 */
export function scopeSvgSheets(sheets: readonly string[]): ScopedSvgSheets {
  const names = new Set<string>();
  for (const css of sheets) keyframesNames(preprocessCss(css), names);
  const canonical = sheets.map(css => scopeSvgStyleText(css, KEY_PLACEHOLDER, names));
  if (canonical.every(css => !css.trim())) return { key: null, sheets: canonical, names };
  const key = `d${hashKey(canonical.join('\u0000'))}`;
  return { key, sheets: sheets.map(css => scopeSvgStyleText(css, key, names)), names };
}

/**
 * In a browser: whether it reads every style rule of the scoped sheet as held
 * to the drawing (each selector naming the scope) — the check behind the text
 * rewrite. True where it can't tell.
 */
function browserReadsAsScoped(css: string, key: string): boolean {
  const g = globalThis as unknown as {
    CSSStyleSheet?: new () => { replaceSync(text: string): void; cssRules: ArrayLike<object> };
  };
  if (typeof g.CSSStyleSheet !== 'function') return true;
  const marks = [`${SVG_SCOPE_ATTR}="${key}"]`, `${SVG_SCOPE_ATTR}=${key}]`];
  const held = (rules: ArrayLike<object>): boolean =>
    Array.from(rules).every(rule => {
      const r = rule as { selectorText?: string; cssRules?: ArrayLike<object>; name?: string };
      if (typeof r.selectorText === 'string') {
        return splitSelectorList(r.selectorText).every(part => marks.some(m => part.includes(m)));
      }
      if (/Keyframes/.test(rule.constructor.name)) return true;
      return r.cssRules ? held(r.cssRules) : true;
    });
  try {
    const sheet = new g.CSSStyleSheet();
    if (typeof sheet.replaceSync !== 'function') return true;
    sheet.replaceSync(css);
    return held(sheet.cssRules);
  } catch {
    return true;
  }
}

/** The outermost `<svg>` elements at or under `root`. */
function outermostSvgs(root: Element): Element[] {
  if (root.namespaceURI === SVG_NS && root.localName === 'svg') return [root];
  return Array.from(root.getElementsByTagNameNS(SVG_NS, 'svg')).filter(svg => {
    for (let el = svg.parentElement; el && el !== root; el = el.parentElement) {
      if (el.namespaceURI === SVG_NS && el.localName === 'svg') return false;
    }
    return true;
  });
}

/**
 * Every drawing at or under `root` (DOM) with its `<style>` sheets held to it:
 * {@link scopeSvgSheets} applied to its sheets, `data-cm-scope` set on its
 * `<svg>` (removed when it has nothing to scope), and its elements' `style`
 * attributes pointed at its keyed keyframes. A sheet the browser would not
 * read as held to the drawing is emptied. Idempotent.
 */
export function scopeSvgStyles(root: Element): void {
  for (const svg of outermostSvgs(root)) {
    const styles = Array.from(svg.getElementsByTagNameNS(SVG_NS, 'style'));
    const scoped = scopeSvgSheets(styles.map(style => style.textContent ?? ''));
    styles.forEach((style, i) => {
      let next = scoped.sheets[i];
      if (scoped.key && next.trim() && !browserReadsAsScoped(next, scoped.key)) next = '';
      if (next !== (style.textContent ?? '')) style.textContent = next;
    });
    if (scoped.key) {
      if (svg.getAttribute(SVG_SCOPE_ATTR) !== scoped.key)
        svg.setAttribute(SVG_SCOPE_ATTR, scoped.key);
    } else if (svg.hasAttribute(SVG_SCOPE_ATTR)) {
      svg.removeAttribute(SVG_SCOPE_ATTR);
    }
    if (scoped.key && scoped.names.size > 0) {
      for (const el of [svg, ...Array.from(svg.querySelectorAll('[style]'))]) {
        const value = el.getAttribute('style');
        if (value === null) continue;
        const next = scopeAnimationNames(value, scoped.names, scoped.key);
        if (next !== value) el.setAttribute('style', next);
      }
    }
  }
}

// ─── Markup builders ─────────────────────────────────────────────────────────

/**
 * The most html one slide may hold, in characters. Deck ops refuse a slide
 * over it (deckOps.ts `MAX_SLIDE_HTML`, pinned equal in the tests); the
 * editor checks before a block edit would cross it.
 */
export const MAX_SLIDE_HTML_LENGTH = 200_000;

/** A block's box on the deck's logical canvas, in px. */
export interface BlockBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A length in px, rounded to 0.01 (no `-0px`). */
export function cssPx(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return `${rounded === 0 ? 0 : rounded}px`;
}

/** The block's inline style, in the browser's own serialization (no rewrite on a round trip). */
export function blockBoxStyle(box: BlockBox): string {
  return (
    `left: ${cssPx(box.left)}; top: ${cssPx(box.top)}; ` +
    `width: ${cssPx(box.width)}; height: ${cssPx(box.height)};`
  );
}

/** A fresh block id: 8 hex chars. */
export function mintBlockId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * An attribute value escaped the way current Chromium serializes one (`&`,
 * `"`, `<`, `>`, U+00A0), so markup built here reads back from the editor
 * byte for byte.
 */
export function escapeBlockAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\u00a0/g, '&nbsp;');
}

/** How an html block's frame fills its block. */
export const HTML_BLOCK_FRAME_STYLE = 'width: 100%; height: 100%; border: 0px;';

/** `<div class="sl-block" …><div class="sl-block-content">inner</div></div>`. */
export function blockMarkup(type: DeckBlockType, id: string, box: BlockBox, inner: string): string {
  return (
    `<div class="sl-block" data-block-type="${type}" ${BLOCK_ID_ATTR}="${escapeBlockAttr(id)}" ` +
    `style="${blockBoxStyle(box)}"><div class="sl-block-content">${inner}</div></div>`
  );
}

/** The frame inside an html block, for `source`. */
export function htmlBlockFrameMarkup(source: string): string {
  return (
    `<iframe sandbox="${HTML_BLOCK_SANDBOX}" allow="${HTML_BLOCK_FRAME_ALLOW}" ` +
    `style="${HTML_BLOCK_FRAME_STYLE}" srcdoc="${escapeBlockAttr(htmlBlockSrcdoc(source))}"></iframe>`
  );
}

/** A whole html block. */
export function htmlBlockMarkup(opts: { id: string; box: BlockBox; source: string }): string {
  return blockMarkup('html', opts.id, opts.box, htmlBlockFrameMarkup(opts.source));
}
