/**
 * The DOM half of the live deck editor's bridge: reading the Reveal editor's
 * `<section>`s (structure, ids, one slide's saveable html/attributes) and
 * writing slides back into it, without touching Reveal's runtime paint.
 *
 * Pure DOM, no React, no Yjs — the unit suite runs it under jsdom.
 *
 * Serialization goes through the SAME cleanup the git editor's save uses
 * (`cleanupEditorContainer`: contenteditable, hljs spans, the live Sandpack
 * mount, Reveal classes, fragment paint), so what lands in the live deck is
 * what a save would have stored.
 */
import {
  HTML_BLOCK_SELECTOR,
  INERT_ATTR_PREFIX,
  RUNTIME_SECTION_ATTRS,
  RUNTIME_SECTION_CLASSES,
  isBlockedFrameAttr,
  scopeSvgStyles,
  splitStyleDeclarations,
} from '@classmoji/services/slides/runtime-attrs';
import {
  htmlAttrVerdict,
  pageSessionMarker,
  restoreRenamed,
  sanitizeClientInPlace,
  sessionInertName,
} from '@classmoji/services/slides/safe-markup';
import { EDITOR_BLOCK_CLASSES, type DeckStructure } from '@classmoji/collab';

import { cleanSectionAttrs } from '../deckOpsDiff.ts';
import { cleanupEditorContainer, undoRevealLazyLoad } from '../editorCleanup.ts';
import { showFrames, storeFrames, type EditorFrames } from '../editorFrames.ts';
import { mountLegacyHtmlBlocks, restoreLegacyHtmlBlocks } from '../legacyHtmlBlocks.ts';

/** Classes the live editor puts on sections (never authored, never saved). */
export const COLLAB_SECTION_CLASSES = ['cm-locked', 'cm-held'] as const;
const COLLAB_CLASS_SET: ReadonlySet<string> = new Set(COLLAB_SECTION_CLASSES);

/**
 * On a slide someone else holds: the holder's display name (lock chrome, never
 * saved). Editor tools read it through `lockHolderOf` to refuse up front.
 */
export const LOCKED_BY_ATTR = 'data-cm-locked-by';

/** Who holds this slide, when it is someone else (null: free, or yours). */
export function lockHolderOf(section: Element | null | undefined): string | null {
  if (!section || !section.classList.contains('cm-locked')) return null;
  return section.getAttribute(LOCKED_BY_ATTR) || 'Someone';
}

const isSection = (node: Element): boolean => node.tagName.toLowerCase() === 'section';

/** Direct `<section>` children. */
export function sectionChildren(el: Element): HTMLElement[] {
  return Array.from(el.children).filter(isSection) as HTMLElement[];
}

/** The section (leaf, or stack child) an arbitrary node sits in, with an id. */
export function sectionOf(node: Node | null, container: Element): HTMLElement | null {
  let el: Element | null =
    node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
  while (el && el !== container) {
    if (isSection(el) && el.hasAttribute('data-cm-id')) {
      // A stack container is not "a slide" for editing; its children are.
      if (sectionChildren(el).length === 0) return el as HTMLElement;
    }
    el = el.parentElement;
  }
  return null;
}

export interface DomScan {
  structure: DeckStructure;
  elements: Map<string, HTMLElement>;
  /** Ids stamped on sections that had none (new) or a duplicate (copied). */
  minted: string[];
}

/**
 * The editor's structure, stamping a fresh `data-cm-id` on every section that
 * has none (a slide the toolbar just added, a stack wrapper the overview just
 * made) or repeats an earlier one (a copied slide). Ids are minted
 * client-side in live mode: there is no save for the server to mint them on.
 */
