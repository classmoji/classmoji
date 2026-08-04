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

/** Strip runtime paint from a section element (plan §2 cruft list). */
function stripRuntimeCruft($el: Cheerio<Element>): void {
  stripFragmentRuntimeClasses($el);
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

  // Reveal fragment runtime paint (visible / current-fragment) never persists.
  stripFragmentRuntimeClasses($.root());

  return $.root().html() ?? '';
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

/** Split a style attr on top-level `;` (quotes and parens respected). */
function splitStyleDeclarations(style: string): string[] {
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
