import { COLORS_DEFAULT } from '@blocknote/core';

import { normalizeCodeBlockContent } from './codeContent.ts';
import { codeBlockDisplayLanguage } from './schema.ts';
import { getServerEditor, type PageServerEditor } from './serverEditor.ts';

/**
 * Legacy page HTML (`pages/<slug>/index.html`, written by the old
 * MarkdownEditor) -> page blocks, the ONE converter every surface uses: the
 * in-app viewer and the class site render a legacy page through it, and live
 * editing seeds a legacy page's room with its output, so all of them show the
 * same blocks. Node only (BlockNote's server editor, jsdom); import it from
 * `@classmoji/page-schema/server`.
 *
 * Three passes:
 *
 * 1. A DOM pass over the whole document: drops the title `<h1>` and the
 *    subtitle (they live on the page row), decodes the markdown importer's
 *    base64 toggle bodies, gives terminal code without a
 *    language class `language-bash`, writes each heading's colour as a
 *    BlockNote colour name and each aligned image's alignment onto the
 *    element (BlockNote's parser reads `data-background-color` and
 *    `data-text-alignment`), and rewrites old `/<slug>/pages/<id>` links.
 * 2. Per fragment: the old editor's widgets (callout, alert, check list item,
 *    file tree, `<details>`, columns, page link, terminal) are lifted out
 *    into marker paragraphs, paragraphs are split around images inside their
 *    text, BlockNote's HTML parser reads the rest, `postProcessBlocks` maps
 *    the patterns the parser leaves behind (terminal headers, video embeds,
 *    images in paragraphs and list items), and each marker is replaced by the
 *    widget's blocks. Widget bodies (`<details>`, columns) are fragments in
 *    their own right and go through this pass again.
 * 3. The editor's normalisation: canonical code languages, plain-text code,
 *    BlockNote colour names only, then blocks -> ProseMirror -> blocks, which
 *    fills every prop and gives every block a fresh uuid, exactly as
 *    `editor.document` would. No trailing empty paragraph: BlockNote 0.55
 *    draws the trailing block as a decoration and never saves one. No
 *    leading one either: a document that opens with a heading starts with
 *    the heading, not the spacer the old viewer put above it.
 *
 * Lossy by design (the original HTML stays in git), but it never throws on
 * odd input and its output always loads in the page schema: a `columnList`
 * only with two or more non-empty columns, never inside a column.
 */

/** A page block as stored in `content.json` (BlockNote JSON). */
export interface PageBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: PageBlock[];
}

export interface HtmlToPageBlocksOptions {
  /**
   * The page's title. The first `<h1>` is the old editor's copy of it and is
   * dropped only when its text matches; one that doesn't is content and is
   * kept. Without a title the first `<h1>` of a full document is dropped, as
   * the viewer always did.
   */
  title?: string;
  /**
   * The current address of a page an old `/<classroomSlug>/pages/<pageId>`
   * link points at, or null/undefined when there is no such page. Links that
   * resolve are rewritten to the returned href and old page-link widgets
   * become `pageLink` blocks; the rest are left as they are. Without a
   * resolver every link is left as it is.
   */
  resolvePageLink?: (
    classroomSlug: string,
    pageId: string
  ) => string | null | undefined | Promise<string | null | undefined>;
}

/** Inline content as BlockNote writes it (text runs and links). */
interface InlineItem {
  type: string;
  text?: string;
  styles?: Record<string, unknown>;
  href?: string;
  content?: InlineItem[];
}

const TEXT_NODE = 3;

/** Elements whose contents are code: nothing inside them is a heading, widget or link. */
const CODE_SELECTOR = 'pre, code, .code-block, .terminal-block';

/** Marks a resolved page-link widget between the document pass and the fragment pass. */
const PAGE_LINK_ATTR = 'data-classmoji-page-link';
const PAGE_LINK_TITLE_ATTR = 'data-classmoji-page-title';

/** The old editor's widgets, lifted out before BlockNote parses a fragment. */
const WIDGET_SELECTOR = [
  '.callout',
  '.alert',
  '.checklist-item',
  '.file-tree',
  'details',
  '.columns',
  `.page-link-block[${PAGE_LINK_ATTR}]`,
  '.terminal-block',
].join(', ');

const ALERT_EMOJI: Record<string, string> = {
  info: '💡',
  warning: '⚠️',
  error: '🚨',
  success: '✅',
  note: '📌',
};

