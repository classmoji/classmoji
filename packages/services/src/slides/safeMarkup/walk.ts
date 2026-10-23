/**
 * safeMarkup/walk.ts — the one walk both engines run: every node of a parsed
 * fragment held to the lists in rules.ts, through a small adapter over the
 * engine's tree (domhandler on the server, the DOM in the browser). One walk,
 * so the two engines decide the same way node for node.
 *
 * Modes:
 * - `remove` (read surfaces): what may not stay is removed; unknown elements
 *   and `form` are replaced by their children; comments go.
 * - `rename` (editor): nothing is lost. Attributes that may not render are
 *   renamed `data-cm-inert-<marker>-<name>`, nodes that may not render are
 *   put in `<template data-cm-inert-node="<marker>">`, a `form` is shown as a
 *   `div` carrying `data-cm-inert-<marker>--tag="form"`; `restoreRenamed`
 *   (client.ts) puts back exactly what carries this session's marker. Html-block
 *   frame sources under an unsafe sandbox take the stored inert name
 *   (`data-cm-inert-<name>`, deckBlocks.ts) instead, as the server's
 *   normalize stores them, so they are not written back live.
 */

import {
  ALLOWED_HTML_ELEMENTS,
  ATTR_NAME_RE,
  DROPPED_HTML_ELEMENTS,
  HTML_NS,
  INERT_PREFIX,
  RETAGGED_ELEMENTS,
  SVG_NS,
  blockTypeOf,
  htmlAttrVerdict,
  isAllowedSvgNode,
  isKeptLink,
  isKeptScriptType,
  sessionInertName,
  sessionTagAttr,
  svgAttrVerdict,
  type AttrVerdict,
} from './rules.ts';

export type SanitizeMode = 'remove' | 'rename';

export type NodeKind = 'element' | 'text' | 'comment' | 'other';

/** The engine's tree, as the walk needs it. `N` is any node, `E` an element. */
export interface MarkupAdapter<N, E extends N> {
  /** A snapshot of the child nodes (a `<template>`'s content is not its children). */
  childNodes(parent: N): N[];
  kind(node: N): NodeKind;
  /** Local name as parsed (svg names keep their case). */
  localName(el: E): string;
  namespace(el: E): string | null;
  /** `[qualified name, value]` in document order (`xlink:href`, not `href`). */
  attrs(el: E): Array<[string, string]>;
  /** Replace every attribute with `next`, in order. */
  setAttrs(el: E, next: Array<[string, string]>): void;
  remove(node: N): void;
  /** Replace the element with its children. */
  unwrap(el: E): void;
  /** Rename mode: move the node into `<template data-cm-inert-node="<marker>">` in its place. */
  hide(node: N, marker: string): void;
  /** Rename mode: replace the element with a new html element `tag` carrying `attrs` and its children. */
  retag(el: E, tag: string, attrs: Array<[string, string]>): E;
}

export interface WalkOptions {
  mode: SanitizeMode;
  /** Rename mode: this session's marker. */
  marker?: string;
}

interface Ctx {
  inHtmlBlock: boolean;
  inSvgBlock: boolean;
}

/**
 * Hold every node under `root` (not `root` itself) to the lists. Returns the
 * number of changes (0 = the fragment was already clean).
 */