export function scanDeckDom(container: Element, mint: (taken: Set<string>) => string): DomScan {
  const scopes = new Map<string | null, string[]>([[null, []]]);
  const containers = new Set<string>();
  const elements = new Map<string, HTMLElement>();
  const minted: string[] = [];
  const taken = new Set<string>();

  const idOf = (el: HTMLElement): string => {
    let id = el.getAttribute('data-cm-id');
    if (!id || taken.has(id)) {
      id = mint(taken);
      el.setAttribute('data-cm-id', id);
      minted.push(id);
    }
    taken.add(id);
    elements.set(id, el);
    return id;
  };

  for (const root of sectionChildren(container)) {
    const id = idOf(root);
    (scopes.get(null) as string[]).push(id);
    const kids = sectionChildren(root);
    if (kids.length > 0) {
      containers.add(id);
      scopes.set(
        id,
        kids.map(kid => idOf(kid))
      );
    }
  }
  return { structure: { scopes, containers }, elements, minted };
}

export interface SerializedSection {
  /** Inner html minus notes and child sections; undefined for a stack container. */
  html: string | undefined;
  /** Saveable attributes, in DOM order (data-cm-id, data-hidden and runtime paint excluded). */
  attrs: Record<string, string>;
  hidden: boolean;
  /** Notes asides found inside the section (they belong in the notes field). */
  asideNotes: string | null;
}

/**
 * Editor DOM (a copy of it) back to what the deck stores, in place: legacy
 * html blocks get their inline code back, frames their stored references
 * (`frames`: this deck's editor frame context, when frames are shown through
 * it), markup renamed for display its authored names, and the git editor's
 * cleanup run. The one path every write takes. `lazyLoad`: also undo Reveal's
 * lazy loading (the live deck's per-slide serialization).
 */
export function toStoredMarkup(
  holder: Element,
  frames: EditorFrames | null = null,
  { lazyLoad = true }: { lazyLoad?: boolean } = {}
): void {
  restoreLegacyHtmlBlocks(holder);
  // Before the lazy-load undo: `src` and `data-src` reduce to one stored value.
  storeFrames(holder, frames);
  restoreInertMarkup(holder);
  if (lazyLoad) undoRevealLazyLoad(holder);
  cleanupEditorContainer(holder);
}

/**
 * One section as the live deck stores it, through the git editor's cleanup.
 * The live element is not touched.
 */
export function serializeSection(
  el: HTMLElement,
  frames: EditorFrames | null = null
): SerializedSection {
  const holder = el.ownerDocument.createElement('div');
  const clone = el.cloneNode(true) as HTMLElement;
  holder.appendChild(clone);
  toStoredMarkup(holder, frames);

  const kids = sectionChildren(clone);
  const container = kids.length > 0;
  for (const kid of kids) kid.remove();

  const asides = Array.from(clone.querySelectorAll('aside')).filter(
    aside => aside.classList.contains('notes') && aside.closest('section') === clone
  );
  const asideNotes = asides.length > 0 ? asides.map(a => a.innerHTML).join('\n') : null;
  for (const aside of asides) aside.remove();

  // Lock chrome (read-only marking for assistive tech) is never content.
  if (clone.classList.contains('cm-locked')) {
    clone.removeAttribute('aria-readonly');
    clone.removeAttribute('aria-describedby');
  }
  clone.removeAttribute(LOCKED_BY_ATTR);
  for (const cls of COLLAB_SECTION_CLASSES) clone.classList.remove(cls);
  // An open block editor (BlockHandles) is editor state, never content.
  for (const block of Array.from(clone.querySelectorAll('.sl-block'))) {
    for (const cls of EDITOR_BLOCK_CLASSES) block.classList.remove(cls);
  }
  if ((clone.getAttribute('class') ?? '') === '') clone.removeAttribute('class');

  return {
    html: container ? undefined : clone.innerHTML,
    attrs: cleanSectionAttrs(clone),
    hidden: el.getAttribute('data-hidden') === 'true',
    asideNotes,
  };
}

const RUNTIME_STYLE_RE = /^\s*(?:display|top)\s*:/i;

