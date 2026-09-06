import * as cheerio from 'cheerio';

import type { DeckJson, DeckSlide } from './deckTypes.ts';

/**
 * Render-time asset rewriting for generated deck HTML.
 *
 * A deck stores its images the way it always has — `/content/{org}/{repo}/{path}`
 * — and the delivery layer turns those into signed URLs at READ time only. This
 * module is the pass that does it, and it is deliberately a DOM pass rather
 * than a string replace: a deck's slide bodies are author-written HTML, and
 * a regex over `src="..."` matches inside `data-*` attributes, inside `<code>`
 * samples, and inside anything else an instructor pasted. Parsing and
 * re-serializing cannot have that class of bug.
 *
 * Six places hold a URL worth rewriting:
 *   - `src`     — images, videos, iframes;
 *   - `href`    — downloadable attachments (and stylesheet links, which the
 *                 caller is expected to exclude — see below);
 *   - `srcset`  — a comma-separated candidate list, each with its own URL;
 *   - `style`   — inline `background-image: url(...)` and friends;
 *   - `data-background-image` — Reveal's slide background, which is a real
 *                 repo asset that happens to be addressed from a `data-*`
 *                 attribute rather than an `<img>`;
 *   - `data-background-video` — same, as a comma-separated source list.
 *
 * `data-background-iframe` is deliberately NOT in that list: it names a PAGE
 * to embed, not an asset in the content repo, and signing it as a blob would
 * point the iframe at a file the Worker serves with the wrong content type.
 *
 * Everything the resolver does not map is left byte-identical. That includes
 * theme stylesheets: a theme is signed as a FOLDER so its relative `url()`
 * references keep working, and rewriting its `<link href>` to a blob URL would
 * break exactly that. The caller's resolver is what declines those.
 */

/** Reveal's slide-background attributes that name a repo asset. */
const BG_IMAGE = 'data-background-image';
const BG_VIDEO = 'data-background-video';

/** Split a `srcset` into its candidates without losing the descriptors. */
function splitSrcSet(value: string): { url: string; descriptor: string }[] {
  return value
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => {
      const space = part.search(/\s/);
      return space === -1
        ? { url: part, descriptor: '' }
        : { url: part.slice(0, space), descriptor: part.slice(space) };
    });
}

/**
 * Split a `data-background-video` source list.
 *
 * Reveal splits this on commas but does NOT trim the pieces (unlike
 * `data-background-image`, which it does trim), so a list written as
 * `a.mp4, b.webm` already depends on the browser tolerating the leading space.
 * We trim deliberately and write the trimmed form back — it is what Reveal
 * would need anyway — and preserve order. A list whose sources all decline is
 * never written back at all (the `changed` flag below), so an untouched deck
 * keeps its original spacing byte for byte.
 */