export function walkMarkup<N, E extends N>(
  adapter: MarkupAdapter<N, E>,
  root: N,
  opts: WalkOptions
): number {
  const rename = opts.mode === 'rename';
  const marker = opts.marker ?? '';
  if (rename && !marker) throw new Error('rename mode needs a session marker');
  let changes = 0;

  const drop = (node: N): void => {
    if (rename) adapter.hide(node, marker);
    else adapter.remove(node);
    changes++;
  };

  /** Apply verdicts to `el`'s attributes; returns the attribute list as it now stands. */
  const filterAttrs = (
    el: E,
    attrs: Array<[string, string]>,
    verdict: (name: string, value: string) => AttrVerdict
  ): void => {
    let touched = false;
    const next: Array<[string, string]> = [];
    for (const [name, value] of attrs) {
      const v = verdict(name, value);
      if (v.keep && (v.value === undefined || v.value === value)) {
        next.push([name, value]);
        continue;
      }
      if (v.keep && !rename) {
        next.push([name, v.value as string]);
        touched = true;
        continue;
      }
      if (!rename) {
        touched = true;
        continue;
      }
      // Rename: a name no browser reads (not a valid attribute name) stays as it is.
      if (!ATTR_NAME_RE.test(name)) {
        next.push([name, value]);
        continue;
      }
      const storedInert = !v.keep && v.storedInert === true;
      next.push([storedInert ? `${INERT_PREFIX}${name}` : sessionInertName(marker, name), value]);
      touched = true;
    }
    if (touched) {
      adapter.setAttrs(el, next);
      changes++;
    }
  };

  const visitChildren = (parent: N, ctx: Ctx): void => {
    for (const node of adapter.childNodes(parent)) {
      const kind = adapter.kind(node);
      if (kind === 'text') continue;
      if (kind !== 'element') {
        if (!rename) {
          adapter.remove(node);
          changes++;
        }
        continue;
      }
      visitElement(node as E, ctx);
    }
  };

  const visitSvg = (el: E, name: string, attrs: Array<[string, string]>, ctx: Ctx): void => {
    if (!isAllowedSvgNode(name, attrs, ctx.inSvgBlock)) return drop(el);
    // A drawing's <style> holds a sheet, nothing else.
    if (name === 'style' && adapter.childNodes(el).some(child => adapter.kind(child) !== 'text')) {
      return drop(el);
    }
    filterAttrs(el, attrs, (attr, value) => svgAttrVerdict(attr, value, name, ctx.inSvgBlock));
    visitChildren(el, ctx);
  };

  const visitElement = (el: E, ctx: Ctx): void => {
    const ns = adapter.namespace(el);
    const name = adapter.localName(el).toLowerCase();
    const attrs = adapter.attrs(el);
    if (ns === SVG_NS) return visitSvg(el, name, attrs, ctx);
    if (ns !== HTML_NS) return drop(el); // MathML and anything else

    const typeOf = blockTypeOf(attrs);
    const inner: Ctx = {
      inHtmlBlock: ctx.inHtmlBlock || typeOf === 'html',
      inSvgBlock: ctx.inSvgBlock || typeOf === 'svg',
    };
    const attrOf = (attr: string) => attrs.find(([n]) => n === attr)?.[1] ?? null;
    const verdict = (tag: string) => (attr: string, value: string) =>
      htmlAttrVerdict(attr.toLowerCase(), value, {
        tag,
        inHtmlBlock: inner.inHtmlBlock,
        sandbox: attrOf('sandbox'),
      });

    if (name === 'script') {
      if (!isKeptScriptType(attrOf('type'))) return drop(el);
      filterAttrs(el, attrs, verdict(name));
      return; // its text is data
    }
    if (name === 'link') {
      if (!isKeptLink(attrOf('rel'), attrOf('href'))) return drop(el);
      filterAttrs(el, attrs, verdict(name));
      return;
    }
    if (DROPPED_HTML_ELEMENTS.has(name)) return drop(el);

    if (RETAGGED_ELEMENTS.has(name)) {
      if (rename) {
        // Shown as a div (it cannot submit); every attribute it carried is
        // kept under this session's name unless a div may carry it.
        const next: Array<[string, string]> = [[sessionTagAttr(marker), name]];
        for (const [attr, value] of attrs) {
          const v = htmlAttrVerdict(attr.toLowerCase(), value, {
            tag: name,
            inHtmlBlock: inner.inHtmlBlock,
            sandbox: null,
          });
          const plain = v.keep && (v.value === undefined || v.value === value);
          next.push([
            plain || !ATTR_NAME_RE.test(attr) ? attr : sessionInertName(marker, attr),
            value,
          ]);
        }
        const div = adapter.retag(el, 'div', next);
        changes++;
        visitChildren(div, inner);
        return;
      }
      visitChildren(el, inner);
      adapter.unwrap(el);
      changes++;
      return;
    }

    filterAttrs(el, attrs, verdict(name));
    visitChildren(el, inner);
    if (!ALLOWED_HTML_ELEMENTS.has(name) && !rename) {
      adapter.unwrap(el);
      changes++;
    }
  };

  visitChildren(root, { inHtmlBlock: false, inSvgBlock: false });
  return changes;
}