/** Whether a section attribute may render as authored (the slide markup lists). */
function isRenderableSectionAttr(name: string, value: string): boolean {
  const verdict = htmlAttrVerdict(name.toLowerCase(), value, {
    tag: 'section',
    inHtmlBlock: false,
    sandbox: null,
  });
  return verdict.keep && (verdict.value === undefined || verdict.value === value);
}

/**
 * Give a live section exactly the authored attributes `attrs` (+ data-hidden),
 * keeping whatever Reveal and the editor painted on it at runtime (position
 * classes, computed display/top, data-index-*, contenteditable, our lock
 * classes), so a remote attribute change never disturbs navigation.
 */
export function applySectionAttrs(
  el: HTMLElement,
  attrs: Readonly<Record<string, string>>,
  hidden: boolean
): void {
  const keepAlways = new Set([
    'data-cm-id',
    'contenteditable',
    'data-hidden',
    // lock chrome, managed by the bridge
    'aria-readonly',
    'aria-describedby',
    LOCKED_BY_ATTR,
  ]);
  // Display-only renames carry this page's marker (`restoreInertMarkup`).
  const sessionPrefix = sessionInertName(pageSessionMarker(), '');
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (keepAlways.has(name) || RUNTIME_SECTION_ATTRS.has(name)) continue;
    if (name === 'hidden' || name === 'aria-hidden') continue;
    if (name === 'class' || name === 'style') continue;
    const authored = name.startsWith(sessionPrefix)
      ? attr.name.slice(sessionPrefix.length)
      : attr.name;
    if (!(authored in attrs) && !(attr.name in attrs)) el.removeAttribute(attr.name);
  }

  for (const [name, value] of Object.entries(attrs)) {
    const lower = name.toLowerCase();
    if (lower === 'class' || lower === 'style') continue;
    if (lower.startsWith(sessionPrefix)) {
      // Shown inert by the caller (a frame that must not load): kept so.
      if (el.getAttribute(name) !== value) el.setAttribute(name, value);
      continue;
    }
    const inertName = `${sessionPrefix}${name}`;
    if (!isRenderableSectionAttr(name, value)) {
      // Kept (under this page's inert name) so it is written back as authored.
      if (el.hasAttribute(name)) el.removeAttribute(name);
      if (el.getAttribute(inertName) !== value) el.setAttribute(inertName, value);
      continue;
    }
    if (el.hasAttribute(inertName)) el.removeAttribute(inertName);
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  // class: authored + runtime currently present.
  const runtimeClasses = Array.from(el.classList).filter(
    c => RUNTIME_SECTION_CLASSES.has(c) || COLLAB_CLASS_SET.has(c)
  );
  const authored = (attrs.class ?? '').split(/\s+/).filter(Boolean);
  const nextClass = [...authored, ...runtimeClasses.filter(c => !authored.includes(c))].join(' ');
  if ((el.getAttribute('class') ?? '') !== nextClass) {
    if (nextClass) el.setAttribute('class', nextClass);
    else el.removeAttribute('class');
  }

  // style: authored + Reveal's computed display/top.
  const runtimeStyle = splitStyleDeclarations(el.getAttribute('style') ?? '')
    .map(p => p.trim())
    .filter(p => p && RUNTIME_STYLE_RE.test(p));
  const authoredStyle = splitStyleDeclarations(attrs.style ?? '')
    .map(p => p.trim())
    .filter(p => p && !RUNTIME_STYLE_RE.test(p));
  const nextStyle = [...authoredStyle, ...runtimeStyle].join('; ');
  const styleValue = nextStyle ? `${nextStyle};` : '';
  if ((el.getAttribute('style') ?? '') !== styleValue) {
    if (styleValue) el.setAttribute('style', styleValue);
    else el.removeAttribute('style');
  }

  if (hidden) {
    if (el.getAttribute('data-hidden') !== 'true') el.setAttribute('data-hidden', 'true');
    el.classList.add('slide-hidden');
  } else {
    if (el.hasAttribute('data-hidden')) el.removeAttribute('data-hidden');
    el.classList.remove('slide-hidden');
  }
}

