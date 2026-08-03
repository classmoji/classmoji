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
import type { Element } from 'domhandler';
import { randomBytes } from 'node:crypto';
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

/**
 * Runtime paint the Reveal viewer / editor leaves on sections. Stripped by
 * both parsers so `attrs` is deterministic between saves (plan §2).
 */
const CRUFT_CLASSES = new Set([
  'editing-mode',
  'slide-hidden',
  'stack',
  'present',
  'past',
  'future',
]);

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
}

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

  return `<section${attrStr}>${slide.html ?? ''}${aside}</section>`;
}

/**
 * Generate the complete reveal.js index.html document for a deck.
 *
 * Rules (plan §2):
 * - Emits NO implicit styles — the sl-block visibility override lives in
 *   `customCss` (seeded at import), starter styling seeded at create.
 * - themeDark/codeThemeDark → light/dark/`not all` media link trio, else a
 *   single canonical link.
 * - Builtin themes via jsDelivr reveal.js@5.1.0; shared:/custom: themes via
 *   opts.themeUrls (caller-resolved).
 * - `data-cm-id` emitted on every section.
 * - Config keys go into Reveal.initialize only when set (canonical defaults:
 *   hash:true, controls:true, progress:true, center:true, transition:'slide').
 */
export function generateDeckHtml(deck: DeckJson, opts: GenerateDeckOptions): string {
  const { title, themeUrls, includeNotes = true } = opts;
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

/** Strip runtime paint from a section element (plan §2 cruft list). */
function stripRuntimeCruft($el: Cheerio<Element>): void {
  const cls = $el.attr('class');
  if (cls != null) {
    const kept = cls.split(/\s+/).filter(c => c !== '' && !CRUFT_CLASSES.has(c));
    if (kept.length > 0) {
      $el.attr('class', kept.join(' '));
    } else {
      $el.removeAttr('class');
    }
  }
  $el.removeAttr('aria-hidden');
  $el.removeAttr('hidden');
  const style = $el.attr('style');
  if (style != null) {
    // Remove just the `display` property, keep other inline styles.
    const props = style
      .split(';')
      .map(p => p.trim())
      .filter(p => p !== '' && !/^display\s*:/i.test(p));
    if (props.length > 0) {
      $el.attr('style', props.join('; ') + ';');
    } else {
      $el.removeAttr('style');
    }
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
    asides.length > 0 ? asides.map(aside => $(aside).html() ?? '').join('\n') : undefined;
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
    slide.html = $el.html() ?? '';
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
        themeCandidates.push({ name: themeMatch[1], ...(media ? { media } : {}) });
        return;
      }
      const hlMatch = href.match(HIGHLIGHT_RE) ?? href.match(REVEAL_PLUGIN_HIGHLIGHT_RE);
      if (hlMatch) {
        codeCandidates.push({ name: hlMatch[1], ...(media ? { media } : {}) });
        return;
      }
      // Shared-theme assets are regenerated from caller-resolved themeUrls.
      if (declared.startsWith('shared:') && href.includes(`${THEMES_FOLDER}/`)) {
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

  // ── Head <style> → customCss ──
  const styleBlocks = $('head style')
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

  return $.root().html() ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────
// diffDeckUnits — 3-way unit walk (powers §3b's structured conflict return)
// ─────────────────────────────────────────────────────────────────────────────

export interface DeckUnitConflict {
  id: string;
  /** Dotted position, '4' or '4.2' (position in ours, falling back to theirs/base). */
  index: string;
  /** The merge-base version of the unit; absent when the unit was added on both sides. */
  base?: DeckSlide;
  /** null = deleted/absent on that side. */
  ours: DeckSlide | null;
  theirs: DeckSlide | null;
}

export interface DeckUnitDiff {
  /** Units changed on BOTH sides with differing results (deep-equal comparison). */
  units: DeckUnitConflict[];
  /** Present when both sides reordered the root sequence differently. */
  orderConflict?: { base: string[]; ours: string[]; theirs: string[] };
}

interface FlatUnit {
  unit: DeckSlide;
  index: string;
}

function flattenUnits(deck: DeckJson): Map<string, FlatUnit> {
  const map = new Map<string, FlatUnit>();
  deck.slides.forEach((slide, i) => {
    map.set(slide.id, { unit: slide, index: String(i + 1) });
    slide.children?.forEach((child, j) => {
      map.set(child.id, { unit: child, index: `${i + 1}.${j + 1}` });
    });
  });
  return map;
}

/**
 * Comparable signature of a unit. Containers compare their own fields plus the
 * ORDER of their children (child ids) — child content changes are the child
 * unit's own diff. Attrs compared with sorted keys.
 */
function unitSignature(entry: FlatUnit | undefined): string {
  if (!entry) return ' absent';
  const { unit } = entry;
  const unitAttrs = unit.attrs ?? {};
  const attrs = Object.keys(unitAttrs)
    .sort()
    .map(key => [key, unitAttrs[key]]);
  return JSON.stringify({
    html: unit.html ?? null,
    notes: unit.notes ?? null,
    hidden: unit.hidden ?? false,
    attrs,
    children: unit.children ? unit.children.map(c => c.id) : null,
  });
}

/**
 * Report units changed on BOTH sides (base = merge-base, ours = main,
 * theirs = preview). Reports conflicts only — no auto-merge (Phase 7).
 */
export function diffDeckUnits(base: DeckJson, ours: DeckJson, theirs: DeckJson): DeckUnitDiff {
  const baseUnits = flattenUnits(base);
  const ourUnits = flattenUnits(ours);
  const theirUnits = flattenUnits(theirs);

  const allIds = new Set<string>([...baseUnits.keys(), ...ourUnits.keys(), ...theirUnits.keys()]);
  const units: DeckUnitConflict[] = [];

  for (const id of allIds) {
    const b = baseUnits.get(id);
    const o = ourUnits.get(id);
    const t = theirUnits.get(id);
    const bSig = unitSignature(b);
    const oSig = unitSignature(o);
    const tSig = unitSignature(t);

    const changedOurs = oSig !== bSig;
    const changedTheirs = tSig !== bSig;
    if (changedOurs && changedTheirs && oSig !== tSig) {
      const index = o?.index ?? t?.index ?? b?.index ?? '';
      const conflict: DeckUnitConflict = {
        id,
        index,
        ours: o?.unit ?? null,
        theirs: t?.unit ?? null,
      };
      if (b) conflict.base = b.unit;
      units.push(conflict);
    }
  }

  // Root order sequence compared as id arrays.
  const baseOrder = base.slides.map(s => s.id);
  const ourOrder = ours.slides.map(s => s.id);
  const theirOrder = theirs.slides.map(s => s.id);
  const sameAsBaseOurs = JSON.stringify(ourOrder) === JSON.stringify(baseOrder);
  const sameAsBaseTheirs = JSON.stringify(theirOrder) === JSON.stringify(baseOrder);
  const oursVsTheirs = JSON.stringify(ourOrder) === JSON.stringify(theirOrder);

  const result: DeckUnitDiff = { units };
  if (!sameAsBaseOurs && !sameAsBaseTheirs && !oursVsTheirs) {
    result.orderConflict = { base: baseOrder, ours: ourOrder, theirs: theirOrder };
  }
  return result;
}
