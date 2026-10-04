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
  RUNTIME_SECTION_ATTRS,
  RUNTIME_SECTION_CLASSES,
  splitStyleDeclarations,
} from '@classmoji/services/slides/runtime-attrs';
import { EDITOR_BLOCK_CLASSES, isRenderableAttr, type DeckStructure } from '@classmoji/collab';

import { cleanSectionAttrs } from '../deckOpsDiff.ts';
import { cleanupEditorContainer, undoRevealLazyLoad } from '../editorCleanup.ts';

/** Classes the live editor puts on sections (never authored, never saved). */
export const COLLAB_SECTION_CLASSES = ['cm-locked', 'cm-held'] as const;
const COLLAB_CLASS_SET: ReadonlySet<string> = new Set(COLLAB_SECTION_CLASSES);

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
 * One section as the live deck stores it, through the git editor's cleanup.
 * The live element is not touched.
 */
export function serializeSection(el: HTMLElement): SerializedSection {
  const holder = el.ownerDocument.createElement('div');
  const clone = el.cloneNode(true) as HTMLElement;
  holder.appendChild(clone);
  restoreInertMarkup(holder);
  undoRevealLazyLoad(holder);
  cleanupEditorContainer(holder);

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
  ]);
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (keepAlways.has(name) || RUNTIME_SECTION_ATTRS.has(name)) continue;
    if (name === 'hidden' || name === 'aria-hidden') continue;
    if (name === 'class' || name === 'style') continue;
    const authored = name.startsWith(INERT_PREFIX)
      ? attr.name.slice(INERT_PREFIX.length)
      : attr.name;
    if (!(authored in attrs)) el.removeAttribute(attr.name);
  }

  for (const [name, value] of Object.entries(attrs)) {
    const lower = name.toLowerCase();
    if (lower === 'class' || lower === 'style') continue;
    if (!isRenderableAttr(name, value)) {
      // Kept (under the inert name) so it is written back as authored.
      if (el.hasAttribute(name)) el.removeAttribute(name);
      if (el.getAttribute(`${INERT_PREFIX}${name}`) !== value) {
        el.setAttribute(`${INERT_PREFIX}${name}`, value);
      }
      continue;
    }
    if (el.hasAttribute(`${INERT_PREFIX}${name}`)) el.removeAttribute(`${INERT_PREFIX}${name}`);
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

/**
 * Make event-handler attributes and `javascript:` URLs inert on every element
 * under (and including) `root`, for display: each is renamed in place to
 * `data-cm-inert-<name>`. Nothing stored changes — `restoreInertMarkup`
 * (run by serialization) puts the authored attributes back. Iframe
 * sandboxing is left as authored.
 */
export function stripUnsafeMarkup(root: Element | DocumentFragment): void {
  for (const el of elementsUnder(root)) {
    const attrs = Array.from(el.attributes);
    if (attrs.every(attr => isRenderableAttr(attr.name, attr.value))) continue;
    // Renamed in place (same position), so putting them back restores the
    // element's markup byte for byte.
    rebuildAttributes(el, attrs, name => {
      const attr = attrs.find(a => a.name === name) as Attr;
      return isRenderableAttr(attr.name, attr.value) ? name : `${INERT_PREFIX}${name}`;
    });
  }
}

/**
 * Undo `stripUnsafeMarkup`: every `data-cm-inert-*` attribute gets its
 * original name back, in place. Serialization runs this first, so what the
 * editor writes is the authored markup — never the display-time version.
 */
export function restoreInertMarkup(root: Element | DocumentFragment): void {
  for (const el of elementsUnder(root)) {
    const attrs = Array.from(el.attributes);
    if (!attrs.some(attr => attr.name.startsWith(INERT_PREFIX))) continue;
    rebuildAttributes(el, attrs, name =>
      name.startsWith(INERT_PREFIX) ? name.slice(INERT_PREFIX.length) : name
    );
  }
}

/** Prefix of an attribute the editor neutralized for display. */
export const INERT_PREFIX = 'data-cm-inert-';

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

/** `html` with unsafe markup stripped (for innerHTML). */
export function safeInnerHtml(doc: Document, html: string): DocumentFragment {
  const template = doc.createElement('template');
  template.innerHTML = html;
  stripUnsafeMarkup(template.content);
  return template.content;
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
}

/** A detached `<section>` from markup (renderSlideSection output). */
export function sectionFromMarkup(doc: Document, markup: string): HTMLElement {
  const template = doc.createElement('template');
  template.innerHTML = markup.trim();
  stripUnsafeMarkup(template.content);
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
