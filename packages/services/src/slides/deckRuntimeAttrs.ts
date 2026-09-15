/**
 * deckRuntimeAttrs.ts — the single source of truth for "what Reveal paints on a
 * <section> at runtime and must never persist into deck.json" (issue #361).
 *
 * ZERO imports on purpose. deckHtml.ts pulls in cheerio and node:crypto, so the
 * slides editor's client-side diff (apps/slides/app/utils/deckOpsDiff.ts)
 * cannot import it — yet that diff has to strip EXACTLY what the server parser
 * strips or an untouched slide reads as edited. This module is therefore
 * browser-safe and published as `@classmoji/services/slides/runtime-attrs`, and
 * every stripper (server parser, client diff, merge signature, MCP deck ops)
 * goes through it.
 *
 * What Reveal writes on sections at runtime:
 *  - `style.top` on EVERY section when `config.center` is true (reveal.js
 *    `layout()`, js/reveal.js:832-857) — a viewport-dependent pixel value, and
 *    a literal `0px` on vertical-stack containers. Both editor and viewer set
 *    `center: true`, so every serialized deck picked this up.
 *  - `style.display` (`none` / `block`) as slides come in and out of view.
 *  - `data-fragment` (js/controllers/fragments.js), `data-previous-indexv`
 *    (js/reveal.js `setPreviousVerticalIndex`), and `data-index-h` /
 *    `data-index-v` (js/controllers/overview.js).
 *  - the `present` / `past` / `future` / `stack` classes, plus `hidden` and
 *    `aria-hidden`.
 *
 * Author-set neighbours that must SURVIVE: `data-start-indexv`,
 * `data-fragment-index`, `data-background-*`, `data-transition`, and every
 * style property other than the two above (`margin`, colours, …).
 */

/**
 * Runtime paint the Reveal viewer / editor leaves in a section's class list.
 * `editing-mode` and `slide-hidden` are ours (editor chrome), the rest Reveal's.
 */
export const RUNTIME_SECTION_CLASSES: ReadonlySet<string> = new Set([
  'editing-mode',
  'slide-hidden',
  'stack',
  'present',
  'past',
  'future',
]);

/** Section attributes Reveal computes at runtime — never authored. */
export const RUNTIME_SECTION_ATTRS: ReadonlySet<string> = new Set([
  'data-fragment',
  'data-previous-indexv',
  'data-index-h',
  'data-index-v',
]);

/** Inline style properties Reveal computes at runtime — never authored. */
const RUNTIME_STYLE_PROP_RE = /^(?:display|top)\s*:/i;

/**
 * Drop the runtime-computed declarations from a style attribute value, keeping
 * every other inline style and the canonical `'p1; p2;'` join format the
 * parsers have always produced. Returns null when nothing author-set is left
 * (the caller drops the `style` attribute entirely).
 */
export function stripRuntimeStyleProps(style: string): string | null {
  const props = style
    .split(';')
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
