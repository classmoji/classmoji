/**
 * safeMarkup/rules.ts — what slide markup may contain on display: the element
 * and attribute lists and the URL rule, as data and pure predicates.
 *
 * No runtime imports beyond deckBlocks.ts (itself import-free), so the
 * browser engine (client.ts) and the cheerio engine (server.ts) read the same
 * lists through the same walker (walk.ts).
 *
 * The svg element/attribute lists are deckBlocks.ts's svg-block lists, used
 * for every inline `<svg>`; outside svg blocks `foreignObject` is also kept
 * (its children are held to the html rules) and svg links may also be
 * relative or `http:`.
 */

import {
  isAllowedSvgAnimation,
  isAllowedSvgAttr,
  isAllowedSvgElement,
  isAllowedSvgLink,
  isBlockedFrameAttr,
} from '../deckBlocks.ts';

export const HTML_NS = 'http://www.w3.org/1999/xhtml';
export const SVG_NS = 'http://www.w3.org/2000/svg';
export const XLINK_NS = 'http://www.w3.org/1999/xlink';

// ─── Elements ────────────────────────────────────────────────────────────────

/** Html elements kept (with their listed attributes). Lowercase local names. */
export const ALLOWED_HTML_ELEMENTS: ReadonlySet<string> = new Set([
  // sections and grouping
  'section',
  'aside',
  'article',
  'header',
  'footer',
  'nav',
  'main',
  'address',
  'hgroup',
  'search',
  'div',
  'p',
  'hr',
  'pre',
  'blockquote',
  'figure',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'menu',
  'dl',
  'dt',
  'dd',
  'details',
  'summary',
  'dialog',
  'center',
  // text-level
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'big',
  'br',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'time',
  'tt',
  'u',
  'var',
  'wbr',
  // embedded
  'img',
  'picture',
  'source',
  'track',
  'video',
  'audio',
  'iframe',
  'canvas',
  'map',
  'area',
  // tables
  'table',
  'caption',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  // controls (inert without script; `form` itself is unwrapped)
  'label',
  'input',
  'button',
  'select',
  'option',
  'optgroup',
  'datalist',
  'textarea',
  'fieldset',
  'legend',
  'output',
  'progress',
  'meter',
  // styling and data (rules below)
  'style',
  'link',
  'script',
]);

/**
 * Elements removed with everything inside them. `script` is here and kept
 * only as a data block ({@link isKeptScriptType}); `link` only as a
 * stylesheet ({@link isKeptLink}).
 */
export const DROPPED_HTML_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'template',
  'noscript',
  'noembed',
  'noframes',
  'xmp',
  'plaintext',
  'object',
  'embed',
  'param',
  'applet',
  'base',
  'meta',
  'frameset',
  'frame',
  'portal',
  'fencedframe',
  'title',
  'isindex',
  'keygen',
  'link',
]);

/** Elements replaced by their children (remove mode). */
export const UNWRAPPED_HTML_ELEMENTS: ReadonlySet<string> = new Set(['form']);

/** Script `type`s that are data, never code (Sandpack files, highlight templates). */
export const KEPT_SCRIPT_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'text/template',
]);

/** Whether a `<script>` with this `type` stays (as data): the trimmed, lowercased type is listed. */
export function isKeptScriptType(type: string | null | undefined): boolean {
  if (type == null) return false;
  return KEPT_SCRIPT_TYPES.has(type.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase());
}

/** Whether a `<link>` stays: `rel="stylesheet"` with an `https:` or relative `href`. */
export function isKeptLink(
  rel: string | null | undefined,
  href: string | null | undefined
): boolean {
  if ((rel ?? '').trim().toLowerCase() !== 'stylesheet' || href == null) return false;
  const url = parseSafeUrl(href);
  return url !== null && (url.relative || url.protocol === 'https:');
}

