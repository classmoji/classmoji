/**
 * deck.json schema (content-tools plan §1)
 *
 * Stored at `slides/<slug>/deck.json`, next to the generated `index.html`.
 * Source of truth once it exists; `index.html` is a build artifact regenerated
 * on every save.
 */

export interface DeckConfig {
  /** Reveal.initialize width override (canonical default: unset). */
  width?: number;
  /** Reveal.initialize height override (canonical default: unset). */
  height?: number;
  /** Reveal.initialize center override — only stored when false (canonical default: true). */
  center?: boolean;
  /** Reveal.initialize transition override — only stored when not 'slide'. */
  transition?: string;
}

/** Unrecognized `<link rel="stylesheet">` tag re-emitted verbatim. */
export interface DeckExtraCss {
  href: string;
  media?: string;
}

export interface DeckSlide {
  /**
   * Stable 8-char id, generated once; the parser enforces uniqueness (first
   * occurrence keeps it, later duplicates are re-minted). Emitted into
   * generated HTML as `data-cm-id` on the `<section>`.
   */
  id: string;
  /** Inner HTML of the `<section>`, notes removed; absent on stack containers. */
  html?: string;
  /** Inner content of `<aside class="notes">` (multiple asides concatenated with '\n'). */
  notes?: string;
  /** data-hidden="true" */
  hidden?: boolean;
  /**
   * All other `<section>` attributes verbatim (class, style, data-background-*,
   * data-transition, data-id, …) AFTER runtime-cruft stripping (plan §2).
   */
  attrs?: Record<string, string>;
  /** Vertical stack (one nesting level, per Reveal). */
  children?: DeckSlide[];
}

export interface DeckJson {
  version: 1;
  /** 'white' | 11 other builtins | 'custom:<file>.css' | 'shared:<name>' */
  theme: string;
  /** highlight.js theme name, e.g. 'github'. */
  codeTheme: string;
  /**
   * Dark-mode builtin theme (slides.com imports emit a light/dark media-query
   * link pair; captured first-class, re-emitted as the pair).
   */
  themeDark?: string;
  codeThemeDark?: string;

  /**
   * Reveal.initialize overrides. Canonical defaults (hash, controls, progress,
   * center:true, transition:'slide') are NOT stored. Captures starter
   * center:false, importer 960/700/center:false.
   */
  config?: DeckConfig;

  /**
   * Verbatim inline `<head>` `<style>` content (starter decks carry one; the
   * importer's sl-block visibility override is SEEDED here at import time —
   * the generator emits NO implicit styles).
   */
  customCss?: string;

  /**
   * Unrecognized `<link rel=stylesheet>` tags re-emitted verbatim.
   * Builtin-theme and highlight.js-shaped hrefs are NEVER stored here (they
   * parse into theme fields or are purged with a warning).
   */
  extraCss?: DeckExtraCss[];

  slides: DeckSlide[];
}
