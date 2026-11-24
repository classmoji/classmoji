import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

import { ANCHORED_HEADING_LEVELS, createHeadingIdAllocator } from '~/utils/headingAnchors.ts';

/** A ProseMirror document (prosemirror-model is not a direct dependency here). */
type PMNode = EditorState['doc'];

/**
 * `#fragment` ids on the reader's headings: the ids the class site's static
 * render gives the same headings (`utils/headingAnchors.ts`, one rule), so a
 * link to `#grading` lands on the same heading on either surface.
 *
 * A ProseMirror decoration, not a DOM pass. ProseMirror owns the heading's DOM:
 * a hand-written attribute on it is a DOM change the view reads back as a
 * document edit, and a re-render of the block (an unlock putting a body in,
 * a tick) drops it. A node decoration is part of the view's own render, so it
 * survives every re-render and moves with the document. It lands on the
 * heading block's content element (`.bn-block-content[data-content-type=
 * heading]`, the element that holds the `<h1>`-`<h3>`): ProseMirror puts a
 * node decoration's attributes on the node's outer DOM.
 */

export interface HeadingAnchorTarget {
  /** Position of the heading node (its decoration's range is the node). */
  from: number;
  to: number;
  level: number;
  text: string;
  id: string;
}

/** Every h1-h3 in the document with its id, in document order. */
export function headingAnchorTargets(doc: PMNode): HeadingAnchorTarget[] {
  const nextId = createHeadingIdAllocator();
  const out: HeadingAnchorTarget[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true;
    const level = Number(node.attrs.level);
    if (ANCHORED_HEADING_LEVELS.has(level)) {
      const text = node.textContent.trim();
      const id = nextId(text);
      if (id) out.push({ from: pos, to: pos + node.nodeSize, level, text, id });
    }
    // A heading holds inline content only.
    return false;
  });
  return out;
}

function decorationsFor(doc: PMNode): DecorationSet {
  return DecorationSet.create(
    doc,
    headingAnchorTargets(doc).map(target =>
      Decoration.node(target.from, target.to, { id: target.id })
    )
  );
}

const headingAnchorsKey = new PluginKey<DecorationSet>('pageHeadingAnchors');

function headingAnchorsPlugin() {
  return new Plugin<DecorationSet>({
    key: headingAnchorsKey,
    state: {
      init: (_config, state) => decorationsFor(state.doc),
      apply: (tr, previous) => (tr.docChanged ? decorationsFor(tr.doc) : previous),
    },
    props: {
      decorations: state => headingAnchorsKey.getState(state),
    },
  });
}

export const headingAnchorsExtension = createExtension(() => ({
  key: 'pageHeadingAnchors',
  prosemirrorPlugins: [headingAnchorsPlugin()],
}));