/** Whether an svg-namespace element may stay (the svg-block lists, plus `foreignObject` outside svg blocks). */
export function isAllowedSvgNode(
  localName: string,
  attrs: ReadonlyArray<readonly [string, string]>,
  inSvgBlock: boolean
): boolean {
  const name = localName.toLowerCase();
  const listed = isAllowedSvgElement(name, SVG_NS) || (!inSvgBlock && name === 'foreignobject');
  return listed && isAllowedSvgAnimation(name, attrs);
}

/** The block an element is, from its attributes: `.sl-block[data-block-type="html"|"svg"]`. */
export function blockTypeOf(
  attrs: ReadonlyArray<readonly [string, string]>
): 'html' | 'svg' | null {
  let isBlock = false;
  let type: string | null = null;
  for (const [name, value] of attrs) {
    if (name === 'class') isBlock = value.split(/[\t\n\f\r ]+/).includes('sl-block');
    else if (name === 'data-block-type') type = value;
  }
  return isBlock && (type === 'html' || type === 'svg') ? type : null;
}

// ─── Attributes ──────────────────────────────────────────────────────────────

/** Attribute names a browser would treat as one (the rest are kept or renamed only if they match). */
export const ATTR_NAME_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;

/** On every html element. `aria-*` and `data-*` are handled by {@link isAllowedHtmlAttr}. */
export const GLOBAL_ATTRS: ReadonlySet<string> = new Set([
  'class',
  'style',
  'id',
  'title',
  'lang',
  'dir',
  'role',
  'hidden',
  'tabindex',
  'translate',
  'draggable',
  'spellcheck',
  'contenteditable',
  'inert',
  // presentational leftovers decks still carry
  'align',
  'valign',
  'width',
  'height',
  'bgcolor',
  'color',
  'border',
]);

const MEDIA_ATTRS = [
  'src',
  'controls',
  'autoplay',
  'loop',
  'muted',
  'preload',
  'crossorigin',
  'controlslist',
];

/** Per-element attributes beyond {@link GLOBAL_ATTRS}. */
export const ELEMENT_ATTRS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  (
    [
      ['a', ['href', 'target', 'rel', 'download', 'hreflang', 'type', 'referrerpolicy']],
      ['area', ['href', 'target', 'rel', 'download', 'alt', 'shape', 'coords', 'referrerpolicy']],
      ['map', ['name']],
      [
        'img',
        [
          'src',
          'srcset',
          'sizes',
          'alt',
          'loading',
          'decoding',
          'crossorigin',
          'referrerpolicy',
          'fetchpriority',
          'usemap',
          'ismap',
        ],
      ],
      ['source', ['src', 'srcset', 'sizes', 'type', 'media']],
      ['track', ['src', 'kind', 'srclang', 'label', 'default']],
      ['video', [...MEDIA_ATTRS, 'poster', 'playsinline', 'disablepictureinpicture']],
      ['audio', MEDIA_ATTRS],
      [
        'iframe',
        [
          'src',
          'srcdoc',
          'allow',
          'allowfullscreen',
          'sandbox',
          'loading',
          'referrerpolicy',
          'frameborder',
          'scrolling',
          'marginwidth',
          'marginheight',
        ],
      ],
      ['blockquote', ['cite']],
      ['q', ['cite']],
      ['del', ['cite', 'datetime']],
      ['ins', ['cite', 'datetime']],
      ['time', ['datetime']],
      ['data', ['value']],
      ['ol', ['start', 'reversed', 'type']],
      ['ul', ['type']],
      ['li', ['value', 'type']],
      ['details', ['open']],
      ['dialog', ['open']],
      ['font', ['face', 'size']],
      ['bdo', ['dir']],
      ['table', ['cellpadding', 'cellspacing', 'summary', 'frame', 'rules']],
      ['col', ['span']],
      ['colgroup', ['span']],
      ['td', ['colspan', 'rowspan', 'headers', 'scope', 'abbr', 'nowrap']],
      ['th', ['colspan', 'rowspan', 'headers', 'scope', 'abbr', 'nowrap']],
      ['label', ['for']],
      [
        'input',
        [
          'type',
          'name',
          'value',
          'checked',
          'disabled',
          'readonly',
          'required',
          'placeholder',
          'min',
          'max',
          'step',
          'size',
          'maxlength',
          'minlength',
          'multiple',
          'pattern',
          'list',
          'autocomplete',
          'alt',
          'src',
        ],
      ],
      ['button', ['type', 'name', 'value', 'disabled']],
      ['select', ['name', 'multiple', 'disabled', 'size', 'required']],
      ['option', ['value', 'selected', 'disabled', 'label']],
      ['optgroup', ['label', 'disabled']],
      [
        'textarea',
        [
          'name',
          'rows',
          'cols',
          'placeholder',
          'disabled',
          'readonly',
          'required',
          'maxlength',
          'wrap',
        ],
      ],
      ['fieldset', ['disabled', 'name']],
      ['output', ['for', 'name']],
      ['progress', ['value', 'max']],
      ['meter', ['value', 'min', 'max', 'low', 'high', 'optimum']],
      ['style', ['media']],
      ['link', ['rel', 'href', 'media', 'type', 'crossorigin', 'referrerpolicy']],
      ['script', ['type']],
    ] as Array<[string, string[]]>
  ).map(([tag, attrs]) => [tag, new Set(attrs)])
);

