/**
 * slideBlocks.ts — the editor's DOM helpers for svg and html blocks, the slide
 * overview's thumbnails and its slide keys, and the slide a delete aims at.
 *
 * Pure DOM, no React: the unit suite runs it under jsdom. The block formats
 * and their rules live in `@classmoji/services/slides/runtime-attrs`
 * (deckBlocks.ts); this module only applies them in the editor.
 */
import {
  HTML_BLOCK_SELECTOR,
  INERT_ATTR_PREFIX,
  isAllowedSvgAttr,
  sanitizeSvgTree,
} from '@classmoji/services/slides/runtime-attrs';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The drawing a new svg block starts with (`currentColor`, so Colour applies). */
export const DEFAULT_SVG_SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120" width="100%" height="100%" ' +
  'preserveAspectRatio="xMidYMid meet">' +
  '<rect x="10" y="10" width="180" height="100" rx="14" fill="none" stroke="currentColor" ' +
  'stroke-width="4"></rect>' +
  '<circle cx="60" cy="60" r="26" fill="currentColor" opacity="0.25"></circle>' +
  '<path d="M100 85 L130 35 L160 85 Z" fill="currentColor"></path>' +
  '</svg>';

/** The source a new html block starts with. */
export const STARTER_HTML_SOURCE = `<!DOCTYPE html>
<html>
<head>
<style>
  html, body { margin: 0; height: 100%; }
  body { display: grid; place-items: center; font-family: system-ui, sans-serif; }
</style>
</head>
<body>
  <button id="b">Clicked 0 times</button>
  <script>
    let n = 0;
    const b = document.getElementById('b');
    b.addEventListener('click', () => { b.textContent = 'Clicked ' + ++n + ' times'; });
  </script>
</body>
</html>
`;

/** `preserveAspectRatio` for each Fit choice. */
export const SVG_FIT_VALUES = {
  meet: 'xMidYMid meet',
  slice: 'xMidYMid slice',
  none: 'none',
} as const;
export type SvgFit = keyof typeof SVG_FIT_VALUES;

/** The Fit choice an `<svg>` is set to (meet when unset or unrecognised). */
export function svgFitOf(svg: Element | null): SvgFit {
  const value = (svg?.getAttribute('preserveAspectRatio') ?? '').trim();
  if (value === 'none') return 'none';
  if (/\bslice\b/.test(value)) return 'slice';
  return 'meet';
}

export type SvgSourceResult = { ok: true; svg: SVGSVGElement } | { ok: false; error: string };

/**
 * An svg block's `<svg>` from source text (a file, the source editor): exactly
 * one `<svg>`, held to the svg-block lists, sized 100% × 100%, a viewBox from
 * numeric width/height when it has none, `xMidYMid meet` unless it says
 * otherwise. The same normalization the server applies
 * (`normalizeSvgBlockSource`), with the DOM. Imported into `doc`.
 */
