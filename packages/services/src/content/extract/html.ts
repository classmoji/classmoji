/**
 * HTML → plain text, for the content index.
 *
 * Two shapes arrive here:
 *
 *   `pages/<slug>/index.html`  — legacy page bodies (inert once a page has been
 *                                opened in the BlockNote editor, but 38 of
 *                                cs52's 51 pages still have only this).
 *   `slides/<slug>/index.html` — generated reveal.js decks.
 *
 * Structural, not regex. The three removals this file performs — speaker
 * notes, `<script>`, `<style>` — are the ones that decide whether staff-only
 * text or an opaque payload reaches a student's search results, and a tag-strip
 * regex is the wrong tool for a decision like that: it is defeated by an
 * uppercase tag, a single-quoted class attribute, a `>` inside an attribute
 * value, or a `</script>` inside a JS string. Every one of those shapes is
 * already in the repo's own deck fixtures. So the document is parsed, the
 * unsafe subtrees are detached from the DOM, and the text is read off what is
 * left.
 *
 * This module imports cheerio and nothing else. No `@classmoji/services`, no
 * `apps/*` — it must be able to sit below services in the package graph.
 */

import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

/**
 * Tags that end a line of prose.
 *
 * Inline tags (`a`, `strong`, `code`, `span`, `em`) are deliberately absent:
 * they sit mid-sentence and breaking on them would shred every paragraph.
 * Getting this wrong in the other direction is the fourth defect in the old
 * `collectText` — a heading running straight into the paragraph after it.
 */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'caption',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'legend',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

/**
 * Subtrees that carry no prose and must never be read as prose.
 *
 * This overlaps `loadSanitized`, which detaches `script`/`style`/`noscript`/
 * `template` outright, and the overlap is deliberate — do not delete either
 * half as redundant. The detach is what makes the SANITIZED DOM safe (the
 * unparseable-deck fallback reads straight off it); this set is what makes
 * every `textOf` call safe, including the notes capture that runs BEFORE the
 * detach, and it is the only guard for `svg` and `head`, which stay in the
 * tree. Mutating away either half on its own leaves the deck suite's Sandpack
 * test green; mutating away both fails it.
 */
const OPAQUE_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head']);

function isElement(node: AnyNode): node is Element {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style';
}

function walk(node: AnyNode, out: string[]): void {
  if (node.type === 'text') {
    out.push(node.data);
    return;
  }
  if (!isElement(node)) return; // comments, directives, CDATA

  const tag = node.tagName?.toLowerCase() ?? '';
  if (OPAQUE_TAGS.has(tag)) return;

  const isBlock = BLOCK_TAGS.has(tag);
  if (isBlock) out.push('\n');
  for (const child of node.children) walk(child, out);
  if (isBlock) out.push('\n');
}

/**
 * Tidy the raw concatenation into lines.
 *
 * Entities are already decoded by the parser — `&nbsp;` arrives as U+00A0,
 * which `\s` matches — so there is no entity table to keep in sync here.
 */
function tidy(raw: string): string {
  return raw
    .split('\n')
    .map(line =>
      line
        .replace(/\s+/g, ' ')
        // An inline tag contributes no separator of its own, but a block one
        // does, so `<code>/guess</code>.` can end up as `/guess .`. Prose never
        // has whitespace before these; closing it up keeps snippets readable.
        .replace(/ ([.,;:!?%)\]}])/g, '$1')
        .trim()
    )
    .filter(Boolean)
    .join('\n');
}

/** Plain text of one parsed element subtree. */
function textOf(node: AnyNode | null | undefined): string {
  if (!node) return '';
  const out: string[] = [];
  walk(node, out);
  return tidy(out.join(''));
}

type Loaded = cheerio.CheerioAPI;

/**
 * Parse, then detach everything that must never be read as prose.
 *
 * Speaker notes come out FIRST and come out structurally. They are
 * instructor-facing — follow mode strips them before broadcasting to students
 * (`apps/slides/app/routes/$slideId_.follow/route.tsx:106`) and
 * `Slide.show_speaker_notes` defaults false
 * (`packages/database/schema.prisma:1235`) — so no later branch of this file,
 * fallback included, can reach them: by the time anything else runs they are
 * not in the tree. The `aside.notes` selector matches on parsed class tokens,
 * so `<ASIDE class='notes extra'>` and a mid-section aside are caught where the
 * hand-rolled regex at `apps/slides/app/routes/$slideId/route.tsx:385` —
 * case-sensitive, double-quote-bound, last-aside-only — is not.
 */
function loadSanitized(html: string): { $: Loaded; notes: string } {
  const $ = cheerio.load(html);

  const notes: string[] = [];
  $('aside.notes').each((_, el) => {
    const note = textOf(el);
    if (note) notes.push(note);
  });
  $('aside.notes').remove();

  $('script, style, noscript, template').remove();

  return { $, notes: notes.join('\n') };
}

/** Legacy `pages/<slug>/index.html` → plain text. */
export function extractPageHtmlText(html: string | null | undefined): string {
  if (!html) return '';
  const { $ } = loadSanitized(html);
  // `<body>` only: cheerio synthesizes one even for a bare fragment, so this
  // also handles the no-`<body>` case, and `<head>` never contributes.
  return textOf($('body')[0]);
}

export interface DeckText {
  text: string;
  notes: string;
  /** Set when the document yielded no readable slide text at all. */
  error?: string;
}

/**
 * Generated `slides/<slug>/index.html` → `{ text, notes }`, notes kept apart.
 *
 * One line per slide, vertical stacks included: each `<section>` contributes
 * only its OWN content, with nested `<section>`s detached first, so a stack
 * container does not repeat every child.
 *
 * A document with no `<section>` at all is what the deck parser calls
 * `DECK_PARSE_FAILED`. Rather than hand back raw bytes, this falls back to the
 * text of the already-sanitized body — notes and scripts are long gone by then,
 * so the fallback cannot leak what the old raw-strip fallback leaked — and if
 * even that is empty, it reports an error instead of an innocent-looking empty
 * result. An empty string that means "parse failed" and an empty string that
 * means "empty deck" must not be the same value to the indexer.
 */
export function extractDeckHtmlText(html: string | null | undefined): DeckText {
  if (!html) return { text: '', notes: '' };

  const { $, notes } = loadSanitized(html);

  const container = $('div.reveal div.slides').first();
  const root = container.length ? container : $('body').first();

  const lines: string[] = [];
  root.find('section').each((_, section) => {
    const own = $(section).clone();
    own.find('section').remove();
    const text = textOf(own[0]);
    if (text) lines.push(text);
  });

  if (lines.length) return { text: lines.join('\n'), notes };

  // No parseable sections. The body is already notes-free and script-free.
  const fallback = textOf($('body')[0]);
  if (fallback) return { text: fallback, notes };

  return {
    text: '',
    notes,
    error: 'deck could not be parsed: no slide sections and no readable body text',
  };
}
