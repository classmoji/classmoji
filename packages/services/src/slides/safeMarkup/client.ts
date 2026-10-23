/**
 * safeMarkup/client.ts — the browser engine: slide markup parsed by the live
 * document into a `<template>` (nothing in it loads or runs), held to the
 * lists (walk.ts), and handed back as a DocumentFragment to insert with
 * `replaceChildren` / `append`. Never serialize the result and assign it to
 * `innerHTML` again: what is checked must be what is inserted.
 *
 * No runtime imports beyond this folder and deckBlocks.ts.
 */

import {
  HTML_NS,
  INERT_NODE_ATTR,
  INERT_PREFIX,
  RETAGGED_ELEMENTS,
  XLINK_NS,
  blockTypeOf,
  newSessionMarker,
  sessionTagAttr,
} from './rules.ts';
import {
  walkMarkup,
  walkMarkupNodes,
  type MarkupAdapter,
  type NodeKind,
  type SanitizeMode,
  type WalkContext,
} from './walk.ts';

export interface ClientSanitizeOptions {
  mode: SanitizeMode;
  /** The live document (its parser, its scripting flag). */
  doc: Document;
  /** Rename mode: this page load's marker ({@link pageSessionMarker}). */
  marker?: string;
}

let pageMarker: string | null = null;

/** This page load's marker for rename mode: minted on first use, the same until reload. */
export function pageSessionMarker(): string {
  pageMarker ??= newSessionMarker();
  return pageMarker;
}

const domAdapter: MarkupAdapter<Node, Element> = {
  childNodes: parent => Array.from(parent.childNodes),
  kind(node): NodeKind {
    switch (node.nodeType) {
      case 1:
        return 'element';
      case 3:
        return 'text';
      case 8:
        return 'comment';
      default:
        return 'other';
    }
  },
  localName: el => el.localName,
  namespace: el => el.namespaceURI,
  attrs: el => Array.from(el.attributes, attr => [attr.name, attr.value] as [string, string]),
  setAttrs(el, next) {
    // Attributes kept as they were go back as the same Attr nodes (namespace
    // and all, whatever their name); new names are set plainly.
    const before = new Map(Array.from(el.attributes, attr => [attr.name, attr] as const));
    for (const attr of before.values()) el.removeAttributeNode(attr);
    for (const [name, value] of next) {
      const original = before.get(name);
      if (original && original.value === value) el.setAttributeNode(original);
      else el.setAttribute(name, value);
    }
  },
  remove: node => node.parentNode?.removeChild(node),
  unwrap: el => el.replaceWith(...Array.from(el.childNodes)),
  hide(node, marker) {
    const doc = node.ownerDocument as Document;
    const holder = doc.createElement('template');
    holder.setAttribute(INERT_NODE_ATTR, marker);
    node.parentNode?.replaceChild(holder, node);
    holder.content.appendChild(node);
  },
  retag(el, tag, attrs) {
    const next = (el.ownerDocument as Document).createElement(tag);
    for (const [name, value] of attrs) next.setAttribute(name, value);
    next.append(...Array.from(el.childNodes));
    el.replaceWith(next);
    return next;
  },
};

/** `html` parsed by `doc` into a fragment nothing in which has loaded. */
function parseInert(html: string, doc: Document): HTMLTemplateElement {
  const template = doc.createElement('template');
  template.innerHTML = html;
  return template;
}

/**
 * Slide markup, held to the lists, as a fragment to insert. Remove mode for
 * every read surface; rename mode for the editor (pair with
 * {@link restoreRenamed} before anything is written back).
 */
export function sanitizeClient(html: string, opts: ClientSanitizeOptions): DocumentFragment {
  const template = parseInert(html, opts.doc);
  walkMarkup(domAdapter, template.content, { mode: opts.mode, marker: opts.marker });
  return template.content;
}

/**
 * Hold a subtree that is already in a document to the lists, in place
 * (children of `root`; `root` itself is not judged).
 */
export function sanitizeClientInPlace(
  root: Element | DocumentFragment,
  opts: Omit<ClientSanitizeOptions, 'doc'>
): number {
  return walkMarkup(domAdapter, root, { mode: opts.mode, marker: opts.marker });
}