/** An old page link: `/<classroomSlug>/pages/<pageId>`. */
const LEGACY_PAGE_HREF = /^\/([^/?#]+)\/pages\/([0-9a-f-]{36})\/?$/i;
/** A page link in either form, old or current (`/<classroomSlug>/<pageId>`). */
const ANY_PAGE_HREF = /^\/([^/?#]+)\/(?:pages\/)?([0-9a-f-]{36})\/?$/i;

const MARKER = 'LEGACY_EMBED:::';
const MARKER_ONLY = /^LEGACY_EMBED:::(\d+)$/;
const MARKER_ANY = /LEGACY_EMBED:::(\d+)/g;

/**
 * Convert a legacy page's HTML (a full document or a body fragment) to page
 * blocks. Never returns an empty array: an empty or unreadable page is one
 * empty paragraph.
 *
 * One conversion at a time per process, whoever calls: BlockNote's server
 * editor swaps the process's `window` and `document` for JSDOM while it
 * parses, and two conversions interleaved across an `await` restore each
 * other's globals. Calls queue here in call order; a failed one does not
 * block the next. `resolvePageLink` runs inside the queue, so it must never
 * call `htmlToPageBlocks` itself (it would wait on its own conversion).
 * Other server-editor work that swaps the same globals (apps/pages' site
 * renders) is serialized by its own caller, outside this queue.
 */
export function htmlToPageBlocks(
  html: string,
  options: HtmlToPageBlocksOptions = {}
): Promise<PageBlock[]> {
  const run = () => convertDocument(html, options);
  const result = conversionQueue.then(run, run);
  conversionQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** Tail of the conversion queue: every conversion chains onto it. */
let conversionQueue: Promise<unknown> = Promise.resolve();

async function convertDocument(
  html: string,
  options: HtmlToPageBlocksOptions
): Promise<PageBlock[]> {
  const editor = getServerEditor();
  const ctx: Context = { editor, parser: await domParser(editor), inColumn: false };
  const body =
    typeof html === 'string' && html.trim() ? await prepareDocument(html, options, ctx) : '';
  const blocks = body ? await convertFragment(body, ctx) : [];
  // The spacer above a heading that opens the document would be a blank
  // line at the top of the page: dropped.
  if ((blocks[0] as Block | undefined)?.[SPACER] && blocks[1]?.type === 'heading') blocks.shift();
  return normalizeBlocks(blocks, editor);
}

/**
 * Marks the empty paragraph the converter puts above a heading (the old
 * viewer's spacing), so the one opening a document can be told from an empty
 * paragraph the HTML itself had. A symbol key survives the copies
 * `placeWidgets` makes; `cleanBlock` drops it.
 */
const SPACER: unique symbol = Symbol('heading spacer');

type Block = PageBlock & { [SPACER]?: true };

function spacer(): Block {
  return { type: 'paragraph', content: [], [SPACER]: true };
}

interface Context {
  editor: PageServerEditor;
  parser: DOMParser;
  /** Converting a column's contents: columns found here are stacked, not nested. */
  inColumn: boolean;
}

const windows = new WeakMap<PageServerEditor, typeof globalThis>();

/**
 * A DOMParser from the server editor's own JSDOM window, so this package needs
 * no DOM of its own. Only the constructor is taken from the swapped globals;
 * the documents it makes work outside `_withJSDOM`.
 */
async function domParser(editor: PageServerEditor): Promise<DOMParser> {
  let win = windows.get(editor);
  if (!win) {
    win = await editor._withJSDOM(async () => globalThis.window as unknown as typeof globalThis);
    windows.set(editor, win);
  }
  return new win.DOMParser();
}

/* ------------------------------------------------------------------ *
 * Pass 1: the whole document
 * ------------------------------------------------------------------ */

async function prepareDocument(
  html: string,
  options: HtmlToPageBlocksOptions,
  ctx: Context
): Promise<string> {
  const doc = ctx.parser.parseFromString(html, 'text/html');
  const body = doc.body;
  if (!body) return '';

  const cssColors = cssHeadingColors(doc);

  // The title and subtitle live on the page row. A full document's first
  // <h1> was always dropped; with the title known, only when it IS the title.
  const fullDocument = /<body[\s>]/i.test(html);
  const firstH1 = [...body.querySelectorAll('h1')].find(h => !h.closest(CODE_SELECTOR));
  if (firstH1) {
    const isTitle =
      options.title === undefined
        ? fullDocument
        : collapse(firstH1.textContent) === collapse(options.title);
    if (isTitle) firstH1.remove();
  }
  if (fullDocument) body.querySelector('p.subtitle')?.remove();

  // The markdown importer's Notion toggles keep their body base64-encoded in
  // `<details><summary>…</summary><div data-encoded="…"></div></details>`:
  // the body is that HTML, and goes through this pass like the rest.
  for (const holder of body.querySelectorAll('details [data-encoded]')) {
    if (holder.closest(CODE_SELECTOR)) continue;
    const decoded = decodeBase64Utf8(holder.getAttribute('data-encoded') ?? '');
    if (decoded === null) continue;
    const decodedBody = doc.createElement('div');
    decodedBody.innerHTML = decoded;
    holder.replaceWith(...decodedBody.childNodes);
  }
  for (const el of body.querySelectorAll('style, script')) el.remove();
  // Only this pass may mark a resolved page link.
  for (const el of body.querySelectorAll(`[${PAGE_LINK_ATTR}]`)) {
    el.removeAttribute(PAGE_LINK_ATTR);
    el.removeAttribute(PAGE_LINK_TITLE_ATTR);
  }

  // Terminal code without a language class: bash, as the old editor's other
  // terminal blocks carry, so it becomes a terminal block below.
  for (const code of body.querySelectorAll('.terminal-block pre > code')) {
    if (![...code.classList].some(c => c.startsWith('language-'))) {
      code.classList.add('language-bash');
    }
  }

  // Heading colours: the heading's own, else the stylesheet's for its level,
  // as the nearest BlockNote colour. Raw CSS colours never reach a block.
  for (const heading of body.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
    if (heading.closest(CODE_SELECTOR)) continue;
    const own =
      heading.closest('.heading-block')?.getAttribute('data-bg-color') ||
      heading.style.backgroundColor ||
      '';
    const color = blockNoteColor(own || cssColors[Number(heading.tagName[1])] || '');
    heading.style.removeProperty('background-color');
    heading.style.removeProperty('background');
    if (!heading.getAttribute('style')) heading.removeAttribute('style');
    if (color === 'default') heading.removeAttribute('data-background-color');
    else heading.setAttribute('data-background-color', color);
  }

  // Image alignment (`image-align-center` / `-right` on the wrapper).
  for (const img of body.querySelectorAll('img')) {
    const wrapper = img.closest('[class*="image-align-"]');
    const align = wrapper
      ? [...wrapper.classList].find(c => c.startsWith('image-align-'))?.slice('image-align-'.length)
      : undefined;
    if (align !== 'center' && align !== 'right') continue;
    img.setAttribute('data-text-alignment', align);
    img.closest('figure')?.setAttribute('data-text-alignment', align);
  }

  await resolvePageLinks(body, options.resolvePageLink);

  return body.innerHTML.trim();
}

/** `h1 { background-color: … }` … `h6` rules from the document's stylesheets. */
function cssHeadingColors(doc: Document): Record<number, string> {
  const css = [...doc.querySelectorAll('style')].map(s => s.textContent ?? '').join('\n');
  const out: Record<number, string> = {};
  for (let level = 1; level <= 6; level++) {
    const match = css.match(
      new RegExp(`(?:^|[},\\s])h${level}\\s*\\{[^}]*background-color:\\s*([^;}]+)`, 'i')
    );
    if (match) out[level] = match[1].trim();
  }
  return out;
}

/**
 * Old page links: inline `/<slug>/pages/<id>` hrefs become the resolver's
 * href, and old page-link widgets are marked for a `pageLink` block. Anything
 * the resolver does not know is left alone.
 */
async function resolvePageLinks(
  body: HTMLElement,
  resolve: HtmlToPageBlocksOptions['resolvePageLink']
): Promise<void> {
  if (!resolve) return;

  const lookups = new Map<string, Promise<string | null | undefined>>();
  const lookup = (slug: string, pageId: string) => {
    const key = `${slug}\n${pageId}`;
    let found = lookups.get(key);
    if (!found) {
      found = Promise.resolve()
        .then(() => resolve(slug, pageId))
        .catch(() => null);
      lookups.set(key, found);
    }
    return found;
  };

  const work: Array<Promise<void>> = [];

  for (const widget of body.querySelectorAll('.page-link-block')) {
    if (widget.closest(CODE_SELECTOR)) continue;
    const anchor = widget.querySelector('a[href]');
    const match = anchor?.getAttribute('href')?.match(ANY_PAGE_HREF);
    if (!anchor || !match) continue;
    const pageId = anchor.getAttribute('data-page-id') || match[2];
    const title = squash(
      widget.querySelector('.page-link-title')?.textContent ?? anchor.textContent
    );
    work.push(
      lookup(match[1], pageId).then(href => {
        if (!href) return;
        widget.setAttribute(PAGE_LINK_ATTR, pageId);
        widget.setAttribute(PAGE_LINK_TITLE_ATTR, title);
      })
    );
  }

  for (const anchor of body.querySelectorAll('a[href]')) {
    if (anchor.closest('.page-link-block') || anchor.closest(CODE_SELECTOR)) continue;
    const match = anchor.getAttribute('href')?.match(LEGACY_PAGE_HREF);
    if (!match) continue;
    work.push(
      lookup(match[1], match[2]).then(href => {
        if (href) anchor.setAttribute('href', href);
      })
    );
  }

  await Promise.all(work);
}

/* ------------------------------------------------------------------ *
 * Pass 2: a fragment
 * ------------------------------------------------------------------ */

type Widget =
  | { kind: 'callout'; emoji: string; inner: string }
  | { kind: 'checklist'; checked: boolean; inner: string }
  | { kind: 'filetree'; text: string }
  | { kind: 'details'; summary: string; inner: string }
  | { kind: 'columns'; columns: string[] }
  | { kind: 'pageLink'; pageId: string; pageTitle: string }
  | { kind: 'terminal'; title: string; pre: string };

/** Blocks for a body fragment (no title handling), widgets included. */
async function convertFragment(html: string, ctx: Context): Promise<PageBlock[]> {
  if (!html.trim()) return [];
  const doc = ctx.parser.parseFromString(`<body>${html}</body>`, 'text/html');
  const widgets = liftWidgets(doc);
  splitInlineImages(doc);
  const bodyHtml = placeholderMedia(doc.body.innerHTML.trim());
  if (!bodyHtml) return [];

  const parsed = (await ctx.editor.tryParseHTMLToBlocks(bodyHtml)) as unknown as PageBlock[];
  const blocks = postProcessBlocks(parsed);
  return widgets.length ? placeWidgets(blocks, widgets, ctx) : blocks;
}

/** Replace each outermost widget with a marker paragraph; returns the widgets by marker number. */
function liftWidgets(doc: Document): Widget[] {
  const widgets: Widget[] = [];
  const found = [...doc.body.querySelectorAll(WIDGET_SELECTOR)].filter(
    el => !el.parentElement?.closest(CODE_SELECTOR) && !el.parentElement?.closest(WIDGET_SELECTOR)
  );

  for (const el of found) {
    const widget = readWidget(el);
    if (!widget) continue;
    const marker = doc.createElement('p');
    marker.textContent = `${MARKER}${widgets.length}`;
    el.replaceWith(marker);
    widgets.push(widget);
  }
  return widgets;
}

function readWidget(el: Element): Widget | null {
  if (el.matches('.callout')) {
    const emoji = el.querySelector(':scope > .callout-emoji')?.textContent?.trim() || '💡';
    return {
      kind: 'callout',
      emoji,
      inner: widgetInner(el, '<br>', c => c.matches('.callout-emoji')),
    };
  }
  if (el.matches('.alert')) {
    const type =
      el.getAttribute('data-type') ||
      [...el.classList].find(c => c.startsWith('alert-'))?.slice('alert-'.length) ||
      'info';
    return { kind: 'callout', emoji: ALERT_EMOJI[type] ?? '💡', inner: widgetInner(el, '<br>') };
  }
  if (el.matches('.checklist-item')) {
    const box = el.querySelector('input[type=checkbox]');
    return {
      kind: 'checklist',
      checked: !!box?.hasAttribute('checked'),
      inner: widgetInner(el, ' ', c => c === box),
    };
  }
  if (el.matches('.file-tree')) {
    const text = el.querySelector('pre')?.textContent ?? el.textContent ?? '';
    return { kind: 'filetree', text: text.replace(/\n+$/, '') };
  }
  if (el.matches('details')) {
    const summary = el.querySelector(':scope > summary');
    const rest = el.cloneNode(true) as Element;
    rest.querySelector(':scope > summary')?.remove();
    return { kind: 'details', summary: summary?.innerHTML ?? '', inner: rest.innerHTML };
  }
  if (el.matches('.columns')) {
    const columns = el.querySelectorAll(':scope > .column');
    const cells = columns.length ? [...columns] : [...el.children];
    return { kind: 'columns', columns: cells.map(c => c.innerHTML) };
  }
  if (el.matches('.terminal-block')) {
    // The title the old editor showed in the header ("Terminal" unless the
    // author named it); the code is the block's <pre>, wherever it sits (an
    // imported terminal may hold a whole code-block widget).
    const pre = el.querySelector('pre');
    const language = [...(pre?.querySelector('code')?.classList ?? [])]
      .find(c => c.startsWith('language-'))
      ?.slice('language-'.length)
      .toLowerCase();
    const title =
      squash(el.querySelector('.terminal-title')?.textContent) ||
      (language === 'powershell' ? 'powershell' : 'Terminal');
    return { kind: 'terminal', title, pre: pre?.outerHTML ?? '' };
  }
  if (el.matches(`.page-link-block[${PAGE_LINK_ATTR}]`)) {
    return {
      kind: 'pageLink',
      pageId: el.getAttribute(PAGE_LINK_ATTR) ?? '',
      pageTitle: el.getAttribute(PAGE_LINK_TITLE_ATTR) ?? '',
    };
  }
  return null;
}

/**
 * A widget's inline HTML: its element children's contents joined by `sep`
 * (the old editor wrapped each line in its own span), or, when it has loose
 * text of its own, its whole contents. `skip` drops chrome (the emoji, the
 * checkbox).
 */
function widgetInner(el: Element, sep: string, skip: (child: Element) => boolean = () => false) {
  const clone = el.cloneNode(true) as Element;
  const originals = [...el.children];
  [...clone.children].forEach((child, i) => {
    if (skip(originals[i])) child.remove();
  });
  const looseText = [...clone.childNodes].some(
    n => n.nodeType === TEXT_NODE && (n.textContent ?? '').trim()
  );
  if (looseText || clone.children.length === 0) return clone.innerHTML;
  return [...clone.children].map(c => c.innerHTML).join(sep);
}

/**
 * An image inside a paragraph of text, which BlockNote's parser drops: the
 * paragraph is split around it, text before, the image as `<p><img></p>`
 * (an image of its own, `placeholderMedia`), text after, in reading order.
 * Inline formatting on either side is kept (the split clones the open
 * elements). Images in table cells are left to the parser, and so is a
 * paragraph with no text (an image alone, or a linked image, parses as is).
 */
function splitInlineImages(doc: Document): void {
  /** The next image to split out: its paragraph, and its src. */
  const next = () => {
    for (const img of doc.body.querySelectorAll('img')) {
      const p = img.closest('p');
      const src = img.getAttribute('src')?.trim();
      if (!p || !src || img.closest(CODE_SELECTOR) || img.closest('td, th')) continue;
      if ((p.textContent ?? '').trim()) return { img, p, src };
    }
    return null;
  };
  const hasContent = (el: Element) => !!(el.textContent ?? '').trim() || !!el.querySelector('img');

  for (let found = next(); found; found = next()) {
    const { img, p, src } = found;
    const range = doc.createRange();
    range.setStart(p, 0);
    range.setEndBefore(img);
    const before = p.cloneNode(false) as Element;
    before.append(range.cloneContents());
    range.setStartAfter(img);
    range.setEnd(p, p.childNodes.length);
    const after = p.cloneNode(false) as Element;
    after.append(range.cloneContents());

    const image = doc.createElement('p');
    const bare = doc.createElement('img');
    bare.setAttribute('src', src);
    image.append(bare);

    p.replaceWith(...[before, image, after].filter(el => el === image || hasContent(el)));
  }
}

/**
 * Video embeds and images inside list items, which BlockNote's parser drops,
 * as placeholder paragraphs `postProcessBlocks` turns into blocks.
 */
function placeholderMedia(html: string): string {
  return (
    html
      // iframe embeds (YouTube, Vimeo, ...)
      .replace(
        /<div class="video-embed">\s*<iframe[^>]*src="([^"]*)"[^>]*><\/iframe>\s*<\/div>/g,
        '<p class="VIDEO_EMBED_PLACEHOLDER">VIDEO_EMBED:::$1</p>'
      )
      // <video> with <source> children
      .replace(
        /<div class="video-embed">\s*<video[^>]*>\s*<source\s+src="([^"]*)"[^>]*>[^<]*<\/video>\s*<\/div>/g,
        '<p class="VIDEO_EMBED_PLACEHOLDER">VIDEO_EMBED:::$1</p>'
      )
      // <video src>
      .replace(
        /<div class="video-embed">\s*<video[^>]*src="([^"]*)"[^>]*>[^<]*<\/video>\s*<\/div>/g,
        '<p class="VIDEO_EMBED_PLACEHOLDER">VIDEO_EMBED:::$1</p>'
      )
      // An image alone in a <p> (typically in a list item): BlockNote drops
      // it there. Standalone images use <figure> and parse fine.
      .replace(/<p>\s*<img\s+src="([^"]*)"[^>]*>\s*<\/p>/g, '<p>IMAGE_EMBED:::$1</p>')
  );
}