/** Attributes dropped wherever they appear (`srcdoc` survives only on html-block frames). */
export const DROPPED_ATTRS: ReadonlySet<string> = new Set([
  'formaction',
  'form',
  'ping',
  'srcdoc',
  'autofocus',
  'nonce',
  'is',
  // Reveal renders these as html (speaker notes, external markdown)
  'data-notes',
  'data-markdown',
]);

/**
 * Attributes holding a URL a browser or Reveal will load or navigate to.
 * `values`/`to`/`from` on svg animations are judged with the element
 * (deckBlocks `isAllowedSvgAnimation`).
 */
export const URL_ATTRS: ReadonlySet<string> = new Set([
  'href',
  'src',
  'srcset',
  'action',
  'poster',
  'cite',
  'xlink:href',
  'data-src',
  'data-background',
  'data-background-image',
  'data-background-video',
  'data-background-iframe',
  'data-preview-link',
  'data-preview-image',
  'data-preview-video',
  'data-cm-src',
]);

/** `data:` image types an image source may carry (never `svg+xml`). */
const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp|avif)[;,]/i;

/** Where a `data:` image is accepted: `[element, attribute]`, `*` for any element. */
function acceptsDataImage(tag: string, attr: string): boolean {
  if (attr === 'data-background-image') return true;
  return (tag === 'img' || tag === 'input') && (attr === 'src' || attr === 'data-src');
}