/** What the element ancestors of `parent` make of a node inserted under it. */
function contextAt(parent: Node | null): WalkContext {
  const ctx: WalkContext = { inHtmlBlock: false, inSvgBlock: false, inSelect: false };
  for (let el = parent; el && el.nodeType === 1; el = el.parentNode) {
    const element = el as Element;
    if (element.namespaceURI !== HTML_NS) continue;
    const name = element.localName;
    if (name === 'select' || name === 'option' || name === 'optgroup') ctx.inSelect = true;
    const type = blockTypeOf(domAdapter.attrs(element));
    if (type === 'html') ctx.inHtmlBlock = true;
    if (type === 'svg') ctx.inSvgBlock = true;
  }
  return ctx;
}

/**
 * Hold nodes that are already in a document — what a paste or a drop just
 * inserted — to the lists, in place: each node itself and everything under
 * it, judged where it sits. Pass only the inserted nodes: the markup around
 * them was held to the lists when it was shown. Returns the number of changes.
 */
export function sanitizeClientNodesInPlace(
  nodes: Node[],
  opts: Omit<ClientSanitizeOptions, 'doc'>
): number {
  let changes = 0;
  for (const node of nodes) {
    changes += walkMarkupNodes(
      domAdapter,
      [node],
      { mode: opts.mode, marker: opts.marker },
      contextAt(node.parentNode)
    );
  }
  return changes;
}

/** {@link sanitizeClient} serialized — for tests and comparisons only, never for insertion. */
export function sanitizeClientToString(html: string, opts: ClientSanitizeOptions): string {
  const template = parseInert(html, opts.doc);
  walkMarkup(domAdapter, template.content, { mode: opts.mode, marker: opts.marker });
  return template.innerHTML;
}

/** Speaker notes after `marked`: the same lists, remove mode. */
export function sanitizeNotesHtml(markedOutput: string, doc: Document): DocumentFragment {
  return sanitizeClient(markedOutput, { mode: 'remove', doc });
}

function elementsUnder(root: Element | DocumentFragment): Element[] {
  const out: Element[] = [];
  if ((root as Element).attributes) out.push(root as Element);
  out.push(...Array.from(root.querySelectorAll('*')));
  return out;
}

/**
 * Undo rename mode for this session's marker, in place: hidden nodes come
 * out of their templates, renamed attributes get their names back (same
 * position), stand-in divs become what they were. Inert names with any other
 * marker, or none, are left as the plain data attributes they are.
 */
export function restoreRenamed(root: Element | DocumentFragment, marker: string): void {
  if (!marker) return;
  for (const holder of Array.from(root.querySelectorAll(`template[${INERT_NODE_ATTR}]`))) {
    if (holder.getAttribute(INERT_NODE_ATTR) !== marker) continue;
    holder.replaceWith(...Array.from((holder as HTMLTemplateElement).content.childNodes));
  }
  const prefix = `${INERT_PREFIX}${marker}-`;
  const tagAttr = sessionTagAttr(marker);
  for (const el of elementsUnder(root)) {
    const attrs = Array.from(el.attributes);
    if (!attrs.some(attr => attr.name.startsWith(prefix))) continue;
    const tag = el.getAttribute(tagAttr);
    const restored: Array<[string, string] | Attr> = [];
    for (const attr of attrs) {
      if (attr.name === tagAttr) continue;
      restored.push(
        attr.name.startsWith(prefix) ? [attr.name.slice(prefix.length), attr.value] : attr
      );
    }
    let target: Element = el;
    if (tag !== null && RETAGGED_ELEMENTS.has(tag)) {
      target = (el.ownerDocument as Document).createElement(tag);
      target.append(...Array.from(el.childNodes));
      el.replaceWith(target);
    } else {
      for (const attr of attrs) el.removeAttributeNode(attr);
    }
    for (const entry of restored) {
      if (!Array.isArray(entry)) {
        if (target === el) el.setAttributeNode(entry);
        else target.setAttribute(entry.name, entry.value);
        continue;
      }
      const [name, value] = entry;
      if (name.startsWith('xlink:')) target.setAttributeNS(XLINK_NS, name, value);
      else target.setAttribute(name, value);
    }
  }
}

/** {@link restoreRenamed} over markup, parsed and serialized by `doc`. */
export function restoreRenamedHtml(html: string, marker: string, doc: Document): string {
  const template = parseInert(html, doc);
  restoreRenamed(template.content, marker);
  return template.innerHTML;
}