/** Each marker replaced by its widget's blocks, wherever the parser put it. */
async function placeWidgets(
  blocks: PageBlock[],
  widgets: Widget[],
  ctx: Context
): Promise<PageBlock[]> {
  const out: PageBlock[] = [];
  for (const block of blocks) {
    const children = block.children?.length
      ? await placeWidgets(block.children, widgets, ctx)
      : block.children;

    // A marker that is the whole block (a paragraph, or a list item whose
    // only content it is): the widget takes the block's place, and a list
    // item's children follow it.
    const whole = blockText(block).trim().match(MARKER_ONLY);
    if (whole && (block.type === 'paragraph' || isListItem(block.type))) {
      out.push(...(await buildWidget(widgets[Number(whole[1])], ctx)));
      if (children?.length) out.push(...children);
      continue;
    }

    // A marker sharing a block with other content: the block keeps the rest,
    // the widget follows it.
    const found: number[] = [];
    const content = stripMarkers(block.content, found);
    const next = { ...block };
    if (content !== block.content) next.content = content;
    if (children !== block.children) next.children = children;
    out.push(next);
    for (const n of found) out.push(...(await buildWidget(widgets[n], ctx)));
  }
  return out;
}

/** `content` without marker text; marker numbers are pushed onto `found`. */
function stripMarkers(content: unknown, found: number[]): unknown {
  if (Array.isArray(content)) {
    const items = content as InlineItem[];
    if (!JSON.stringify(items).includes(MARKER)) return content;
    const out: InlineItem[] = [];
    for (const item of items) {
      if (item.type === 'text' && typeof item.text === 'string') {
        const text = item.text.replace(MARKER_ANY, (_, n: string) => {
          found.push(Number(n));
          return '';
        });
        if (text) out.push({ ...item, text });
      } else if (Array.isArray(item.content)) {
        out.push({ ...item, content: stripMarkers(item.content, found) as InlineItem[] });
      } else {
        out.push(item);
      }
    }
    return out;
  }
  // Table content: markers in cells.
  if (
    content &&
    typeof content === 'object' &&
    (content as { type?: unknown }).type === 'tableContent'
  ) {
    const table = content as { rows?: Array<{ cells?: unknown[] }> };
    if (!JSON.stringify(table).includes(MARKER)) return content;
    return {
      ...table,
      rows: (table.rows ?? []).map(row => ({
        ...row,
        cells: (row.cells ?? []).map(cell =>
          Array.isArray(cell)
            ? stripMarkers(cell, found)
            : cell && typeof cell === 'object'
              ? { ...cell, content: stripMarkers((cell as { content?: unknown }).content, found) }
              : cell
        ),
      })),
    };
  }
  return content;
}

