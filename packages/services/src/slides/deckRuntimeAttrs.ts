/**
 * deckRuntimeAttrs.ts — the single source of truth for "what Reveal paints on a
 * <section> at runtime and must never persist into deck.json" (issue #361).
 *
 * ZERO runtime imports on purpose. deckHtml.ts pulls in cheerio and
 * node:crypto, so the slides editor's client-side diff
 * (apps/slides/app/utils/deckOpsDiff.ts) cannot import it — yet that diff has
 * to strip EXACTLY what the server parser strips or an untouched slide reads
 * as edited. This module is therefore browser-safe and published as
 * `@classmoji/services/slides/runtime-attrs`, and every stripper (server
 * parser, client diff, merge signature, MCP deck ops, and the load/save
 * boundaries in slideContent.service) goes through it.
 *
 * What Reveal writes on sections at runtime:
 *  - `style.top` on EVERY section when `config.center` is true (reveal.js
 *    `layout()`, js/reveal.js:832-857) — a viewport-dependent pixel value, and
 *    a literal `0px` on vertical-stack containers. Both editor and viewer set
 *    `center: true`, so every serialized deck picked this up.
 *  - `style.left` + `style.top` while laying out the print view
 *    (js/controllers/printview.js:109-110).
 *  - `style.display` (`none` / `block`) as slides come in and out of view.
 *  - `data-fragment` (js/controllers/fragments.js), `data-previous-indexv`
 *    (js/reveal.js `setPreviousVerticalIndex`), and `data-index-h` /
 *    `data-index-v` (js/controllers/overview.js).
 *  - the `present` / `past` / `future` / `stack` classes, the
 *    `has-dark-background` / `has-light-background` contrast class every
 *    themed background earns (js/controllers/backgrounds.js:193-197,
 *    `getContrastClass`), plus `hidden` and `aria-hidden`.
 *
 * Author-set neighbours that must SURVIVE: `data-start-indexv`,
 * `data-fragment-index`, `data-background-*`, `data-transition`, and every
 * style property other than the three above (`margin`, `margin-left`,
 * colours, …).
 */

import type { DeckJson, DeckSlide } from './deckTypes.ts';

/**
 * Runtime paint the Reveal viewer / editor leaves in a section's class list.
 * `editing-mode` and `slide-hidden` are ours (editor chrome), the rest
 * Reveal's. Matching is case-sensitive — Reveal only ever writes these exact
 * strings, and an author's differently-cased class is their own.
 */
export const RUNTIME_SECTION_CLASSES: ReadonlySet<string> = new Set([
  'editing-mode',
  'slide-hidden',
  'stack',
  'present',
  'past',
  'future',
  'has-dark-background',
  'has-light-background',
]);

/** Section attributes Reveal computes at runtime — never authored. */
export const RUNTIME_SECTION_ATTRS: ReadonlySet<string> = new Set([
  'data-fragment',
  'data-previous-indexv',
  'data-index-h',
  'data-index-v',
]);

/** Inline style properties Reveal computes at runtime — never authored. */
const RUNTIME_STYLE_PROP_RE = /^(?:display|top|left)\s*:/i;

/**
 * Split a style attr on TOP-LEVEL `;` — quotes and parens respected, so
 * `background: url(data:image/png;base64,AAA)` and `url("a;b.png")` survive
 * intact. deckHtml's canonicalStyleAttr shares this scanner.
 */
export function splitStyleDeclarations(style: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < style.length; i++) {
    const ch = style[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < style.length) {
        current += style[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ';' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

/**
 * Drop the runtime-computed declarations from a style attribute value, keeping
 * every other inline style and the canonical `'p1; p2;'` join format the
 * parsers have always produced. Returns null when nothing author-set is left
 * (the caller drops the `style` attribute entirely).
 */
export function stripRuntimeStyleProps(style: string): string | null {
  const props = splitStyleDeclarations(style)
    .map(p => p.trim())
    .filter(p => p !== '' && !RUNTIME_STYLE_PROP_RE.test(p));
  return props.length > 0 ? props.join('; ') + ';' : null;
}

/**
 * Normalize a section's attribute record: runtime classes, runtime attributes,
 * runtime style declarations and `hidden` / `aria-hidden` removed; everything
 * else (including `data-cm-id` / `data-hidden`, which callers handle
 * themselves) untouched. Pure — the input record is not mutated.
 */
export function stripRuntimeSectionAttrs(
  attrs: Readonly<Record<string, string>>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs)) {
    const lower = name.toLowerCase();
    if (lower === 'hidden' || lower === 'aria-hidden') continue;
    if (RUNTIME_SECTION_ATTRS.has(lower)) continue;
    if (lower === 'class') {
      const kept = (value ?? '')
        .split(/\s+/)
        .filter(c => c !== '' && !RUNTIME_SECTION_CLASSES.has(c));
      if (kept.length > 0) out[name] = kept.join(' ');
      continue;
    }
    if (lower === 'style') {
      const cleaned = stripRuntimeStyleProps(value ?? '');
      if (cleaned != null) out[name] = cleaned;
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** One slide (and its stack children) with runtime paint removed. */
function stripSlideRuntimeAttrs(slide: DeckSlide): DeckSlide {
  const next: DeckSlide = { ...slide };
  if (slide.attrs) {
    const attrs = stripRuntimeSectionAttrs(slide.attrs);
    if (Object.keys(attrs).length > 0) next.attrs = attrs;
    else delete next.attrs;
  }
  if (slide.children) next.children = slide.children.map(stripSlideRuntimeAttrs);
  return next;
}

/**
 * A whole deck with Reveal's runtime paint removed from every slide, stack
 * containers and their children included. Pure — the input deck is untouched.
 *
 * Applied at BOTH content boundaries (slideContent.service loadDeck and
 * saveDeck), which is what makes the cleanup total: a deck that was stored
 * before the strip landed reads back clean, so an accepted preview cannot
 * re-write stale paint into a clean main, an ops save cannot preserve it on
 * slides the user never touched, `deck_get` cannot echo it, and no render
 * re-bakes it into index.html.
 */
export function stripDeckRuntimeAttrs(deck: DeckJson): DeckJson {
  return { ...deck, slides: deck.slides.map(stripSlideRuntimeAttrs) };
}