/** A classroom media reference (`media://{uuid}`), resolved by the read surfaces. */
const MEDIA_REF_RE =
  /^media:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[?#]|$)/i;

const URL_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

// Every C0 control, DEL, and the three characters that end an attribute or a tag.
// eslint-disable-next-line no-control-regex -- the point is to find them
const URL_FORBIDDEN_RE = /[\u0000-\u001f\u007f"<>]/;
// eslint-disable-next-line no-control-regex -- browsers strip these around a URL
const URL_TRIM_RE = /^[\u0000- ]+|[\u0000- ]+$/g;
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const URL_BASE = 'https://base.invalid/';

interface ParsedUrl {
  /** No scheme: resolved against the page. */
  relative: boolean;
  /** Lowercase `scheme:` ('' for relative). */
  protocol: string;
  /** The trimmed value. */
  value: string;
}

/** The value as a URL, or null when it holds a control character, `"`, `<` or `>`, or does not parse. */
function parseSafeUrl(raw: string): ParsedUrl | null {
  const value = raw.replace(URL_TRIM_RE, '');
  if (URL_FORBIDDEN_RE.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value, URL_BASE);
  } catch {
    return null;
  }
  const scheme = SCHEME_RE.exec(value);
  if (!scheme) {
    // No scheme of its own: the parser must agree it resolved against the base.
    return parsed.protocol === 'https:' ? { relative: true, protocol: '', value } : null;
  }
  const protocol = `${scheme[1].toLowerCase()}:`;
  if (parsed.protocol !== protocol) return null;
  return { relative: false, protocol, value };
}

/**
 * Whether a URL value may stay on attribute `attr` of element `tag`: relative,
 * `http:`, `https:`, `mailto:`, a `media://{uuid}` reference, `about:blank`,
 * or (image sources only) a `data:image/png|jpeg|gif|webp|avif` URL. Empty is
 * fine (it loads nothing new).
 */
export function isSafeUrl(value: string, tag: string, attr: string): boolean {
  if (value.replace(URL_TRIM_RE, '') === '') return true;
  const url = parseSafeUrl(value);
  if (!url) return false;
  if (url.relative || URL_SCHEMES.has(url.protocol)) return true;
  if (url.protocol === 'media:') return MEDIA_REF_RE.test(url.value);
  if (url.protocol === 'about:') return url.value.toLowerCase() === 'about:blank';
  if (url.protocol === 'data:') return acceptsDataImage(tag, attr) && DATA_IMAGE_RE.test(url.value);
  return false;
}

/** A `srcset` whose every candidate URL passes {@link isSafeUrl}. */
export function isSafeSrcset(value: string, tag: string): boolean {
  // eslint-disable-next-line no-control-regex -- see URL_FORBIDDEN_RE
  if (/[\u0000-\u001f\u007f"<>]/.test(value.replace(/[\t\n\f\r]/g, ' '))) return false;
  return value
    .split(',')
    .map(candidate => candidate.trim().split(/\s+/)[0] ?? '')
    .every(url => url === '' || isSafeUrl(url, tag, 'srcset'));
}

/** Prefixes of element ids the app uses for its own elements; slide ids that start with one get {@link RESERVED_ID_REPLACEMENT_PREFIX}. */
export const RESERVED_ID_PREFIXES: readonly string[] = ['cm-', '__', 'sentry-'];

/** Put in front of a slide id that would collide with the app's ids. */
export const RESERVED_ID_REPLACEMENT_PREFIX = 'user-';

/** The id a slide element may show: the same, or prefixed out of the app's reserved space. */
export function safeElementId(id: string): string {
  const lower = id.toLowerCase();
  return RESERVED_ID_PREFIXES.some(prefix => lower.startsWith(prefix))
    ? `${RESERVED_ID_REPLACEMENT_PREFIX}${id}`
    : id;
}

/** `name` lands on `document` for these (named access), so they never carry one. */
const NAMED_ACCESS_ELEMENTS: ReadonlySet<string> = new Set([
  'img',
  'iframe',
  'embed',
  'object',
  'form',
]);

/** Where an element sits, as far as the attribute rules care. */
export interface AttrContext {
  /** Lowercase local name. */
  tag: string;
  /** Inside (or itself) `.sl-block[data-block-type="html"]`. */
  inHtmlBlock: boolean;
  /** The element's `sandbox` value (frames). */
  sandbox: string | null;
}

/** What happens to one attribute. */
export type AttrVerdict =
  | { keep: true; value?: string }
  | {
      keep: false;
      /** stored-form inert name (html-block frame rule) instead of the session one */ storedInert?: boolean;
    };

const KEEP: AttrVerdict = { keep: true };
const DROP: AttrVerdict = { keep: false };

/**
 * The verdict for attribute `name` (lowercase qualified name) with `value` on
 * an html element.
 */
export function htmlAttrVerdict(name: string, value: string, ctx: AttrContext): AttrVerdict {
  const { tag } = ctx;
  if (!ATTR_NAME_RE.test(name) || name.startsWith('on')) return DROP;

  // Html-block frames: the deckBlocks rule (sources inert under an unsafe
  // sandbox, `allow` pinned to fullscreen), in the stored inert form.
  if (ctx.inHtmlBlock && isBlockedFrameAttr(tag, name, ctx.sandbox, true, value)) {
    return { keep: false, storedInert: true };
  }
  if (name === 'srcdoc') {
    // Only an html block's own frame (it passed the rule above).
    return tag === 'iframe' && ctx.inHtmlBlock ? KEEP : DROP;
  }
  if (DROPPED_ATTRS.has(name)) return DROP;
  if (name === 'name' && NAMED_ACCESS_ELEMENTS.has(tag)) return DROP;

  const listed =
    GLOBAL_ATTRS.has(name) ||
    name.startsWith('aria-') ||
    name.startsWith('data-') ||
    (ELEMENT_ATTRS.get(tag)?.has(name) ?? false);
  if (!listed) return DROP;

  if (name === 'srcset') return isSafeSrcset(value, tag) ? KEEP : DROP;
  if (URL_ATTRS.has(name)) {
    // `data-preview-link` may be valueless (the element's own href).
    return isSafeUrl(value, tag, name) ? KEEP : DROP;
  }
  if (name === 'id') {
    const safe = safeElementId(value);
    return safe === value ? KEEP : { keep: true, value: safe };
  }
  return KEEP;
}

/**
 * The verdict for attribute `name` (qualified, e.g. `xlink:href`) on an svg
 * element: the svg-block list, with links outside svg blocks also allowed by
 * the general URL rule.
 */
export function svgAttrVerdict(
  name: string,
  value: string,
  localName: string,
  inSvgBlock: boolean
): AttrVerdict {
  const lower = name.toLowerCase();
  if (!ATTR_NAME_RE.test(name) || lower.startsWith('on')) return DROP;
  if (DROPPED_ATTRS.has(lower)) return DROP;
  if (isAllowedSvgAttr(name, value)) {
    if (lower === 'id') {
      const safe = safeElementId(value);
      return safe === value ? KEEP : { keep: true, value: safe };
    }
    return KEEP;
  }
  const local = lower.replace(/^xlink:/, '');
  if (!inSvgBlock && (local === 'href' || local === 'src') && !isAllowedSvgLink(value)) {
    return isSafeUrl(value, localName.toLowerCase(), local) ? KEEP : DROP;
  }
  return DROP;
}

// ─── Rename mode (editor) ────────────────────────────────────────────────────

/** Prefix of every inert name: `data-cm-inert-<name>` (stored) and `data-cm-inert-<marker>-<name>` (one editor session). */
export const INERT_PREFIX = 'data-cm-inert-';

/** Marks a `<template>` holding a node hidden for one editor session (value: the marker). */
export const INERT_NODE_ATTR = 'data-cm-inert-node';

/** A session marker: lowercase letters and digits, starting with a letter. */
export const SESSION_MARKER_RE = /^[a-z][a-z0-9]{7,31}$/;

/** A fresh, unguessable marker for this page load's renamed markup. */
export function newSessionMarker(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return `m${Array.from(bytes, b => alphabet[b % alphabet.length]).join('')}`;
}

/** The session-inert name for `name`. */
export function sessionInertName(marker: string, name: string): string {
  return `${INERT_PREFIX}${marker}-${name}`;
}

/** On an element that stands in for one renamed for display (`form`): the original tag. */
export function sessionTagAttr(marker: string): string {
  return `${INERT_PREFIX}${marker}--tag`;
}

/** Elements the editor shows under another tag, restorable by {@link sessionTagAttr}. */
export const RETAGGED_ELEMENTS: ReadonlySet<string> = new Set(['form']);