async function buildWidget(widget: Widget | undefined, ctx: Context): Promise<PageBlock[]> {
  if (!widget) return [];
  switch (widget.kind) {
    case 'callout':
      return [
        {
          type: 'callout',
          props: { emoji: widget.emoji },
          content: await inlineOf(widget.inner, ctx),
        },
      ];
    case 'checklist':
      return [
        {
          type: 'checkListItem',
          props: { checked: widget.checked },
          content: await inlineOf(widget.inner, ctx),
        },
      ];
    case 'filetree':
      return [
        {
          type: 'codeBlock',
          props: { language: 'text' },
          content: widget.text ? [{ type: 'text', text: widget.text, styles: {} }] : [],
        },
      ];
    case 'details':
      return [
        spacer(),
        {
          type: 'heading',
          props: { level: 3, isToggleable: true },
          content: await inlineOf(widget.summary, ctx),
          children: await convertFragment(widget.inner, ctx),
        },
      ];
    case 'columns': {
      const columns: PageBlock[][] = [];
      for (const html of widget.columns) {
        columns.push(await convertFragment(html, { ...ctx, inColumn: true }));
      }
      const filled = columns.filter(blocks => !isBlank(blocks));
      // A row needs two columns (one would leave the document unopenable),
      // and a row inside a column is the same: stack the content instead.
      if (filled.length < 2 || ctx.inColumn) return filled.flat();
      return [
        {
          type: 'columnList',
          children: filled.map(children => ({ type: 'column', props: { width: 1 }, children })),
        },
      ];
    }
    case 'pageLink':
      return [{ type: 'pageLink', props: { pageId: widget.pageId, pageTitle: widget.pageTitle } }];
    case 'terminal': {
      // The code as BlockNote's parser reads the <pre> (what a code block
      // before the terminal rule would hold).
      const parsed = widget.pre
        ? ((await ctx.editor.tryParseHTMLToBlocks(widget.pre)) as unknown as PageBlock[])
        : [];
      const code = parsed.find(b => b.type === 'codeBlock');
      return [
        { type: 'terminal', props: { title: widget.title, code: code ? blockText(code) : '' } },
      ];
    }
  }
}