/** What the editor needs to show slide markup beyond the markup lists. */
export interface EditorDisplay {
  /** This deck's frame context: frames of ours shown through the editor frame route. */
  frames?: EditorFrames | null;
  /** The content service origin: legacy html blocks shown through its preview frame. */
  contentOrigin?: string | null;
}

/**
 * Slide markup made safe to show in the editor, in place (the children of
 * `root`): held to the slide markup lists in rename mode — what may not
 * render is renamed or hidden under this page's session marker, never lost
 * (`restoreInertMarkup` puts it back) — svg-block sheets scoped to their
 * drawing, frames shown the editor's way, legacy html blocks through the
 * preview frame.
 *
 * Run ONCE per piece of markup: a second pass would hide the hidden nodes'
 * holders again.
 */
export function stripUnsafeMarkup(
  root: Element | DocumentFragment,
  display: EditorDisplay = {}
): void {
  sanitizeClientInPlace(root, { mode: 'rename', marker: pageSessionMarker() });
  // The scoping IS written back: it is idempotent and the server stores the
  // same scoped form, so the doc converges to it.
  for (const content of Array.from(
    root.querySelectorAll('.sl-block[data-block-type="svg"] > .sl-block-content')
  )) {
    scopeSvgStyles(content);
  }
  showFrames(root, display.frames ?? null);
  mountLegacyHtmlBlocks(root, display.contentOrigin ?? display.frames?.contentOrigin ?? null);
}

/** Html-block frame sources the stored form may keep under their inert name. */
const STORED_INERT_FRAME_ATTRS = ['srcdoc', 'src', 'data-src', 'allow'];

/**
 * Undo `stripUnsafeMarkup`, in place: what this page renamed or hid for
 * display gets its authored form back (`restoreRenamed` with this page's
 * marker). Inert names carrying any other marker, or none, stay as the plain
 * data attributes they are — except an html-block frame source stored inert
 * (`data-cm-inert-src`, …) that the frame rule no longer blocks, which goes
 * back to its name as it always has.
 */
export function restoreInertMarkup(root: Element | DocumentFragment): void {
  restoreRenamed(root, pageSessionMarker());
  for (const el of elementsUnder(root)) {
    if (el.localName !== 'iframe' || el.closest(HTML_BLOCK_SELECTOR) === null) continue;
    const attrs = Array.from(el.attributes);
    const unblocked = (name: string): string | null => {
      if (!name.startsWith(INERT_PREFIX)) return null;
      const original = name.slice(INERT_PREFIX.length);
      if (!STORED_INERT_FRAME_ATTRS.includes(original) || el.hasAttribute(original)) return null;
      const blocked = isBlockedFrameAttr(
        'iframe',
        original,
        el.getAttribute('sandbox'),
        true,
        el.getAttribute(name)
      );
      return blocked ? null : original;
    };
    if (!attrs.some(attr => unblocked(attr.name) !== null)) continue;
    rebuildAttributes(el, attrs, name => unblocked(name) ?? name);
  }
}

/** Prefix of an attribute the editor neutralized for display. */
export const INERT_PREFIX = INERT_ATTR_PREFIX;

function elementsUnder(root: Element | DocumentFragment): Element[] {
  const out: Element[] = [];
  if ((root as Element).attributes) out.push(root as Element);
  out.push(...Array.from(root.querySelectorAll('*')));
  return out;
}

/** Re-set every attribute, in order, under `rename(name)`. */
function rebuildAttributes(el: Element, attrs: Attr[], rename: (name: string) => string): void {
  const entries = attrs.map(attr => [rename(attr.name), attr.value] as const);
  for (const attr of attrs) el.removeAttribute(attr.name);
  for (const [name, value] of entries) el.setAttribute(name, value);
}

