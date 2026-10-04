/**
 * deckHtml.ts — the canonical deck rendering/parsing engine (content-tools plan §2).
 *
 * Pure functions only: no service imports, no network, no database. Shared
 * theme URLs are resolved by callers and passed in via opts — the renderer
 * never calls services.
 *
 * Unifies the three historical generators:
 *   - editor canonical  (apps/slides/app/routes/$slideId/route.tsx generateSlideHtml)
 *   - slides.com import (apps/slides/app/utils/slidesComImporter.server.ts —
 *     light/dark media link pair, 960/700/center:false, sl-block override style)
 *   - starter template  (apps/slides/app/utils/slideHelpers.server.ts —
 *     monokai via the reveal plugin path, inline style, no data-theme)
 *
 * Round-trip invariants (test contract, plan §2):
 *   - parse(generate(parse(F))) ≡ parse(F) for all fixtures (semantic idempotence)
 *   - generate(parse(generate(d))) === generate(d) byte-equal on the parse image
 */

import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { randomBytes } from 'node:crypto';
// Runtime paint the Reveal viewer / editor leaves on sections — the classes,
// the computed `top` / `display` style, the `data-index-*` family — is
// stripped by both parsers so `attrs` is deterministic between saves (plan §2,
// issue #361). The list lives in deckRuntimeAttrs.ts, the browser-safe module
// the slides client imports so the two strippers can never drift.
import { splitStyleDeclarations, stripRuntimeSectionAttrs } from './deckRuntimeAttrs.ts';
import {
  BLOCK_ID_ATTR,
  HTML_BLOCK_FRAME_SELECTOR,
  HTML_BLOCK_SELECTOR,
  INERT_ATTR_PREFIX,
  SVG_BLOCK_SELECTOR,
  cssPx,
  htmlBlockFrameMarkup,
  htmlBlockSource,
  isAllowedSvgAnimation,
  isAllowedSvgAttr,
  isAllowedSvgElement,
  isBlockedFrameAttr,
  type BlockBox,
} from './deckBlocks.ts';
import type { DeckConfig, DeckExtraCss, DeckJson, DeckSlide } from './deckTypes.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const BUILTIN_THEMES = [
  'black',
  'white',
  'league',
  'beige',
  'night',
  'serif',
  'simple',
  'solarized',
  'moon',
  'dracula',
  'sky',
  'blood',
] as const;

const REVEAL_VERSION = '5.1.0';
const HIGHLIGHT_VERSION = '11.9.0';

const MEDIA_LIGHT = '(prefers-color-scheme: light)';
const MEDIA_DARK = '(prefers-color-scheme: dark)';
const MEDIA_FALLBACK = 'not all and (prefers-color-scheme)';

/** Shared-theme assets live under this folder in the content repo. */
const THEMES_FOLDER = '.slidesthemes';

/** Attribute names must look like real HTML attribute names. */
const ATTR_NAME_RE = /^[a-zA-Z][\w:-]*$/;

/**
 * Event-handler attribute names (onclick, onerror, ONLoad, …) are denied on
 * sections in BOTH directions — dropped by the generator and stripped by the
 * parsers — so the two surfaces converge and section attrs can never carry
 * script handlers. `style` stays (legitimately used).
 */
const EVENT_ATTR_RE = /^on/i;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/** Typed parse failure — callers fall back to legacy behavior; never write an empty deck. */
export class DeckParseError extends Error {
  code = 'DECK_PARSE_FAILED' as const;
  warnings: string[];

  constructor(message: string, warnings: string[] = []) {
    super(message);
    this.name = 'DeckParseError';
    this.warnings = warnings;
  }
}

