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

/**
 * Whether attribute `name` of an element named `tagName` must not render,
 * given the element's `sandbox` and whether it sits inside an html block.
 * Shared by the DOM pass below and the cheerio pass in deckHtml.ts.
 */
export function isBlockedFrameAttr(
  tagName: string,
  name: string,
  sandbox: string | null | undefined,
  insideHtmlBlock: boolean
): boolean {
  if (!insideHtmlBlock) return false;
  const tag = tagName.toLowerCase();
  const sources = FRAME_SOURCE_ATTRS.get(tag);
  if (!sources || !sources.has(name.toLowerCase())) return false;
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
    el.closest(HTML_BLOCK_SELECTOR) !== null
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
 * Hold every descendant of `root` to the svg-block lists (DOM): elements off
 * the list are removed with everything inside them, as are comments and
 * processing instructions; attributes off the list are dropped. `root` itself
 * keeps its element and loses only event handlers (it is the block content
 * wrapper, or an `<svg>`).
 */
export function sanitizeSvgTree(root: Element): void {
  for (const attr of Array.from(root.attributes)) {
    if (attr.name.toLowerCase().startsWith('on')) root.removeAttribute(attr.name);
  }
  const visit = (parent: Element): void => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 1) {
        const el = node as Element;
        if (
          !isAllowedSvgElement(el.localName, el.namespaceURI) ||
          hasCaseTwins(el) ||
          !isAllowedSvgAnimation(el.localName, attrPairs(el))
        ) {
          el.remove();
          continue;
        }
        for (const attr of Array.from(el.attributes)) {
          if (!isAllowedSvgAttr(attr.name, attr.value)) el.removeAttribute(attr.name);
        }
        visit(el);
      } else if (node.nodeType !== 3) {
        // Comments, CDATA, processing instructions: nothing an svg block needs.
        node.parentNode?.removeChild(node);
      }
    }
  };
  visit(root);
}

/**
 * Every svg block under `root` held to the lists (DOM). The block and its
 * `.sl-block-content` keep their own attributes (minus handlers); any other
 * child of the block is removed.
 */
export function sanitizeSvgBlocks(root: Element | Document | DocumentFragment): void {
  const blocks = Array.from(root.querySelectorAll(SVG_BLOCK_SELECTOR));
  if ((root as Element).matches?.(SVG_BLOCK_SELECTOR)) blocks.unshift(root as Element);
  for (const block of blocks) {
    for (const attr of Array.from(block.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) block.removeAttribute(attr.name);
    }
    for (const child of Array.from(block.childNodes)) {
      const isContent =
        child.nodeType === 1 && (child as Element).classList.contains('sl-block-content');
      if (isContent) sanitizeSvgTree(child as Element);
      else if (child.nodeType !== 3) child.parentNode?.removeChild(child);
    }
  }
}

// ─── Markup builders ─────────────────────────────────────────────────────────

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
    `<iframe sandbox="${HTML_BLOCK_SANDBOX}" allow="fullscreen" ` +
    `style="${HTML_BLOCK_FRAME_STYLE}" srcdoc="${escapeBlockAttr(htmlBlockSrcdoc(source))}"></iframe>`
  );
}

/** A whole html block. */
export function htmlBlockMarkup(opts: { id: string; box: BlockBox; source: string }): string {
  return blockMarkup('html', opts.id, opts.box, htmlBlockFrameMarkup(opts.source));
}