/** `html` made safe to show in the editor (`stripUnsafeMarkup`), as a fragment to insert. */
export function safeInnerHtml(
  doc: Document,
  html: string,
  display: EditorDisplay = {}
): DocumentFragment {
  const template = doc.createElement('template');
  template.innerHTML = html;
  stripUnsafeMarkup(template.content, display);
  return template.content;
}

/** Block contents edited through the inspector, never by typing into the slide. */
const SOURCE_BLOCK_CONTENT =
  '.sl-block[data-block-type="svg"] > .sl-block-content, ' +
  '.sl-block[data-block-type="html"] > .sl-block-content';

/**
 * Display time: svg and html block content is not part of the slide's
 * editable text (contenteditable=false). Editor chrome only — serialization
 * strips contenteditable (`cleanupEditorContainer`).
 */
export function lockSourceBlockContent(root: Element | DocumentFragment): void {
  for (const content of Array.from(root.querySelectorAll(SOURCE_BLOCK_CONTENT))) {
    if (content.getAttribute('contenteditable') !== 'false') {
      content.setAttribute('contenteditable', 'false');
    }
  }
}

/** Editor chrome on a section the bridge created or re-rendered. */
export function prepareEditorSection(el: HTMLElement, editable: boolean): void {
  const targets = [el, ...sectionChildren(el)];
  for (const target of targets) {
    target.classList.add('editing-mode');
    if (target.getAttribute('data-hidden') === 'true') target.classList.add('slide-hidden');
    if (sectionChildren(target).length === 0) {
      target.setAttribute('contenteditable', editable ? 'true' : 'false');
    }
  }
  lockSourceBlockContent(el);
}

/** A detached `<section>` from markup (renderSlideSection output). */
export function sectionFromMarkup(
  doc: Document,
  markup: string,
  display: EditorDisplay = {}
): HTMLElement {
  const template = doc.createElement('template');
  template.innerHTML = markup.trim();
  stripUnsafeMarkup(template.content, display);
  const el = template.content.firstElementChild;
  if (!el || !isSection(el)) throw new Error('slide markup is not a <section>');
  return el as HTMLElement;
}

/**
 * Put `ordered` (existing or new elements) into `parent` in that order,
 * moving only the elements in `move` (everything else is already in relative
 * order), so the element holding the caret stays where it is.
 */
export function arrangeChildren(
  parent: Element,
  ordered: HTMLElement[],
  move: ReadonlySet<HTMLElement>
): void {
  let prev: HTMLElement | null = null;
  for (const el of ordered) {
    if (move.has(el) || el.parentElement !== parent) {
      const anchor: ChildNode | null = prev ? prev.nextSibling : firstSectionOrNull(parent);
      if (anchor !== el) parent.insertBefore(el, anchor);
    }
    prev = el;
  }
}

function firstSectionOrNull(parent: Element): ChildNode | null {
  return (sectionChildren(parent)[0] as ChildNode | undefined) ?? parent.firstChild;
}

/**
 * Where the caret is inside `el`, as a character offset into its text (null
 * when the selection is elsewhere) — survives a re-render of the same text.
 */
export function caretTextOffset(el: Element): number | null {
  const doc = el.ownerDocument;
  const selection = doc.defaultView?.getSelection?.();
  const node = selection?.focusNode ?? null;
  if (!selection || !node || !el.contains(node)) return null;
  const range = doc.createRange();
  range.selectNodeContents(el);
  try {
    range.setEnd(node, selection.focusOffset);
  } catch {
    return null;
  }
  return range.toString().length;
}

/** Put the caret `offset` characters into `el`'s text (clamped to its end). */
export function placeCaretAtTextOffset(el: Element, offset: number): void {
  const doc = el.ownerDocument;
  const selection = doc.defaultView?.getSelection?.();
  if (!selection) return;
  const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  let remaining = offset;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    last = node;
    if (remaining <= node.length) {
      selection.collapse(node, remaining);
      return;
    }
    remaining -= node.length;
  }
  if (last) selection.collapse(last, last.length);
  else selection.collapse(el, el.childNodes.length);
}