/** Typed rejection for slide-fragment HTML that would corrupt sibling sections. */
export class SlideHtmlError extends Error {
  code = 'INVALID_SLIDE_HTML' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SlideHtmlError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Default id generator: 8 hex chars, crypto-random. Injectable for tests. */
export function mintSlideId(): string {
  return randomBytes(4).toString('hex');
}

export type IdGenerator = () => string;

function mintUnique(idGen: IdGenerator, used: Set<string>): string {
  let id = idGen();
  // Guard against generator collisions (or a seeded generator that repeats).
  let guard = 0;
  while (used.has(id) && guard < 1000) {
    id = idGen();
    guard++;
  }
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolved URLs for non-builtin themes. The CALLER resolves these (via
 * getThemeUrls or equivalent) — the renderer never calls services. Proxy URLs
 * are root-relative, so services-side generation needs no base URL.
 */
export interface DeckThemeUrls {
  /** For 'shared:*' themes: the lib CSS (fonts, base styles). */
  libCssUrl?: string | null;
  /** For 'shared:*' themes: custom-theme.css when the theme has one. */
  customThemeUrl?: string | null;
  /** For 'shared:*' themes: body classes from the theme manifest. */
  bodyClasses?: string;
  /** For 'custom:*' themes: URL of the custom CSS file, when resolvable. */
  themeUrl?: string | null;
}

export interface GenerateDeckOptions {
  /** Document title (from the slide DB row). */
  title: string;
  /** Resolved URLs for shared:/custom: themes (caller-resolved). */
  themeUrls?: DeckThemeUrls;
  /** false → omit all `<aside class="notes">` (rendering convenience, not a security boundary). */
  includeNotes?: boolean;
  /**
   * true → also emit {@link SL_BLOCK_CSS}, for a document a browser opens ON
   * ITS OWN (the thumbnail and render-view routes). The stored index.html
   * never carries it: the viewer, presenter and editor lift `.slides` into the
   * slides app, whose global.css already positions blocks.
   */
  standalone?: boolean;
}

/**
 * The slides app's draggable-block rules (apps/slides/app/styles/global.css,
 * "SL-BLOCK SYSTEM"), minus the editing-mode chrome. An `.sl-block` carries
 * only left/top/width/height inline; without `position: absolute` it falls
 * into normal flow and the slide stacks. The image rule undoes the theme's
 * `.reveal img { max-width: 95% }`, which would shrink cropped block images.
 * Keep in step with global.css.
 */
export const SL_BLOCK_CSS =
  '.reveal section{position:relative}' +
  '.sl-block{position:absolute;box-sizing:border-box;contain:layout}' +
  '.sl-block-content{width:100%;height:100%;overflow:visible}' +
  ".reveal .sl-block[data-block-type='image'] .sl-block-content img{max-width:none}";

function builtinThemeUrl(theme: string): string {
  const name = (BUILTIN_THEMES as readonly string[]).includes(theme) ? theme : 'white';
  return `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/dist/theme/${name}.css`;
}

function highlightThemeUrl(codeTheme: string): string {
  return `https://cdn.jsdelivr.net/npm/highlight.js@${HIGHLIGHT_VERSION}/styles/${codeTheme}.min.css`;
}

function linkLine(href: string, media?: string): string {
  return `  <link rel="stylesheet" href="${escapeAttr(href)}"${media ? ` media="${escapeAttr(media)}"` : ''}>`;
}

function renderSection(slide: DeckSlide, includeNotes: boolean): string {
  let attrStr = ` data-cm-id="${escapeAttr(slide.id)}"`;
  if (slide.hidden) {
    attrStr += ' data-hidden="true"';
  }
  for (const [name, value] of Object.entries(slide.attrs ?? {})) {
    if (!ATTR_NAME_RE.test(name)) {
      // Not a security boundary (staff HTML is trusted + already public) but a
      // hostile/odd attr name must not break document parseability.
      console.warn(`[deckHtml] Dropping invalid attribute name '${name}' on slide ${slide.id}`);
      continue;
    }
    if (EVENT_ATTR_RE.test(name)) {
      console.warn(
        `[deckHtml] Dropping event-handler attribute '${name}' on slide ${slide.id} — section attrs must not carry script handlers`
      );
      continue;
    }
    attrStr += ` ${name}="${escapeAttr(value)}"`;
  }

  // Notes re-emitted as the LAST child, exactly `<aside class="notes">…</aside>`
  // (double quotes — the view-path strip regex depends on this shape).
  const aside =
    includeNotes && slide.notes != null ? `<aside class="notes">${slide.notes}</aside>` : '';

  if (slide.children && slide.children.length > 0) {
    const inner = slide.children.map(child => renderSection(child, includeNotes)).join('\n');
    return `<section${attrStr}>\n${inner}\n${aside ? `${aside}\n` : ''}</section>`;
  }

  // The block rules run over html and notes together: an unclosed block in
  // the html would otherwise take the notes into it.
  return `<section${attrStr}>${secureSlideBlocksInHtml(`${slide.html ?? ''}${aside}`)}</section>`;
}

/**
 * Generate the complete reveal.js index.html document for a deck.
 *
 * Rules (plan §2):
 * - Emits NO implicit styles — the sl-block visibility override lives in
 *   `customCss` (seeded at import), starter styling seeded at create. The
 *   one exception is opt-in: `standalone` adds the block-positioning rules
 *   for routes that open the document outside the slides app.
 * - themeDark/codeThemeDark → light/dark/`not all` media link trio, else a
 *   single canonical link.
 * - Builtin themes via jsDelivr reveal.js@5.1.0; shared:/custom: themes via
 *   opts.themeUrls (caller-resolved).
 * - `data-cm-id` emitted on every section.
 * - Config keys go into Reveal.initialize only when set (canonical defaults:
 *   hash:true, controls:true, progress:true, center:true, transition:'slide').
 */
export function generateDeckHtml(deck: DeckJson, opts: GenerateDeckOptions): string {
  const { title, themeUrls, includeNotes = true, standalone = false } = opts;
  const theme = deck.theme || 'white';
  const codeTheme = deck.codeTheme || 'github';

  // Theme links
  const themeLinks: string[] = [];
  if (theme.startsWith('shared:')) {
    if (themeUrls?.libCssUrl) {
      themeLinks.push(linkLine(themeUrls.libCssUrl));
    } else {
      console.warn(
        `[deckHtml] Shared theme '${theme}' has no resolved libCssUrl — emitting no theme links`
      );
    }
    if (themeUrls?.customThemeUrl) {
      themeLinks.push(linkLine(themeUrls.customThemeUrl));
    }
  } else if (theme.startsWith('custom:')) {
    // Custom themes are loaded dynamically by the viewer when no URL is
    // resolved (parity with the editor's canonical generator).
    if (themeUrls?.themeUrl) {
      themeLinks.push(linkLine(themeUrls.themeUrl));
    }
  } else if (deck.themeDark) {
    const lightUrl = builtinThemeUrl(theme);
    const darkUrl = builtinThemeUrl(deck.themeDark);
    themeLinks.push(
      linkLine(lightUrl, MEDIA_LIGHT),
      linkLine(darkUrl, MEDIA_DARK),
      linkLine(lightUrl, MEDIA_FALLBACK)
    );
  } else {
    themeLinks.push(linkLine(builtinThemeUrl(theme)));
  }

  // Code syntax highlighting links
  const codeLinks: string[] = [];
  if (deck.codeThemeDark) {
    const lightUrl = highlightThemeUrl(codeTheme);
    const darkUrl = highlightThemeUrl(deck.codeThemeDark);
    codeLinks.push(
      linkLine(lightUrl, MEDIA_LIGHT),
      linkLine(darkUrl, MEDIA_DARK),
      linkLine(lightUrl, MEDIA_FALLBACK)
    );
  } else {
    codeLinks.push(linkLine(highlightThemeUrl(codeTheme)));
  }

  const headLines: string[] = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `  <title>${escapeHtml(title)}</title>`,
    `  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/dist/reveal.css">`,
    ...themeLinks,
    ...codeLinks,
  ];

  // Before the deck's own CSS, so a deck can still override a block rule.
  if (standalone) {
    headLines.push(`  <style data-cm-standalone>${SL_BLOCK_CSS}</style>`);
  }
  if (deck.customCss != null) {
    headLines.push(`  <style>${deck.customCss}</style>`);
  }
  for (const extra of deck.extraCss ?? []) {
    headLines.push(linkLine(extra.href, extra.media));
  }
  headLines.push('</head>');

  const bodyClasses = themeUrls?.bodyClasses ?? '';
  const bodyTag = bodyClasses ? `<body class="${escapeAttr(bodyClasses)}">` : '<body>';

  const sections = deck.slides.map(slide => renderSection(slide, includeNotes)).join('\n');

  // Reveal.initialize config: canonical defaults are not stored in deck.json,
  // so fill them back in here; width/height emitted only when set.
  const config = deck.config ?? {};
  const center = config.center ?? true;
  const transition = (config.transition ?? 'slide').replace(/'/g, "\\'");
  const configLines: string[] = [
    '      hash: true,',
    '      controls: true,',
    '      progress: true,',
    `      center: ${center},`,
    `      transition: '${transition}',`,
  ];
  if (config.width != null) configLines.push(`      width: ${config.width},`);
  if (config.height != null) configLines.push(`      height: ${config.height},`);
  configLines.push('      plugins: [RevealHighlight]');

  return [
    ...headLines,
    bodyTag,
    `  <div class="reveal" data-theme="${escapeAttr(theme)}" data-code-theme="${escapeAttr(codeTheme)}">`,
    '    <div class="slides">',
    sections,
    '    </div>',
    '  </div>',
    `  <script src="https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/dist/reveal.js"></script>`,
    `  <script src="https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/plugin/highlight/highlight.js"></script>`,
    '  <script>',
    '    Reveal.initialize({',
    ...configLines,
    '    });',
    '  </script>',
    '</body>',
    '</html>',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser — shared section core
// ─────────────────────────────────────────────────────────────────────────────

interface ParseContext {
  $: CheerioAPI;
  idGen: IdGenerator;
  usedIds: Set<string>;
  warnings: string[];
}

export interface ParseOptions {
  /** Injectable id generator (seeded in tests for determinism). */
  idGen?: IdGenerator;
}

function hasNotesClass(el: Element): boolean {
  const cls = el.attribs?.['class'] ?? '';
  return cls.split(/\s+/).includes('notes');
}

/**
 * Reveal paints `visible` / `current-fragment` on `.fragment` descendants at
 * runtime (as the presenter steps through fragments). They are never authored
 * and must never persist — otherwise a merely-VIEWED slide's read-back html
 * differs from its stored form and phantom-conflicts / phantom-diffs. Mirrors
 * the client strips (deckOpsDiff cleanupContainer, RevealSlides
 * getCurrentContent). `fragment` itself is authored content and stays.
 */
function stripFragmentRuntimeClasses($root: Cheerio<AnyNode>): void {
  $root.find('.fragment').removeClass('visible').removeClass('current-fragment');
}

/**
 * Strip runtime paint from a section element (plan §2 cruft list) — the
 * element-level wrapper around the shared record normalizer, so the parser and
 * the editor's client-side diff can never drift apart.
 */
function stripRuntimeCruft($el: Cheerio<Element>): void {
  stripFragmentRuntimeClasses($el);
  const el = $el[0];
  if (!el) return;
  const before = el.attribs ?? {};
  const after = stripRuntimeSectionAttrs(before);
  for (const name of Object.keys(before)) {
    if (!(name in after)) $el.removeAttr(name);
  }
  for (const [name, value] of Object.entries(after)) {
    if (before[name] !== value) $el.attr(name, value);
  }
}

function resolveSectionId(attribs: Record<string, string>, ctx: ParseContext): string {
  const raw = attribs['data-cm-id'];
  delete attribs['data-cm-id'];
  if (raw && !ctx.usedIds.has(raw)) {
    ctx.usedIds.add(raw);
    return raw;
  }
  if (raw) {
    ctx.warnings.push(`Duplicate data-cm-id '${raw}' — re-minted`);
  }
  const id = mintUnique(ctx.idGen, ctx.usedIds);
  ctx.usedIds.add(id);
  return id;
}

function sectionToSlide(el: Element, ctx: ParseContext): DeckSlide {
  const { $ } = ctx;
  const $el = $(el);
  stripRuntimeCruft($el);

  const childSections = $el.children('section');
  const isContainer = childSections.length > 0;

  // Children first: recursion extracts each child's notes, so any aside left
  // afterwards whose closest section is this element belongs to the container.
  const children = isContainer
    ? childSections.toArray().map(child => sectionToSlide(child, ctx))
    : undefined;

  // Notes: tolerant match (any attr order/quoting; class list contains
  // 'notes'), multiple asides concatenated with '\n'.
  const asides = $el
    .find('aside')
    .toArray()
    .filter(aside => hasNotesClass(aside) && $(aside).parents('section')[0] === el);
  const notes =
    asides.length > 0 ? asides.map(aside => browserFormHtml($, $(aside))).join('\n') : undefined;
  for (const aside of asides) {
    $(aside).remove();
  }

  if (isContainer) {
    // Containers carry no html — warn if non-section content would be discarded.
    const strayText = $el
      .contents()
      .toArray()
      .filter(node => {
        if (node.type === 'text') return (node.data ?? '').trim() !== '';
        if (node.type === 'tag') return (node as Element).tagName !== 'section';
        return false;
      });
    if (strayText.length > 0) {
      ctx.warnings.push('Non-section content inside a vertical stack container was discarded');
    }
  }

  // Attribute snapshot AFTER cruft strip + aside removal.
  const attribs: Record<string, string> = { ...el.attribs };
  // Event-handler attributes are stripped (the generator drops them too — the
  // two surfaces must converge, plan §2 round-trip invariants).
  for (const name of Object.keys(attribs)) {
    if (EVENT_ATTR_RE.test(name)) {
      delete attribs[name];
      ctx.warnings.push(`Event-handler attribute '${name}' stripped from a section`);
    }
  }
  const id = resolveSectionId(attribs, ctx);
  const hidden = attribs['data-hidden'] === 'true';
  delete attribs['data-hidden'];

  const slide: DeckSlide = { id };
  if (!isContainer) {
    slide.html = browserFormHtml($, $el);
  }
  if (notes !== undefined) slide.notes = notes;
  if (hidden) slide.hidden = true;
  if (Object.keys(attribs).length > 0) slide.attrs = attribs;
  if (isContainer) slide.children = children;
  return slide;
}

function parseSections(rootSections: Element[], ctx: ParseContext): DeckSlide[] {
  return rootSections.map(el => sectionToSlide(el, ctx));
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser — theme link classification (media-aware, plan §2)
// ─────────────────────────────────────────────────────────────────────────────

interface LinkCandidate {
  name: string;
  media?: string;
}

const REVEAL_CORE_RE = /reveal\.js@[^/]+\/dist\/reveal(?:\.min)?\.css/;

/** A signed delivery theme folder: `/c/{classroomId}/theme/{name}/{treeSha}/...`. */
const DELIVERY_THEME_HREF =
  /\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/theme\//;

const BUILTIN_THEME_RE = /reveal\.js@[^/]+\/dist\/theme\/([\w-]+?)(?:\.min)?\.css/;
// Recognizes BOTH highlight.js styles AND the reveal plugin path (the starter
// links monokai via `reveal.js@*/plugin/highlight/monokai.css`).
const HIGHLIGHT_RE = /highlight\.js@[^/]+\/styles\/([\w.-]+?)(?:\.min)?\.css/;
const REVEAL_PLUGIN_HIGHLIGHT_RE = /reveal\.js@[^/]+\/plugin\/highlight\/([\w.-]+?)(?:\.min)?\.css/;

interface ThemeSlots {
  light?: string;
  dark?: string;
}

function resolveSlots(
  candidates: LinkCandidate[],
  kindLabel: string,
  warnings: string[]
): ThemeSlots {
  const slots: ThemeSlots = {};
  for (const cand of candidates) {
    const media = cand.media?.trim() ?? '';
    if (media.startsWith('not all')) {
      // `not all` fallback links (no-prefers-color-scheme browsers) are
      // consumed silently — regenerated from the light slot.
      continue;
    }
    if (media.includes('prefers-color-scheme: dark')) {
      if (slots.dark === undefined) {
        slots.dark = cand.name;
      } else {
        warnings.push(`Extra dark ${kindLabel} link '${cand.name}' dropped`);
      }
    } else if (media === '' || media.includes('prefers-color-scheme: light')) {
      if (slots.light === undefined) {
        slots.light = cand.name;
      } else {
        warnings.push(`Extra ${kindLabel} link '${cand.name}' dropped`);
      }
    } else {
      warnings.push(`${kindLabel} link '${cand.name}' with unrecognized media '${media}' dropped`);
    }
  }
  return slots;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseDeckHtml
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedDeck {
  deck: DeckJson;
  warnings: string[];
}

/**
 * Parse a full reveal.js index.html document (any of the three generator
 * variants + hand-edited decks) into a DeckJson.
 *
 * @throws {DeckParseError} when the document has zero root sections.
 */
export function parseDeckHtml(html: string, opts: ParseOptions = {}): ParsedDeck {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const ctx: ParseContext = {
    $,
    idGen: opts.idGen ?? mintSlideId,
    usedIds: new Set(),
    warnings,
  };

  const $reveal = $('div.reveal').first();
  const declaredTheme = $reveal.attr('data-theme');
  const declaredCodeTheme = $reveal.attr('data-code-theme');
  const declared = declaredTheme ?? '';
  const declaredIsSharedOrCustom = declared.startsWith('shared:') || declared.startsWith('custom:');

  // ── Stylesheet link classification (media-aware) ──
  const themeCandidates: LinkCandidate[] = [];
  const codeCandidates: LinkCandidate[] = [];
  const extraCss: DeckExtraCss[] = [];

  $('link[rel="stylesheet"]')
    .toArray()
    .forEach(el => {
      const href = el.attribs['href'] ?? '';
      const media = el.attribs['media'];
      if (REVEAL_CORE_RE.test(href)) return; // structural, always regenerated

      const themeMatch = href.match(BUILTIN_THEME_RE);
      if (themeMatch) {
        themeCandidates.push({
          name: themeMatch[1],
          ...(media ? { media } : {}),
        });
        return;
      }
      const hlMatch = href.match(HIGHLIGHT_RE) ?? href.match(REVEAL_PLUGIN_HIGHLIGHT_RE);
      if (hlMatch) {
        codeCandidates.push({ name: hlMatch[1], ...(media ? { media } : {}) });
        return;
      }
      // Shared-theme assets are regenerated from caller-resolved themeUrls.
      // Both shapes count: the content-proxy path, and a signed delivery theme
      // folder (`/c/{classroomId}/theme/...`), which carries no `.slidesthemes/`
      // segment at all. Missing the second would park an expiring signed URL in
      // `extraCss` — a stored signature, which is the one thing the delivery
      // layer exists to prevent.
      if (
        declared.startsWith('shared:') &&
        (href.includes(`${THEMES_FOLDER}/`) || DELIVERY_THEME_HREF.test(href))
      ) {
        return;
      }
      // Custom-theme file link (when the generator emitted one) — regenerated.
      if (declared.startsWith('custom:')) {
        const file = declared.slice('custom:'.length);
        if (file && (href === file || href.endsWith(`/${file}`))) {
          return;
        }
      }
      extraCss.push({ href, ...(media ? { media } : {}) });
    });

  // Builtin/highlight-shaped links never land in extraCss: they either fill a
  // theme slot or are dropped with a warning (stale links must not shadow
  // future theme changes).
  let themeSlots: ThemeSlots = {};
  if (declaredIsSharedOrCustom) {
    for (const cand of themeCandidates) {
      warnings.push(
        `Builtin theme link '${cand.name}' does not fit declared theme '${declared}' — dropped`
      );
    }
  } else {
    themeSlots = resolveSlots(themeCandidates, 'theme', warnings);
  }
  const codeSlots = resolveSlots(codeCandidates, 'code theme', warnings);

  // Missing data-theme → infer from links, else 'white'.
  const theme = declaredTheme ?? themeSlots.light ?? 'white';
  const themeDark = declaredIsSharedOrCustom ? undefined : themeSlots.dark;
  const codeTheme = declaredCodeTheme ?? codeSlots.light ?? 'github';
  const codeThemeDark = codeSlots.dark;

  // ── Head <style> → customCss (never the generator's standalone block rules) ──
  const styleBlocks = $('head style:not([data-cm-standalone])')
    .toArray()
    .map(el => $(el).html() ?? '');
  const customCss = styleBlocks.length > 0 ? styleBlocks.join('\n') : undefined;

  // ── Reveal.initialize → regex-extract the four known config keys ──
  const config: DeckConfig = {};
  const initScript = $('script:not([src])')
    .toArray()
    .map(el => $(el).html() ?? '')
    .find(text => text.includes('Reveal.initialize'));
  if (initScript) {
    const widthMatch = initScript.match(/\bwidth\s*:\s*(\d+)/);
    if (widthMatch) config.width = parseInt(widthMatch[1], 10);
    const heightMatch = initScript.match(/\bheight\s*:\s*(\d+)/);
    if (heightMatch) config.height = parseInt(heightMatch[1], 10);
    const centerMatch = initScript.match(/\bcenter\s*:\s*(true|false)/);
    if (centerMatch && centerMatch[1] === 'false') config.center = false;
    const transitionMatch = initScript.match(/\btransition\s*:\s*['"]([^'"]+)['"]/);
    if (transitionMatch && transitionMatch[1] !== 'slide') config.transition = transitionMatch[1];
  }

  // ── Sections ──
  const rootSections = $('section')
    .toArray()
    .filter(el => $(el).parents('section').length === 0);
  if (rootSections.length === 0) {
    throw new DeckParseError('Document contains no slide sections', warnings);
  }
  const slides = parseSections(rootSections, ctx);

  const deck: DeckJson = { version: 1, theme, codeTheme, slides };
  if (themeDark !== undefined) deck.themeDark = themeDark;
  if (codeThemeDark !== undefined) deck.codeThemeDark = codeThemeDark;
  if (Object.keys(config).length > 0) deck.config = config;
  if (customCss !== undefined) deck.customCss = customCss;
  if (extraCss.length > 0) deck.extraCss = extraCss;

  return { deck, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseSlidesFragment
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedSlidesFragment {
  theme: string;
  codeTheme: string;
  slides: DeckSlide[];
  warnings: string[];
}

/**
 * Parse the editor's thin posted wrapper (RevealSlides getCurrentContent):
 * `<div class="slides" data-theme="…" data-code-theme="…">…sections…</div>`
 * using the same section core as parseDeckHtml.
 *
 * @throws {DeckParseError} when the fragment has zero sections.
 */
export function parseSlidesFragment(
  wrapperHtml: string,
  opts: ParseOptions = {}
): ParsedSlidesFragment {
  const $ = cheerio.load(wrapperHtml, null, false);
  const warnings: string[] = [];
  const ctx: ParseContext = {
    $,
    idGen: opts.idGen ?? mintSlideId,
    usedIds: new Set(),
    warnings,
  };

  const $wrapper = $('div.slides').first();
  const theme = $wrapper.attr('data-theme') ?? 'white';
  const codeTheme = $wrapper.attr('data-code-theme') ?? 'github';

  const rootSections = $('section')
    .toArray()
    .filter(el => $(el).parents('section').length === 0);
  if (rootSections.length === 0) {
    throw new DeckParseError('Slides fragment contains no sections', warnings);
  }
  const slides = parseSections(rootSections, ctx);

  return { theme, codeTheme, slides, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeSlideHtml
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize an incoming slide-content fragment (MCP-written html/notes):
 * round it through the cheerio fragment parser and apply the same
 * `pre > code` escape-to-text normalization the editor applies
 * (RevealSlides getCurrentContent — code children flattened to escaped text,
 * hljs class removed).
 *
 * @throws {SlideHtmlError} when the fragment contains `<section>`/`</section>`
 *   tags — a stray section closer would corrupt sibling sections in the
 *   generated document, and nested sections would silently change the deck
 *   structure on the next parse.
 */
export function normalizeSlideHtml(html: string): string {
  if (/<\/?section\b/i.test(html)) {
    throw new SlideHtmlError(
      'Slide HTML must not contain <section> tags — slide structure is managed by the deck'
    );
  }

  const $ = cheerio.load(html, null, false);

  $('pre code').each((_i, el) => {
    const $el = $(el);
    const plain = $el.text();
    $el.empty();
    $el.text(plain);
    $el.removeClass('hljs');
    if (($el.attr('class') ?? '') === '') {
      $el.removeAttr('class');
    }
  });

  // Reveal fragment runtime paint (visible / current-fragment) never persists.
  stripFragmentRuntimeClasses($.root());

  // svg blocks held to the drawing lists; an html block's frame whose
  // sandbox would let it out is stored inert.
  sanitizeSvgBlocksIn($);
  neutralizeHtmlBlocksIn($);

  return serializeBrowserForm($);
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocks: svg and html (rules in deckBlocks.ts, applied here with cheerio)
// ─────────────────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
// Private-use stand-ins for `<` / `>` inside attribute values while cheerio
// serializes (it leaves both raw; Chromium writes `&lt;` / `&gt;`).
const ATTR_LT = '\uE000';
const ATTR_GT = '\uE001';
const STAND_IN_RE = /[\uE000\uE001]/;

/**
 * The fragment serialized the way current Chromium serializes it. cheerio
 * (parse5 7) differs in one place: it leaves `<` and `>` raw inside attribute
 * values, which Chromium escapes (fixture-pinned in
 * __tests__/fixtures/browserSerialization.ts). Writing the browser's form
 * means markup the server stores reads back from the live editor unchanged —
 * above all an html block's srcdoc, which is full of both.
 */
function serializeBrowserForm($: CheerioAPI): string {
  return browserFormHtml($, $.root());
}

/**
 * The inner html of `$el` in the browser's form (see serializeBrowserForm).
 * The tree is left as it was. Markup already carrying the stand-in
 * characters is serialized as cheerio writes it.
 */
function browserFormHtml($: CheerioAPI, $el: Cheerio<AnyNode>): string {
  const touched: Array<[Element, string, string]> = [];
  let standIns = false;
  $el.find('*').each((_i, node) => {
    const attribs = (node as Element).attribs;
    for (const [name, value] of Object.entries(attribs)) {
      if (STAND_IN_RE.test(value)) standIns = true;
      if (/[<>]/.test(value)) touched.push([node as Element, name, value]);
    }
  });
  if (touched.length === 0) return $el.html() ?? '';
  const plain = $el.html() ?? '';
  if (standIns || STAND_IN_RE.test(plain)) return plain;
  for (const [el, name, value] of touched) {
    el.attribs[name] = value.replace(/</g, ATTR_LT).replace(/>/g, ATTR_GT);
  }
  const out = ($el.html() ?? '').replace(/\uE000/g, '&lt;').replace(/\uE001/g, '&gt;');
  for (const [el, name, value] of touched) el.attribs[name] = value;
  return out;
}

/** Rename attributes in place (order kept), `rename` returning the new name. */
function renameAttribs(el: Element, rename: (name: string) => string): void {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(el.attribs)) next[rename(name)] = value;
  el.attribs = next;
}

function insideHtmlBlock($: CheerioAPI, el: Element): boolean {
  return $(el).closest(HTML_BLOCK_SELECTOR).length > 0;
}

/** Html-block frames whose sandbox would let them out get inert sources. Returns the count. */
function neutralizeHtmlBlocksIn($: CheerioAPI): number {
  let count = 0;
  $(HTML_BLOCK_FRAME_SELECTOR).each((_i, node) => {
    const el = node as Element;
    const inside = insideHtmlBlock($, el);
    const blocked = (name: string) =>
      isBlockedFrameAttr(el.tagName, name, el.attribs['sandbox'], inside);
    if (!Object.keys(el.attribs).some(blocked)) return;
    renameAttribs(el, name => {
      if (!blocked(name)) return name;
      count++;
      return `${INERT_ATTR_PREFIX}${name}`;
    });
  });
  return count;
}

/**
 * Slide html with every html-block frame that may not load made inert — the
 * html-block rule alone. Html with no html block, or none to change, comes
 * back byte for byte.
 */
export function neutralizeHtmlBlocksInHtml(html: string): string {
  if (!/data-block-type/i.test(html)) return html;
  const $ = cheerio.load(html, null, false);
  if (neutralizeHtmlBlocksIn($) === 0) return html;
  return serializeBrowserForm($);
}

/**
 * Slide html with both block rules applied — the generator's pass, since
 * render-view, thumbnails and the stored document are opened as they are:
 * html-block frames that may not load made inert, svg blocks held to their
 * lists. Html with nothing to change comes back byte for byte.
 */
export function secureSlideBlocksInHtml(html: string): string {
  if (!/data-block-type/i.test(html)) return html;
  const $ = cheerio.load(html, null, false);
  const changed = sanitizeSvgBlocksIn($) + neutralizeHtmlBlocksIn($);
  return changed === 0 ? html : serializeBrowserForm($);
}

/** cheerio's local name and namespace for an element (svg names keep their case). */
function svgAllowed(el: Element): boolean {
  return (
    isAllowedSvgElement(el.tagName, el.namespace ?? null) &&
    isAllowedSvgAnimation(el.tagName, el.attribs)
  );
}

function stripHandlers(el: Element): number {
  let removed = 0;
  for (const name of Object.keys(el.attribs)) {
    if (name.toLowerCase().startsWith('on')) {
      delete el.attribs[name];
      removed++;
    }
  }
  return removed;
}

/** The svg-block lists applied under `root` (cheerio twin of deckBlocks sanitizeSvgTree). */
function sanitizeSvgTreeIn(root: Element): number {
  let changed = stripHandlers(root);
  const visit = (parent: Element): void => {
    for (const node of [...parent.children] as AnyNode[]) {
      if (node.type === 'tag' || node.type === 'script' || node.type === 'style') {
        const el = node as Element;
        if (!svgAllowed(el)) {
          removeNode(el);
          changed++;
          continue;
        }
        // cheerio keys `xlink:href` as `href` (namespace kept aside) — the
        // link rule reads both the same way.
        for (const [name, value] of Object.entries(el.attribs)) {
          if (!isAllowedSvgAttr(name, value)) {
            delete el.attribs[name];
            changed++;
          }
        }
        visit(el);
      } else if (node.type !== 'text') {
        removeNode(node);
        changed++;
      }
    }
  };
  visit(root);
  return changed;
}

function removeNode(node: AnyNode): void {
  const parent = node.parent as Element | null;
  if (!parent) return;
  const siblings = parent.children as AnyNode[];
  const at = siblings.indexOf(node);
  if (at >= 0) siblings.splice(at, 1);
  const prev = node.prev;
  const next = node.next;
  if (prev) prev.next = next;
  if (next) next.prev = prev;
  node.parent = null;
  node.prev = null;
  node.next = null;
}

/** Every svg block held to the lists: content sanitized, anything else in the block dropped. Returns the changes. */
function sanitizeSvgBlocksIn($: CheerioAPI): number {
  let changed = 0;
  $(SVG_BLOCK_SELECTOR).each((_i, node) => {
    const block = node as Element;
    changed += stripHandlers(block);
    for (const child of [...block.children] as AnyNode[]) {
      if (child.type === 'text') continue;
      const isContent =
        child.type === 'tag' &&
        ((child as Element).attribs['class'] ?? '').split(/\s+/).includes('sl-block-content');
      if (isContent) {
        changed += sanitizeSvgTreeIn(child as Element);
      } else {
        removeNode(child);
        changed++;
      }
    }
  });
  return changed;
}

/**
 * An svg block's content from an author's (or agent's) SVG: exactly one
 * `<svg>` root, held to the lists, sized to fill its block (`width`/`height`
 * 100%, `preserveAspectRatio` meet unless set), with a `viewBox` derived from
 * numeric width/height when it has none, so the drawing scales with the box.
 *
 * @throws {SlideHtmlError} when the markup has no single `<svg>` root.
 */
export function normalizeSvgBlockSource(svg: string): string {
  const $ = cheerio.load(svg.trim(), null, false);
  // An exported file's prolog (`<?xml …?>`, comments, a doctype) is dropped.
  const top = [...($.root()[0].children as AnyNode[])];
  const elements = top.filter(n => n.type === 'tag' || n.type === 'script' || n.type === 'style');
  const strayText = top.some(n => n.type === 'text' && (n as { data?: string }).data?.trim());
  const root = elements[0] as Element | undefined;
  if (
    elements.length !== 1 ||
    strayText ||
    !root ||
    root.tagName !== 'svg' ||
    root.namespace !== SVG_NS
  ) {
    throw new SlideHtmlError('An svg block needs exactly one <svg> element as its source');
  }
  for (const node of top) if (node !== root) removeNode(node);
  for (const [name, value] of Object.entries(root.attribs)) {
    if (!isAllowedSvgAttr(name, value)) delete root.attribs[name];
  }
  sanitizeSvgTreeIn(root);
  const attribs = root.attribs;
  const viewBoxKey = Object.keys(attribs).find(k => k.toLowerCase() === 'viewbox');
  if (!viewBoxKey) {
    const w = parseFloat(attribs['width'] ?? '');
    const h = parseFloat(attribs['height'] ?? '');
    const numeric = (v: string | undefined) => v != null && /^\s*[\d.]+(?:px)?\s*$/.test(v);
    if (numeric(attribs['width']) && numeric(attribs['height']) && w > 0 && h > 0) {
      attribs['viewBox'] = `0 0 ${w} ${h}`;
    }
  }
  attribs['width'] = '100%';
  attribs['height'] = '100%';
  if (!Object.keys(attribs).some(k => k.toLowerCase() === 'preserveaspectratio')) {
    attribs['preserveAspectRatio'] = 'xMidYMid meet';
  }
  return serializeBrowserForm($);
}

/** One block on a slide, as agents read it (deck_get / deck_outline). */
export interface SlideBlockInfo {
  /** `data-cm-block-id`, or null for a block made before block ids. */
  id: string | null;
  /** `data-block-type` (text, image, code, iframe, svg, html, sandpack, …). */
  type: string;
  /** left/top/width/height in px, each present when the block's style sets it in px. */
  box: Partial<BlockBox>;
  /** html blocks: the source, decoded from srcdoc (storage shim taken out). */
  source?: string;
  /** svg blocks: the `<svg>` markup. */
  svg?: string;
  /** iframe blocks: the frame's URL (`data-src`, else `src`). */
  src?: string;
}

const BOX_KEYS = ['left', 'top', 'width', 'height'] as const;

function boxFromStyle(style: string): Partial<BlockBox> {
  const box: Partial<BlockBox> = {};
  for (const decl of splitStyleDeclarations(style)) {
    const at = decl.indexOf(':');
    if (at === -1) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const match = decl
      .slice(at + 1)
      .trim()
      .match(/^(-?\d+(?:\.\d+)?)px$/i);
    if (match && (BOX_KEYS as readonly string[]).includes(prop)) {
      box[prop as keyof BlockBox] = Number(match[1]);
    }
  }
  return box;
}

function blockFrame($: CheerioAPI, block: Element): Element | undefined {
  return $(block).find('iframe').toArray()[0] as Element | undefined;
}

/** The draggable blocks of a slide's html, top-level `.sl-block`s in document order. */
export function readSlideBlocks(html: string, opts: { content?: boolean } = {}): SlideBlockInfo[] {
  if (!html.includes('sl-block')) return [];
  const $ = cheerio.load(html, null, false);
  return $('.sl-block')
    .toArray()
    .filter(el => $(el).parents('.sl-block').length === 0)
    .map(node => {
      const el = node as Element;
      const type = el.attribs['data-block-type'] ?? 'text';
      const info: SlideBlockInfo = {
        id: el.attribs[BLOCK_ID_ATTR] ?? null,
        type,
        box: boxFromStyle(el.attribs['style'] ?? ''),
      };
      if (opts.content === false) return info;
      if (type === 'html') {
        const frame = blockFrame($, el);
        const srcdoc = frame?.attribs['srcdoc'] ?? frame?.attribs[`${INERT_ATTR_PREFIX}srcdoc`];
        if (srcdoc != null) info.source = htmlBlockSource(srcdoc);
      } else if (type === 'svg') {
        const svg = $(el).find('svg').first();
        if (svg.length > 0) info.svg = $.html(svg);
      } else if (type === 'iframe') {
        const frame = blockFrame($, el);
        const src = frame?.attribs['data-src'] ?? frame?.attribs['src'];
        if (src != null) info.src = src;
      }
      return info;
    });
}

/** What a block edit changes; only the fields given. */
export interface SlideBlockEdit {
  box?: Partial<BlockBox>;
  /** html blocks: new source (the frame is rebuilt with the standard sandbox). */
  source?: string;
  /** svg blocks: new `<svg>` markup. */
  svg?: string;
  /** iframe blocks: new URL (stored as `data-src`, so it loads lazily). */
  src?: string;
}

/** Typed failure for a block edit (unknown block id, field that does not fit the type). */
export class SlideBlockError extends Error {
  code = 'INVALID_BLOCK_EDIT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SlideBlockError';
  }
}

/** A top-level block by id (the blocks readSlideBlocks lists). */
function findBlock($: CheerioAPI, blockId: string): Element {
  const matches = $('.sl-block')
    .toArray()
    .filter(
      el =>
        (el as Element).attribs[BLOCK_ID_ATTR] === blockId &&
        $(el).parents('.sl-block').length === 0
    ) as Element[];
  if (matches.length === 0) throw new SlideBlockError(`No block '${blockId}' on this slide`);
  return matches[0];
}

/** `style` with left/top/width/height set from `box` (other declarations kept, in order). */
function styleWithBox(style: string, box: Partial<BlockBox>): string {
  const decls = splitStyleDeclarations(style)
    .map(d => d.trim())
    .filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  const set: Record<string, string> = {};
  for (const key of BOX_KEYS) {
    const value = box[key];
    if (value !== undefined) set[key] = cssPx(value);
  }
  for (const decl of decls) {
    const prop = decl.slice(0, decl.indexOf(':')).trim().toLowerCase();
    if (prop in set) {
      if (!seen.has(prop)) out.push(`${prop}: ${set[prop]}`);
      seen.add(prop);
    } else {
      out.push(decl);
    }
  }
  for (const [prop, value] of Object.entries(set)) {
    if (!seen.has(prop)) out.push(`${prop}: ${value}`);
  }
  return out.length > 0 ? `${out.join('; ')};` : '';
}

/**
 * A slide's html with one block (by `data-cm-block-id`) changed, through the
 * same cleanup as any written slide html.
 *
 * @throws {SlideBlockError} unknown block id, or a field that does not fit
 *   the block's type.
 */
export function updateSlideBlock(html: string, blockId: string, edit: SlideBlockEdit): string {
  const $ = cheerio.load(html, null, false);
  const block = findBlock($, blockId);
  const type = block.attribs['data-block-type'] ?? 'text';
  const content = $(block).children('.sl-block-content').first();
  if ((edit.source !== undefined || edit.svg !== undefined) && content.length === 0) {
    throw new SlideBlockError(`Block '${blockId}' has no content to replace`);
  }
  if (edit.source !== undefined) {
    if (type !== 'html') throw new SlideBlockError(`Block '${blockId}' is ${type}, not html`);
    content.empty().append(htmlBlockFrameMarkup(edit.source));
  }
  if (edit.svg !== undefined) {
    if (type !== 'svg') throw new SlideBlockError(`Block '${blockId}' is ${type}, not svg`);
    content.empty().append(normalizeSvgBlockSource(edit.svg));
  }
  if (edit.src !== undefined) {
    if (type !== 'iframe') throw new SlideBlockError(`Block '${blockId}' is ${type}, not iframe`);
    const frame = blockFrame($, block);
    if (!frame) throw new SlideBlockError(`Block '${blockId}' has no frame`);
    delete frame.attribs['src'];
    frame.attribs['data-src'] = edit.src;
  }
  if (edit.box && Object.keys(edit.box).length > 0) {
    const style = styleWithBox(block.attribs['style'] ?? '', edit.box);
    if (style) block.attribs['style'] = style;
  }
  return normalizeSlideHtml(serializeBrowserForm($));
}

/**
 * A slide's html without one block (by `data-cm-block-id`).
 *
 * @throws {SlideBlockError} unknown block id.
 */
export function removeSlideBlock(html: string, blockId: string): string {
  const $ = cheerio.load(html, null, false);
  removeNode(findBlock($, blockId));
  return normalizeSlideHtml(serializeBrowserForm($));
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser-serialization-tolerant HTML equivalence (Phase 7.5 editor saves)
// ─────────────────────────────────────────────────────────────────────────────
//
// The editor-save merge compares the POSTED document (browser-serialized DOM)
// against decks parsed from stored generator output. Browsers rewrite markup
// they never semantically changed — the exact rewrites are pinned as captured
// Chromium ground truth in __tests__/fixtures/browserSerialization.ts:
//   - CSSOM style serialization: hex → rgb(r, g, b), rgb respacing, numeric
//     noise trimmed (`.5px` → `0.5px`, `600.50px` → `600.5px`), url()/font
//     quoting, `; ` joining + trailing `;`
//   - valueless attrs gain `=""`, attr re-quoting, entity re-encoding,
//     self-closing slashes dropped
// The equivalence below treats exactly those rewrites as equal and NOTHING
// else: tag structure and text-node data compare verbatim (the fragment
// parser decodes entities, so `&quot;` vs `"` is the same text, never a
// loosening), pre/code subtrees get no attribute loosening at all, and
// genuinely different values (colors, numbers, class token order, code
// content) still differ.

/** Protects quoted strings / url() args during unquoted-css normalization. */
const CSS_STRING_RE = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
/** 3/6-digit hex colors only — 4/8-digit (alpha) forms stay verbatim. */
const CSS_HEX_COLOR_RE = /#([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/gi;
const CSS_DECIMAL_RE = /(\d+\.\d*|\.\d+)/g;

function hexToRgbTriplet(hex: string): string {
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map(c => c + c)
          .join('')
      : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

/** `.5` → `0.5`, `600.50` → `600.5`, `-50.0` → `-50` (sign untouched). */
function trimCssDecimal(digits: string): string {
  let d = digits.startsWith('.') ? `0${digits}` : digits;
  if (d.includes('.')) {
    d = d.replace(/0+$/, '');
    if (d.endsWith('.')) d = d.slice(0, -1);
  }
  return d;
}

/**
 * Canonicalize one css declaration VALUE the way Chromium's CSSOM serializer
 * would (fixture-pinned): quoted strings become double-quoted (content
 * verbatim), unquoted url() args get quoted, whitespace/comma spacing
 * collapses, 3/6-digit hex → rgb(r, g, b), decimal noise trimmed. Keyword
 * case and everything inside quotes stay verbatim — deliberately strict.
 */
function canonicalCssValue(rawValue: string): string {
  const protectedParts: string[] = [];
  const protect = (part: string): string => {
    protectedParts.push(part);
    return `\u0000${protectedParts.length - 1}\u0000`;
  };

  // Quoted strings first: canonical double-quoted form, content verbatim.
  let value = rawValue.replace(
    CSS_STRING_RE,
    (_m, dq: string | undefined, sq: string | undefined) => {
      const content =
        dq !== undefined ? dq : (sq as string).replace(/\\'/g, "'").replace(/"/g, '\\"');
      return protect(`"${content}"`);
    }
  );
  // Unquoted url() args (quoted ones are already placeholders): url(x) → url("x").
  value = value.replace(
    // eslint-disable-next-line no-control-regex -- \u0000 is the placeholder sentinel; parsed attr values can never contain NUL
    /url\(\s*([^)\u0000]*?)\s*\)/gi,
    (_m, arg: string) => `url(${protect(`"${arg}"`)})`
  );

  value = value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(CSS_HEX_COLOR_RE, (_m, hex: string) => hexToRgbTriplet(hex.toLowerCase()))
    .replace(CSS_DECIMAL_RE, (_m, digits: string) => trimCssDecimal(digits));

  // eslint-disable-next-line no-control-regex -- restoring the \u0000-delimited placeholders
  return value.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => protectedParts[Number(i)]);
}

/**
 * Canonical form of a style attr VALUE for equivalence: declarations parsed
 * (property lowercased, value via canonicalCssValue), trailing `;` irrelevant
 * by construction.
 *
 * Declaration ORDER is PRESERVED — a browser DOM round-trip never reorders a
 * style attr's declarations (captured Chromium ground truth in the fixtures),
 * so two read-backs of untouched markup keep the same order, while a genuine
 * shorthand/longhand reorder (`margin-top: 5px; margin: 10px` vs the reverse)
 * changes the rendered result and MUST read as a difference. Sorting the
 * declarations (the old behavior) masked exactly those semantic edits.
 *
 * An EXACT same-property repeat still collapses last-wins (the browser's own
 * behavior), keeping the property at its first-seen position. Custom
 * properties (`--x`) are stored verbatim by the browser — their value skips
 * canonicalCssValue (no hex→rgb, no decimal trimming) and their name keeps its
 * case.
 */
function canonicalStyleAttr(style: string): string {
  const order: string[] = [];
  const values = new Map<string, string>();
  const set = (prop: string, value: string): void => {
    if (!values.has(prop)) order.push(prop);
    values.set(prop, value);
  };
  for (const raw of splitStyleDeclarations(style)) {
    const idx = raw.indexOf(':');
    if (idx === -1) {
      const bare = raw.trim().toLowerCase();
      if (bare) set(bare, '');
      continue;
    }
    const rawProp = raw.slice(0, idx).trim();
    if (!rawProp) continue;
    const isCustom = rawProp.startsWith('--');
    const prop = isCustom ? rawProp : rawProp.toLowerCase();
    const value = isCustom ? raw.slice(idx + 1).trim() : canonicalCssValue(raw.slice(idx + 1));
    set(prop, value);
  }
  return order.map(prop => `${prop}:${values.get(prop)}`).join(';');
}

/**
 * Canonical form of one attribute value for browser-serialization-tolerant
 * comparison: `style` via the CSSOM rules, everything else (including `class`)
 * verbatim. Browsers preserve the class attribute string byte-for-byte on a
 * DOM round-trip (fixture-pinned: leading/trailing and repeated whitespace all
 * survive), so collapsing it would mask a real edit — compare it verbatim.
 * Values are already entity-decoded by the parser; a valueless attr and `=""`
 * are both the empty string.
 */
export function browserCanonicalAttrValue(name: string, value: string): string {
  if (name === 'style') return canonicalStyleAttr(value);
  return value;
}

function browserCanonicalNodeSig(node: AnyNode, verbatimAttrs: boolean): string {
  if (node.type === 'text') {
    // Parser-decoded data verbatim: entity re-encodings compare equal, any
    // actual character change (including whitespace) does not.
    return `T${JSON.stringify(node.data)}`;
  }
  if (node.type === 'comment') {
    return `C${JSON.stringify(node.data)}`;
  }
  if (node.type === 'tag' || node.type === 'script' || node.type === 'style') {
    const el = node as Element;
    const name = el.tagName.toLowerCase();
    // No attribute loosening anywhere inside pre/code — code content (and any
    // markup riding in it) must never be loosened.
    const childVerbatim = verbatimAttrs || name === 'pre' || name === 'code';
    const attrs = Object.entries(el.attribs ?? {})
      .map(([attrName, attrValue]): [string, string] => {
        const lower = attrName.toLowerCase();
        const raw = attrValue ?? '';
        return [lower, verbatimAttrs ? raw : browserCanonicalAttrValue(lower, raw)];
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const children = (el.children as AnyNode[])
      .map(child => browserCanonicalNodeSig(child, childVerbatim))
      .join('');
    return `<${name} ${JSON.stringify(attrs)}>${children}</${name}>`;
  }
  // Directives / CDATA / anything exotic: byte-strict.
  return `O${JSON.stringify({ type: node.type, data: (node as { data?: string }).data ?? '' })}`;
}

const canonicalHtmlCache = new Map<string, string>();
const CANONICAL_HTML_CACHE_MAX = 2000;

/**
 * Canonical signature of an html fragment under the browser-serialization
 * equivalence. Two fragments are equivalent iff their signatures match —
 * signature comparison is transitive, so merge decisions stay consistent
 * across base/ours/theirs.
 */
export function browserCanonicalHtmlSig(html: string): string {
  const cached = canonicalHtmlCache.get(html);
  if (cached !== undefined) return cached;
  let sig: string;
  try {
    const $ = cheerio.load(html, null, false);
    sig = ($.root()[0].children as AnyNode[])
      .map(child => browserCanonicalNodeSig(child, false))
      .join('');
  } catch {
    // Unparseable → byte-strict (never loosen what we cannot model).
    sig = `RAW${JSON.stringify(html)}`;
  }
  if (canonicalHtmlCache.size >= CANONICAL_HTML_CACHE_MAX) canonicalHtmlCache.clear();
  canonicalHtmlCache.set(html, sig);
  return sig;
}

/**
 * True when two html/notes fragments differ only by browser serialization
 * (DOM round-trip + CSSOM style re-serialization) — see the fixture file for
 * the exact rewrites this absorbs. Conservative by design: any real content,
 * structure, attribute, color, or numeric difference is NOT equivalent.
 * null/undefined are equivalent only to each other (absent ≠ empty string).
 */
export function htmlEquivalentModuloBrowserSerialization(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (a === b) return true;
  return browserCanonicalHtmlSig(a) === browserCanonicalHtmlSig(b);
}
