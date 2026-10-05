/**
 * The `<section>` markup of a deck, as a plain string, with no cheerio and no
 * Node imports — so the slides editor can render a live document in the
 * browser. Mirrors `renderSection` in packages/services/src/slides/deckHtml.ts
 * byte for byte (a test pins the two against every deck fixture).
 */
import type { DeckJson, DeckSlide } from '@classmoji/services/slides';

const ATTR_NAME_RE = /^[a-zA-Z][\w:-]*$/;
const EVENT_ATTR_RE = /^on/i;
// eslint-disable-next-line no-control-regex -- browsers ignore these inside a URL scheme
const URL_NOISE_RE = /[\u0000-\u0020\u007f]/g;

/** A `javascript:` URL, however it is spaced or cased. */
export function isScriptUrl(value: string): boolean {
  return value.replace(URL_NOISE_RE, '').toLowerCase().startsWith('javascript:');
}

/**
 * Whether an attribute may be put on an element the editor renders: a valid
 * name, no event handler, no `javascript:` value. Display-time only — what is
 * stored is never rewritten by this.
 */
export function isRenderableAttr(name: string, value: string): boolean {
  return ATTR_NAME_RE.test(name) && !EVENT_ATTR_RE.test(name) && !isScriptUrl(value);
}

export function escapeAttrValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface RenderSectionOptions {
  /** Emit `<aside class="notes">` (default true). */
  includeNotes?: boolean;
  /** Rewrite a leaf slide's html before it is emitted (e.g. sign media refs). */
  mapHtml?: (html: string, slide: DeckSlide) => string;
}

/** The opening tag's attributes: data-cm-id, data-hidden, then attrs in order. */
export function sectionAttrString(slide: DeckSlide): string {
  let attrStr = ` data-cm-id="${escapeAttrValue(slide.id)}"`;
  if (slide.hidden) attrStr += ' data-hidden="true"';
  for (const [name, value] of Object.entries(slide.attrs ?? {})) {
    if (!ATTR_NAME_RE.test(name) || EVENT_ATTR_RE.test(name)) continue;
    attrStr += ` ${name}="${escapeAttrValue(value)}"`;
  }
  return attrStr;
}

export function renderSlideSection(slide: DeckSlide, opts: RenderSectionOptions = {}): string {
  const includeNotes = opts.includeNotes ?? true;
  const attrStr = sectionAttrString(slide);
  const aside =
    includeNotes && slide.notes != null ? `<aside class="notes">${slide.notes}</aside>` : '';
  if (slide.children && slide.children.length > 0) {
    const inner = slide.children.map(child => renderSlideSection(child, opts)).join('\n');
    return `<section${attrStr}>\n${inner}\n${aside ? `${aside}\n` : ''}</section>`;
  }
  const html = slide.html ?? '';
  return `<section${attrStr}>${opts.mapHtml ? opts.mapHtml(html, slide) : html}${aside}</section>`;
}

/** Every section of the deck, newline-joined — the body of `<div class="slides">`. */
export function renderDeckSections(deck: DeckJson, opts: RenderSectionOptions = {}): string {
  return deck.slides.map(slide => renderSlideSection(slide, opts)).join('\n');
}

/**
 * Classes the slides editor puts on a `.sl-block` while a person works on it
 * (BlockHandles: double-click to edit text, or code in a Sandpack). Editor
 * state, never content.
 */
export const EDITOR_BLOCK_CLASSES = ['editing', 'editing-code'] as const;

const CLASS_ATTR_RE = /\sclass="([^"]*)"/g;

/**
 * `html` with the editor's transient `.sl-block` classes removed (string
 * level; elements without `sl-block` untouched). Html that has none comes
 * back unchanged, byte for byte.
 */
export function stripEditorBlockState(html: string): string {
  if (!html.includes('sl-block') || !/\bediting/.test(html)) return html;
  return html.replace(CLASS_ATTR_RE, (whole, value: string) => {
    const tokens = value.split(/\s+/).filter(Boolean);
    if (!tokens.includes('sl-block')) return whole;
    const kept = tokens.filter(t => !(EDITOR_BLOCK_CLASSES as readonly string[]).includes(t));
    return kept.length === tokens.length ? whole : ` class="${kept.join(' ')}"`;
  });
}