/** Inline content of an HTML fragment; its blocks' lines joined by hard breaks. */
async function inlineOf(html: string, ctx: Context): Promise<InlineItem[]> {
  if (!html.trim()) return [];
  const blocks = (await ctx.editor.tryParseHTMLToBlocks(
    `<p>${html}</p>`
  )) as unknown as PageBlock[];
  const out: InlineItem[] = [];
  const walk = (list: PageBlock[]) => {
    for (const block of list) {
      if (Array.isArray(block.content) && block.content.length) {
        if (out.length) out.push({ type: 'text', text: '\n', styles: {} });
        out.push(...(block.content as InlineItem[]));
      }
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
  return out;
}

/** No blocks, or only empty paragraphs. */
function isBlank(blocks: PageBlock[]): boolean {
  return blocks.every(b => b.type === 'paragraph' && !blockText(b).trim() && !b.children?.length);
}

/**
 * Map the patterns BlockNote's parser leaves behind to page blocks:
 * code-block header labels (dropped), bash/powershell code (terminal),
 * placeholders for videos and list-item images, terminal titles before code,
 * and old widget markup that reached the parser as escaped text. Adds the
 * empty paragraph the old editor showed above every heading (`spacer`; the
 * one above a heading that opens the document is dropped later).
 */
function postProcessBlocks(blocks: PageBlock[]): PageBlock[] {
  const result: PageBlock[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // Code-block headers (language name and/or line numbers) parse as
    // paragraphs just before the code: drop them.
    if (block.type === 'paragraph' && i + 1 < blocks.length) {
      const next = blocks[i + 1];
      const afterNext = i + 2 < blocks.length ? blocks[i + 2] : null;
      const nextIsLabel =
        next.type === 'paragraph' && CODE_HEADER_LABEL.test(plainText(next).trim());
      if (
        CODE_HEADER_LABEL.test(plainText(block).trim()) &&
        (isCode(next) || (nextIsLabel && afterNext && isCode(afterNext)))
      ) {
        continue;
      }
    }

    if (block.type === 'heading') {
      result.push(spacer());
      if (block.children?.length) block.children = postProcessBlocks(block.children);
      result.push(block);
      continue;
    }

    // bash / powershell code is a terminal. Before any language
    // canonicalisation, which would turn `bash` into `shellscript`.
    if (block.type === 'codeBlock') {
      const language = String(block.props?.language ?? '').toLowerCase();
      if (language === 'powershell' || language === 'bash') {
        result.push({
          type: 'terminal',
          props: {
            title: language === 'powershell' ? 'powershell' : 'Terminal',
            code: blockText(block),
          },
        });
        continue;
      }
    }

    if (block.type !== 'paragraph') {
      // A list item holding only an image placeholder is the image.
      if (isListItem(block.type)) {
        const text = plainText(block);
        if (text.startsWith('IMAGE_EMBED:::')) {
          const url = text.slice('IMAGE_EMBED:::'.length).trim();
          if (url) {
            result.push(placeholderImage(url));
            if (block.children?.length) result.push(...postProcessBlocks(block.children));
            continue;
          }
        }
      }
      if (block.children?.length) block.children = postProcessBlocks(block.children);
      result.push(block);
      continue;
    }

    // Plain text runs only, links left out (the old converter's rule): a
    // linked label is content, never a code header or a terminal title.
    const text = plainText(block);

    if (text.startsWith('VIDEO_EMBED:::')) {
      const url = text.slice('VIDEO_EMBED:::'.length).trim();
      if (url) {
        result.push({ type: 'video', props: { url, caption: '' } });
        continue;
      }
    }

    if (text.startsWith('IMAGE_EMBED:::')) {
      const url = text.slice('IMAGE_EMBED:::'.length).trim();
      if (url) {
        result.push(placeholderImage(url));
        continue;
      }
    }

    // A "Terminal" / "powershell" title paragraph followed by code.
    if (i + 1 < blocks.length && blocks[i + 1].type === 'codeBlock') {
      const lower = text.toLowerCase();
      if (lower.includes('terminal') || lower.includes('powershell')) {
        result.push({ type: 'terminal', props: { title: text, code: blockText(blocks[i + 1]) } });
        i++;
        continue;
      }
    }

    const escaped = Array.isArray(block.content)
      ? escapedWidget(block.content as InlineItem[])
      : null;
    if (escaped) {
      result.push(escaped);
      continue;
    }

    if (block.children?.length) block.children = postProcessBlocks(block.children);
    result.push(block);
  }

  return result;
}

/** A language name and/or line numbers: "JavaScript", "JavaScript 123", "1234567". */
const CODE_HEADER_LABEL = /^(?:[a-z]+(?:[\s\n]+\d+)?|\d+)$/i;

/**
 * Old widget markup that reached the parser as text (escaped HTML inside a
 * paragraph): the block it stands for, or null.
 */
function escapedWidget(content: InlineItem[]): PageBlock | null {
  for (const item of content) {
    if (item.type !== 'text' || !item.text) continue;
    const html = item.text;

    if (html.includes('class="terminal-block"')) {
      const title = html.match(/class="terminal-title">([^<]*)</)?.[1] ?? '';
      const code = html.match(/<code[^>]*>([\s\S]*?)<\/code>/)?.[1] ?? '';
      return { type: 'terminal', props: { title, code: decodeHtmlEntities(code) } };
    }

    if (html.includes('class="code-block"')) {
      const code = decodeHtmlEntities(html.match(/<code[^>]*>([\s\S]*?)<\/code>/)?.[1] ?? '');
      const lang = html.match(/<span class="code-lang">(terminal|powershell)<\/span>/i);
      if (lang) return { type: 'terminal', props: { title: lang[1], code } };

      // "Terminal" / "powershell" before the code block: its title.
      const keyword = html.match(/Terminal|powershell/i);
      const codeAt = html.indexOf('class="code-block"');
      if (keyword?.index !== undefined && keyword.index < codeAt) {
        const before = html.slice(0, keyword.index);
        const title = before.match(/>([^<]+)<[^>]*$/)?.[1]?.trim() || keyword[0];
        return { type: 'terminal', props: { title, code } };
      }

      const language = html.match(/class="language-(\w+)"/)?.[1] ?? 'javascript';
      return { type: 'codeBlock', props: { language }, content: textRun(code) };
    }

    if (html.includes('class="callout"')) {
      const emoji = html.match(/class="callout-emoji">([^<]*)</)?.[1] || '💡';
      const text = html.match(/callout-emoji">[^<]*<\/span>\s*<span>([\s\S]*?)<\/span>/)?.[1] ?? '';
      return { type: 'callout', props: { emoji }, content: textRun(text) };
    }

    if (html.includes('class="alert')) {
      const type = html.match(/data-type="(\w+)"/)?.[1] ?? 'info';
      const text = html.match(/<span>([\s\S]*?)<\/span>/)?.[1] ?? '';
      return {
        type: 'callout',
        props: { emoji: ALERT_EMOJI[type] ?? '💡' },
        content: textRun(text),
      };
    }

    if (html.includes('class="file-tree"')) {
      const tree = html.match(/<pre>([\s\S]*?)<\/pre>/)?.[1] ?? '';
      return {
        type: 'codeBlock',
        props: { language: 'text' },
        content: textRun(decodeHtmlEntities(tree)),
      };
    }

    if (html.includes('class="diff-block"')) {
      // The base64 copy, else (none, unreadable, empty) the <pre> text.
      const data = html.match(/data-content="([^"]*)"/)?.[1];
      let code = data ? (decodeBase64Utf8(data) ?? '') : '';
      if (!code) code = html.match(/<pre>([\s\S]*?)<\/pre>/)?.[1] ?? '';
      return {
        type: 'codeBlock',
        props: { language: 'diff' },
        content: textRun(decodeHtmlEntities(code)),
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Pass 3: the editor's normalisation
 * ------------------------------------------------------------------ */

/**
 * The blocks as the editor would hold them: canonical code languages, code as
 * plain text, BlockNote colour names, then a ProseMirror round trip (every
 * prop filled, a fresh uuid on every block). At least one block.
 */
function normalizeBlocks(blocks: PageBlock[], editor: PageServerEditor): PageBlock[] {
  let clean = blocks.map(cleanBlock);
  clean = normalizeCodeBlockContent(clean);
  if (clean.length === 0) clean = [{ type: 'paragraph', content: [] }];
  const node = editor._blocksToProsemirrorNode(clean as never);
  return editor._prosemirrorNodeToBlocks(node) as unknown as PageBlock[];
}

/** A copy without ids, with canonical languages and colour names. */
function cleanBlock(block: Block): PageBlock {
  const { id: _id, [SPACER]: _spacer, children, props, content, ...rest } = block;
  const out: PageBlock = { ...rest };
  if (props) {
    const next: Record<string, unknown> = { ...props };
    if (block.type === 'codeBlock') next.language = codeBlockDisplayLanguage(next.language);
    for (const key of ['backgroundColor', 'textColor'] as const) {
      if (typeof next[key] === 'string') next[key] = blockNoteColor(next[key] as string, key);
    }
    out.props = next;
  }
  if (content !== undefined) out.content = cleanTableColors(content);
  if (children) out.children = children.map(cleanBlock);
  return out;
}

/** Table cells carry colours of their own. */
function cleanTableColors(content: unknown): unknown {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
  const table = content as { type?: unknown; rows?: Array<{ cells?: unknown[] }> };
  if (table.type !== 'tableContent' || !Array.isArray(table.rows)) return content;
  return {
    ...table,
    rows: table.rows.map(row => ({
      ...row,
      cells: (row.cells ?? []).map(cell => {
        if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return cell;
        const props = (cell as { props?: Record<string, unknown> }).props;
        if (!props) return cell;
        const next = { ...props };
        for (const key of ['backgroundColor', 'textColor'] as const) {
          if (typeof next[key] === 'string') next[key] = blockNoteColor(next[key] as string, key);
        }
        return { ...cell, props: next };
      }),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Colours
 * ------------------------------------------------------------------ */

const COLOR_NAMES = Object.keys(COLORS_DEFAULT) as Array<keyof typeof COLORS_DEFAULT>;

/** Every BlockNote colour as RGB, background and text shade alike. */
const COLOR_SHADES: Array<[string, [number, number, number]]> = COLOR_NAMES.flatMap(name =>
  [COLORS_DEFAULT[name].background, COLORS_DEFAULT[name].text].flatMap(hex => {
    const parsed = parseColor(hex);
    return parsed ? [[name, parsed.rgb] as [string, [number, number, number]]] : [];
  })
);

/**
 * A CSS colour as the nearest BlockNote colour name (`red`, `blue`, ...), or
 * `default` for none, transparent and anything unreadable, and for what reads
 * as no colour at all: a near-white background, a near-black or dark grey
 * text (the page's own ink). BlockNote's names pass through.
 */
function blockNoteColor(
  value: string,
  as: 'backgroundColor' | 'textColor' = 'backgroundColor'
): string {
  const name = value.trim().toLowerCase();
  if (!name || name === 'default') return 'default';
  if ((COLOR_NAMES as string[]).includes(name)) return name;
  if (name === 'grey') return 'gray';
  const parsed = parseColor(name);
  if (!parsed || parsed.alpha === 0) return 'default';
  const [r, g, b] = parsed.rgb;
  if (as === 'backgroundColor' && r >= 245 && g >= 245 && b >= 245) return 'default';
  if (as === 'textColor' && Math.max(r, g, b) < 128 && Math.max(r, g, b) - Math.min(r, g, b) < 32) {
    return 'default';
  }
  let best = 'default';
  let bestDistance = Infinity;
  for (const [shade, [sr, sg, sb]] of COLOR_SHADES) {
    const distance = (sr - r) ** 2 + (sg - g) ** 2 + (sb - b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = shade;
    }
  }
  return best;
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()`; null for anything else. */
function parseColor(value: string): { rgb: [number, number, number]; alpha: number } | null {
  const v = value.trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const [r, g, b] = [...m[1]].map(c => parseInt(c + c, 16));
    return { rgb: [r, g, b], alpha: 1 };
  }
  m = v.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
  if (m) {
    const hex = m[1];
    return {
      rgb: [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number],
      alpha: m[2] ? parseInt(m[2], 16) / 255 : 1,
    };
  }
  m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) {
    return {
      rgb: [Number(m[1]), Number(m[2]), Number(m[3])],
      alpha: m[4] === undefined ? 1 : Number(m[4]),
    };
  }
  if (v === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
  return null;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * An image the old editor wrote inside a `<p>` (alone, in a list item, or
 * mid-paragraph): shown at the old viewer's 512px, as the previous converter
 * stored it. Images from `<figure>` / a bare `<img>` keep BlockNote's width.
 */
function placeholderImage(url: string): PageBlock {
  return { type: 'image', props: { url, caption: '', previewWidth: 512 } };
}

/** Text of a block's inline content, links included (blank and marker checks). */
function blockText(block: PageBlock): string {
  return Array.isArray(block.content) ? inlineText(block.content as InlineItem[]) : '';
}

function inlineText(items: InlineItem[]): string {
  return items
    .map(item =>
      item.type === 'text'
        ? (item.text ?? '')
        : Array.isArray(item.content)
          ? inlineText(item.content)
          : ''
    )
    .join('');
}

/**
 * The block's own plain text runs, links left out: what the cleanup rules
 * (code header labels, terminal titles, media placeholders) read.
 */
function plainText(block: PageBlock): string {
  if (!Array.isArray(block.content)) return '';
  return (block.content as InlineItem[])
    .filter(item => item.type === 'text')
    .map(item => item.text ?? '')
    .join('');
}

function textRun(text: string): InlineItem[] {
  return text ? [{ type: 'text', text, styles: {} }] : [];
}

function isCode(block: PageBlock): boolean {
  return block.type === 'codeBlock' || block.type === 'terminal';
}

function isListItem(type: string): boolean {
  return type === 'bulletListItem' || type === 'numberedListItem' || type === 'checkListItem';
}

/** Whitespace collapsed and trimmed. */
function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** `squash`ed and lower case: how two titles are compared. */
function collapse(text: string | null | undefined): string {
  return squash(text).toLowerCase();
}

/**
 * Strict base64 of UTF-8 text -> the text, or null when it is not: bad
 * characters or length, or bytes that are not UTF-8 (what `atob` and
 * `decodeURIComponent` refused in the old converter). `Buffer.from(…,
 * 'base64')` alone never fails, it skips what it cannot read.
 */
function decodeBase64Utf8(data: string): string | null {
  // `atob`'s forgiving-base64 rules: whitespace ignored, padding optional.
  let clean = data.replace(/[\t\n\f\r ]+/g, '');
  if (clean.length % 4 === 0) clean = clean.replace(/={1,2}$/, '');
  if (clean.length % 4 === 1 || !/^[A-Za-z0-9+/]*$/.test(clean)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(clean, 'base64'));
  } catch {
    return null;
  }
}

/** `&lt;` `&gt;` `&amp;` `&quot;` `&#39;`; other entities are left as they are. */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&lt;': '<',
    '&gt;': '>',
    '&amp;': '&',
    '&quot;': '"',
    '&#39;': "'",
  };
  return text.replace(/&[^;]+;/g, match => entities[match] ?? match);
}