export function svgFromSource(text: string, doc: Document): SvgSourceResult {
  const parsed = new (doc.defaultView?.DOMParser ?? DOMParser)().parseFromString(
    text.trim(),
    'image/svg+xml'
  );
  const root = parsed.documentElement;
  if (
    !root ||
    parsed.getElementsByTagName('parsererror').length > 0 ||
    root.localName !== 'svg' ||
    root.namespaceURI !== SVG_NS
  ) {
    return { ok: false, error: 'Needs exactly one <svg> element' };
  }
  const svg = doc.importNode(root, true) as unknown as SVGSVGElement;
  for (const attr of Array.from(svg.attributes)) {
    if (!isAllowedSvgAttr(attr.name, attr.value)) svg.removeAttribute(attr.name);
  }
  sanitizeSvgTree(svg);
  if (!svg.hasAttribute('viewBox')) {
    const numeric = (v: string | null) => v != null && /^\s*[\d.]+(?:px)?\s*$/.test(v);
    const wAttr = svg.getAttribute('width');
    const hAttr = svg.getAttribute('height');
    const w = parseFloat(wAttr ?? '');
    const h = parseFloat(hAttr ?? '');
    if (numeric(wAttr) && numeric(hAttr) && w > 0 && h > 0) {
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
  }
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  if (!svg.hasAttribute('preserveAspectRatio')) {
    svg.setAttribute('preserveAspectRatio', SVG_FIT_VALUES.meet);
  }
  return { ok: true, svg };
}

/** The `<svg>` an svg block shows, if any. */
export function svgOfBlock(block: Element): SVGSVGElement | null {
  const content = block.querySelector(':scope > .sl-block-content');
  return (content?.querySelector(':scope > svg') ?? null) as SVGSVGElement | null;
}

/** The frame an html block shows, if any. */
export function frameOfBlock(block: Element): HTMLIFrameElement | null {
  const content = block.querySelector(':scope > .sl-block-content');
  return (content?.querySelector('iframe') ?? null) as HTMLIFrameElement | null;
}

/**
 * An html block frame's srcdoc as stored: the live attribute, or the inert
 * one when the frame was kept from loading for display.
 */
export function storedSrcdoc(frame: Element): string {
  return frame.getAttribute('srcdoc') ?? frame.getAttribute(`${INERT_ATTR_PREFIX}srcdoc`) ?? '';
}

// ─── Overview thumbnails ────────────────────────────────────────────────────

/** Attributes that make a frame load a document. */
const FRAME_SOURCE_ATTRS = ['srcdoc', 'src', 'data-src', 'data'];

/**
 * A slide's markup for a thumbnail: a copy in which no frame inside an html
 * block loads (each source attribute renamed to `data-cm-inert-*`; the
 * overview's CSS shows a placeholder in its place). The live slide is never
 * touched.
 */
export function thumbnailHtml(section: Element): string {
  const clone = section.cloneNode(true) as Element;
  const frames = clone.querySelectorAll(
    `${HTML_BLOCK_SELECTOR} iframe, ${HTML_BLOCK_SELECTOR} object, ${HTML_BLOCK_SELECTOR} embed`
  );
  for (const frame of Array.from(frames)) {
    const attrs = Array.from(frame.attributes);
    if (!attrs.some(a => FRAME_SOURCE_ATTRS.includes(a.name.toLowerCase()))) continue;
    const entries = attrs.map(a =>
      FRAME_SOURCE_ATTRS.includes(a.name.toLowerCase())
        ? ([`${INERT_ATTR_PREFIX}${a.name}`, a.value] as const)
        : ([a.name, a.value] as const)
    );
    for (const a of attrs) frame.removeAttribute(a.name);
    for (const [name, value] of entries) {
      // An attribute already inert on the live slide keeps its name.
      if (!frame.hasAttribute(name)) frame.setAttribute(name, value);
    }
  }
  return clone.innerHTML;
}

// ─── Slide keys (overview) ──────────────────────────────────────────────────

/**
 * Stable keys for slide `<section>`s: the slide's `data-cm-id` when it has
 * one (live editing), otherwise a per-element id that lasts as long as the
 * element. A key never follows a position, so a slide inserted elsewhere
 * cannot move a key onto another slide.
 */
export interface SlideKeyer {
  /** Keys for `sections` in order; a repeated `data-cm-id` falls back to the element id. */
  keysFor(sections: readonly Element[]): string[];
  /** The key `el` had when last keyed (or would get now). */
  keyOf(el: Element): string;
}

export function createSlideKeyer(): SlideKeyer {
  const local = new WeakMap<Element, string>();
  let next = 0;
  const localKey = (el: Element): string => {
    let key = local.get(el);
    if (!key) {
      key = `el-${++next}`;
      local.set(el, key);
    }
    return key;
  };
  const keyOf = (el: Element): string => {
    const id = el.getAttribute('data-cm-id');
    return id ? `id-${id}` : localKey(el);
  };
  return {
    keyOf,
    keysFor(sections) {
      const seen = new Set<string>();
      return sections.map(el => {
        let key = keyOf(el);
        if (seen.has(key)) key = localKey(el);
        seen.add(key);
        return key;
      });
    },
  };
}

/** Leaf slides and stack wrappers under a Reveal `.slides` element, in order. */
export function slideSections(slidesEl: Element): Element[] {
  const out: Element[] = [];
  for (const top of Array.from(slidesEl.children)) {
    if (top.localName !== 'section') continue;
    out.push(top);
    for (const kid of Array.from(top.children)) if (kid.localName === 'section') out.push(kid);
  }
  return out;
}

// ─── The slide a delete aims at ─────────────────────────────────────────────

/** A slide as captured when a delete was asked for. */
export interface SlideTarget {
  element: Element;
  /** Its `data-cm-id` at capture time (live editing), or null. */
  id: string | null;
}

export function captureSlideTarget(element: Element | null | undefined): SlideTarget | null {
  if (!element) return null;
  return { element, id: element.getAttribute('data-cm-id') };
}

/**
 * The slide to delete for a captured target, or null when it is gone: no
 * longer in the deck (`slidesEl`), or — when it had an id — no longer the
 * element carrying that id. Never another slide.
 */
export function resolveDeleteTarget(
  target: SlideTarget | null,
  slidesEl: Element | null
): Element | null {
  if (!target || !slidesEl) return null;
  const { element, id } = target;
  if (!element.isConnected || !slidesEl.contains(element) || element === slidesEl) return null;
  if (element.localName !== 'section') return null;
  if (id !== null && element.getAttribute('data-cm-id') !== id) return null;
  return element;
}

/** How many leaf slides `slidesEl` holds (stacks count their children). */
export function countLeafSlides(slidesEl: Element): number {
  let count = 0;
  for (const top of Array.from(slidesEl.children)) {
    if (top.localName !== 'section') continue;
    const kids = Array.from(top.children).filter(k => k.localName === 'section').length;
    count += kids > 0 ? kids : 1;
  }
  return count;
}

/**
 * Take a leaf slide out of the deck DOM: a stack left empty goes with it.
 * Returns the element removed (the slide, or its emptied stack).
 */
export function removeSlideElement(slide: Element): Element {
  const parent = slide.parentElement;
  if (parent && parent.localName === 'section') {
    const siblings = Array.from(parent.children).filter(k => k.localName === 'section');
    if (siblings.length <= 1) {
      parent.remove();
      return parent;
    }
  }
  slide.remove();
  return slide;
}