function splitVideoSources(value: string): string[] {
  return value
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

/** Every `url(...)` in a CSS declaration list, with its quoting preserved. */
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

function cssUrls(style: string): string[] {
  const found: string[] = [];
  for (const match of style.matchAll(CSS_URL)) found.push(match[2].trim());
  return found;
}

function rewriteCssUrls(style: string, map: (ref: string) => string | undefined): string {
  return style.replace(CSS_URL, (whole, quote: string, ref: string) => {
    const next = map(ref.trim());
    return next === undefined ? whole : `url(${quote}${next}${quote})`;
  });
}

/** The attribute selector every pass below scans. One place, one answer. */
const ASSET_SELECTOR =
  '[src], [srcset], [href], [style], [data-background-image], [data-background-video]';

/** Every candidate reference an element carries, in no particular order. */
function elementRefs(attribs: Record<string, string>, out: Set<string>): void {
  const { src, srcset, href, style } = attribs;
  const bgImage = attribs[BG_IMAGE];
  const bgVideo = attribs[BG_VIDEO];
  if (src) out.add(src);
  if (href) out.add(href);
  if (srcset) for (const part of splitSrcSet(srcset)) out.add(part.url);
  if (style) for (const url of cssUrls(style)) out.add(url);
  if (bgImage) out.add(bgImage);
  if (bgVideo) for (const source of splitVideoSources(bgVideo)) out.add(source);
}

/** An element carrying attributes we may rewrite. Cheerio's node, narrowed. */
type AssetElement = { name?: string; attribs: Record<string, string> };

/** What a pass may do to an element beyond swapping URLs for other URLs. */
export interface RewriteElementOptions {
  /**
   * READ side: `<img>` `src` → the responsive set to hang off it.
   *
   * Only `<img>`, and only `src` — never a `data-background-*` attribute.
   * Reveal reads those itself and sets them as a CSS background, where a
   * `srcset` means nothing at all; emitting one there would be dead weight in
   * the markup and a lie about what the browser is going to fetch.
   */
  srcSets?: Map<string, string>;
  /** The `sizes` hint written alongside an emitted `srcset`. */
  sizes?: string;
  /**
   * WRITE side: is this reference one of ours?
   *
   * When it is, the element's `srcset` is REMOVED rather than rewritten. A
   * stored `srcset` is the failure the design forbids — it is a set of derived,
   * expiring, tier-specific URLs frozen into the document — and the read side
   * regenerates one on every render anyway, so there is nothing to preserve.
   * An author's own responsive `<img>` pointing at an external CDN is content
   * and is left exactly as written.
   */
  isOwnRef?: (ref: string) => boolean;
}

/**
 * Apply `map` to every URL-bearing attribute on these elements, in place.
 *
 * Returns whether anything actually changed, which is what lets both callers
 * hand the input string straight back when nothing did — the difference between
 * a no-op pass and re-serializing every deck on every read.
 */
function rewriteElements(
  elements: AssetElement[],
  map: (ref: string) => string | undefined,
  opts: RewriteElementOptions = {}
): boolean {
  let changed = false;

  for (const el of elements) {
    const { src, srcset, href, style } = el.attribs;
    const bgImage = el.attribs[BG_IMAGE];
    const bgVideo = el.attribs[BG_VIDEO];

    const nextSrc = src ? map(src) : undefined;
    if (nextSrc !== undefined) {
      el.attribs['src'] = nextSrc;
      changed = true;
    }

    const nextHref = href ? map(href) : undefined;
    if (nextHref !== undefined) {
      el.attribs['href'] = nextHref;
      changed = true;
    }

    // A stored `srcset` of OURS is dropped, never rewritten — see isOwnRef.
    // One CANDIDATE of ours is enough: a mixed set is not something an author
    // writes, and keeping half of one stores a set the browser cannot assemble.
    //
    // The `src` is deliberately NOT part of this test. It used to be, and that
    // was wrong in the one case that matters: an author writing
    // `<img src="assets/a.png" srcset="https://cdn.example/a@2x.png 2x">` has a
    // repo-relative src and an external set, and treating the src as proof of
    // ownership silently deleted their set. Whose the set is, is a question
    // about the set.
    const isOwnRef = opts.isOwnRef;
    const ownSrcSet =
      srcset !== undefined &&
      isOwnRef !== undefined &&
      splitSrcSet(srcset).some(part => isOwnRef(part.url));

    if (ownSrcSet) {
      delete el.attribs['srcset'];
      delete el.attribs['sizes'];
      changed = true;
    } else if (srcset) {
      const parts = splitSrcSet(srcset);
      if (parts.some(part => map(part.url) !== undefined)) {
        el.attribs['srcset'] = parts
          .map(part => `${map(part.url) ?? part.url}${part.descriptor}`)
          .join(', ');
        changed = true;
      }
    }

    if (style) {
      const nextStyle = rewriteCssUrls(style, map);
      if (nextStyle !== style) {
        el.attribs['style'] = nextStyle;
        changed = true;
      }
    }

    const nextBgImage = bgImage ? map(bgImage) : undefined;
    if (nextBgImage !== undefined) {
      el.attribs[BG_IMAGE] = nextBgImage;
      changed = true;
    }

    if (bgVideo) {
      const sources = splitVideoSources(bgVideo);
      if (sources.some(source => map(source) !== undefined)) {
        el.attribs[BG_VIDEO] = sources.map(source => map(source) ?? source).join(',');
        changed = true;
      }
    }

    // Last, so it reads the ORIGINAL `src` (captured above) and lands on the
    // element after its own rewrite. Never over an existing `srcset`: if one
    // survived to here it is the author's, pointing somewhere we do not own.
    const responsive = src && el.name === 'img' ? opts.srcSets?.get(src) : undefined;
    if (responsive && el.attribs['srcset'] === undefined) {
      el.attribs['srcset'] = responsive;
      if (opts.sizes) el.attribs['sizes'] = opts.sizes;
      changed = true;
    }
  }

  return changed;
}

/**
 * The same rewrite over a FRAGMENT — a stored slide's inner HTML.
 *
 * A separate entry point rather than a flag on the pass below, because the
 * difference is not cosmetic: `cheerio.load` promotes a fragment to a full
 * `<html><head><body>` document, and serializing that back would wrap every
 * rewritten slide in a document. The read path never hit this because it only
 * ever runs on a whole generated deck; the save path runs on slides.
 *
 * Synchronous, because the caller already has its answers.
 */
export function rewriteFragmentAssetUrls(
  html: string,
  map: (ref: string) => string | undefined,
  opts: RewriteElementOptions = {}
): string {
  if (!html) return html;
  const $ = cheerio.load(html, null, false);
  const elements = $(ASSET_SELECTOR).toArray();
  if (elements.length === 0) return html;
  if (!rewriteElements(elements, map, opts)) return html;
  return $.root().html() ?? html;
}

/**
 * Every asset reference in a fragment of deck HTML.
 *
 * Split out from the rewrite because the SAVE path needs the collection and the
 * mapping in two separate steps: it canonicalizes a whole deck's references in
 * one batch and then rewrites every slide against the one answer, rather than
 * paying a lookup round per slide.
 */
export function collectDeckAssetRefs(html: string | null | undefined): string[] {
  if (!html) return [];
  // `false` = parse as a FRAGMENT. A stored slide's `html` is the inner content
  // of its `<section>`, not a document, and the document parser would wrap it.
  // Collection does not serialize, so this only matters for consistency with
  // `rewriteFragmentAssetUrls` — but the two must agree on what an element is.
  const $ = cheerio.load(html, null, false);
  const found = new Set<string>();
  for (const el of $(ASSET_SELECTOR).toArray()) elementRefs(el.attribs, found);
  return [...found];
}

/**
 * The same collection over a slide's `<section>` attributes.
 *
 * A stored slide keeps its section attributes as a plain map rather than as
 * markup, so `data-background-image`, `data-background-video` and `style` never
 * appear in the HTML the pass above walks — they would be silently missed.
 */
export function collectSlideAttrRefs(attrs: Record<string, string> | undefined): string[] {
  if (!attrs) return [];
  const found = new Set<string>();
  elementRefs(attrs, found);
  return [...found];
}

/** Rewrite a slide's `<section>` attribute map; returns it by identity if unchanged. */
export function rewriteSlideAttrs(
  attrs: Record<string, string>,
  map: (ref: string) => string | undefined
): Record<string, string> {
  let next: Record<string, string> | null = null;
  const set = (name: string, value: string) => {
    next = next ?? { ...attrs };
    next[name] = value;
  };

  const bgImage = attrs[BG_IMAGE];
  if (bgImage) {
    const mapped = map(bgImage);
    if (mapped !== undefined) set(BG_IMAGE, mapped);
  }

  const bgVideo = attrs[BG_VIDEO];
  if (bgVideo) {
    const sources = splitVideoSources(bgVideo);
    if (sources.some(source => map(source) !== undefined)) {
      set(BG_VIDEO, sources.map(source => map(source) ?? source).join(','));
    }
  }

  const style = attrs.style;
  if (style) {
    const rewritten = rewriteCssUrls(style, map);
    if (rewritten !== style) set('style', rewritten);
  }

  return next ?? attrs;
}

/**
 * Replace every signed URL of ours in a deck with the repo path behind it.
 *
 * The write-side twin of the read-side rewrite above, and the reason it exists
 * in the SERVICE rather than in a route: a deck reaches storage from the slides
 * editor, from `deck_apply` over MCP, and from an import, and only the first of
 * those ever had a canonicalizing route layer. A signed URL committed into
 * deck.json is a reference that expires and stops following its file — this is
 * the one place that can promise it never happens.
 *
 * `canonicalize` is handed EVERY reference in the deck at once and returns the
 * ones it wants changed; a reference it leaves alone (an external image, a
 * theme file, another classroom's URL) is byte-identical on the way out.
 *
 * Pure: a clone is returned and the input deck is never mutated. Slides with
 * nothing to change keep their original objects.
 */
export async function canonicalizeDeckAssets(
  deck: DeckJson,
  canonicalize: (refs: string[]) => Promise<Map<string, string>>,
  isOwnRef?: (ref: string) => boolean
): Promise<DeckJson> {
  const refs = new Set<string>();
  const collect = (slides: DeckSlide[] | undefined): void => {
    for (const slide of slides ?? []) {
      for (const ref of collectDeckAssetRefs(slide.html)) refs.add(ref);
      for (const ref of collectDeckAssetRefs(slide.notes)) refs.add(ref);
      for (const ref of collectSlideAttrRefs(slide.attrs)) refs.add(ref);
      collect(slide.children);
    }
  };
  collect(deck.slides);
  // Not only the slides. `customCss` is verbatim `<style>` content and can name
  // a background image through `url()`; `extraCss[].href` is a re-emitted
  // `<link rel=stylesheet>`. Both are rewritten on READ like everything else,
  // so both can come back carrying a signed URL — and a stylesheet frozen to an
  // expiring signature breaks a deck's whole look, not one image.
  if (deck.customCss) for (const ref of cssUrls(deck.customCss)) refs.add(ref);
  for (const entry of deck.extraCss ?? []) if (entry.href) refs.add(entry.href);

  if (refs.size === 0) return deck;

  const canonical = await canonicalize([...refs]);
  const map = (ref: string): string | undefined => {
    const next = canonical.get(ref);
    return next === undefined || next === ref ? undefined : next;
  };
  // Dropping a `srcset` is a change even when no URL moved, which is why the
  // predicate rides along rather than being applied in a second pass.
  const opts = isOwnRef ? { isOwnRef } : {};

  // Identity all the way up when nothing moved: each level reports its own
  // change rather than reading a shared flag, so one edited slide at the end of
  // a deck does not make every earlier stack look rewritten.
  const rewrite = (slides: DeckSlide[]): DeckSlide[] => {
    let changed = false;
    const next = slides.map(slide => {
      const html =
        slide.html === undefined ? slide.html : rewriteFragmentAssetUrls(slide.html, map, opts);
      const notes =
        slide.notes === undefined ? slide.notes : rewriteFragmentAssetUrls(slide.notes, map, opts);
      const attrs = slide.attrs === undefined ? slide.attrs : rewriteSlideAttrs(slide.attrs, map);
      const children = slide.children === undefined ? slide.children : rewrite(slide.children);
      if (
        html === slide.html &&
        notes === slide.notes &&
        attrs === slide.attrs &&
        children === slide.children
      ) {
        return slide;
      }
      changed = true;
      return { ...slide, html, notes, attrs, children } as DeckSlide;
    });
    return changed ? next : slides;
  };

  const slides = rewrite(deck.slides);

  const customCss = deck.customCss ? rewriteCssUrls(deck.customCss, map) : deck.customCss;

  let extraCssChanged = false;
  const extraCss = deck.extraCss?.map(entry => {
    const href = entry.href ? map(entry.href) : undefined;
    if (href === undefined) return entry;
    extraCssChanged = true;
    return { ...entry, href };
  });

  if (slides === deck.slides && customCss === deck.customCss && !extraCssChanged) return deck;
  return {
    ...deck,
    slides,
    ...(deck.customCss === undefined ? {} : { customCss }),
    ...(deck.extraCss === undefined ? {} : { extraCss: extraCss as typeof deck.extraCss }),
  };
}

/**
 * Rewrite every asset URL in a deck document that `resolve` has a mapping for.
 *
 * `resolve` is handed every candidate reference at once so the caller can do a
 * single batched lookup, and returns only the ones it wants changed — a
 * reference absent from the returned map is left exactly as it was.
 *
 * Returns the input string untouched when there is nothing to change, so a
 * caller can use it unconditionally without paying a re-serialization.
 */
export async function rewriteDeckAssetUrls(
  html: string,
  resolve: (refs: string[]) => Promise<Map<string, string>>,
  opts: { srcSets?: (refs: string[]) => Promise<Map<string, string>>; sizes?: string } = {}
): Promise<string> {
  if (!html) return html;

  const $ = cheerio.load(html);
  const candidates = new Set<string>();

  const elements = $(ASSET_SELECTOR).toArray();

  for (const el of elements) elementRefs(el.attribs, candidates);

  if (candidates.size === 0) return html;

  // ORDER IS PART OF THE CONTRACT: `resolve` runs first, and `opts.srcSets`
  // second, so a caller may answer the second from whatever the first computed.
  // That is how the deck read path gets both out of ONE asset-map read under
  // one clock instead of resolving the same references twice.
  const resolved = await resolve([...candidates]);

  // Asked for only where a set could be used: the `src` of an `<img>`. A deck
  // full of backgrounds and links therefore pays nothing for this.
  const imageSrcs = elements
    .filter(el => el.name === 'img' && el.attribs.src)
    .map(el => el.attribs.src);
  const srcSetsByRef = opts.srcSets && imageSrcs.length > 0 ? await opts.srcSets(imageSrcs) : null;

  if (resolved.size === 0 && !srcSetsByRef?.size) return html;

  const map = (ref: string): string | undefined => {
    const next = resolved.get(ref);
    return next === undefined || next === ref ? undefined : next;
  };

  // Keyed by the STORED reference, which is what the emit step looks up: it
  // reads the `src` the element arrived with, not the one it leaves with.
  if (!rewriteElements(elements, map, { srcSets: srcSetsByRef ?? undefined, sizes: opts.sizes })) {
    return html;
  }

  // A full document keeps its doctype/head. A FRAGMENT does not survive as a
  // fragment — cheerio promotes one to a full `<html><head><body>` document on
  // parse, and serializing the root gives that back. What keeps a fragment
  // caller safe is the `changed` short-circuit above: a document with nothing
  // to rewrite is returned as the caller's own string, never re-serialized.
  return $.root().html() ?? html;
}
