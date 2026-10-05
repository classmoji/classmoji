/**
 * Agent carets in a live page: a point in the page (a block, then a
 * character offset or its start/end) as the `cursor` awareness field that
 * y-prosemirror's cursor plugin — which BlockNote 0.55's collaboration cursors
 * are — reads for every peer: `{ anchor, head }`, each a Y.RelativePosition as
 * JSON. A relative position sticks to the characters around it, so the caret
 * stays put while people type elsewhere, like a person who stopped typing.
 *
 * Pure Yjs, read-only: nothing here writes to the doc.
 */
import * as Y from 'yjs';
import { FRAGMENT } from '@classmoji/page-schema';
import type { AgentCursor, PageCursorPoint } from '@classmoji/collab';

/** The element carrying this block id (blockContainer, columnList, column), in doc order. */
export function findBlockElement(doc: Y.Doc, id: string): Y.XmlElement | null {
  const walk = (node: Y.XmlElement | Y.XmlFragment): Y.XmlElement | null => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.getAttribute('id') === id) return child;
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(doc.getXmlFragment(FRAGMENT));
}

/** A blockContainer's own content element (paragraph, heading, …); else the element itself. */
function ownContent(element: Y.XmlElement): Y.XmlElement {
  if (element.nodeName !== 'blockContainer') return element;
  const first = element.length > 0 ? element.get(0) : null;
  return first instanceof Y.XmlElement && first.nodeName !== 'blockGroup' ? first : element;
}

/** Every text node under `root`, in document order. */
function textsIn(root: Y.XmlElement): Y.XmlText[] {
  const out: Y.XmlText[] = [];
  const walk = (node: Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) out.push(child);
      else if (child instanceof Y.XmlElement) walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * A relative position for `point`, or null when the block is not in the doc.
 * `own`: the block's own text (an offset counts its characters); `subtree`:
 * its children's text too (the end of what an op wrote into a nested block).
 * A block without text (an image, a divider) puts the caret at the block.
 */
export function pagePosition(
  doc: Y.Doc,
  point: PageCursorPoint,
  scope: 'own' | 'subtree' = 'own'
): Y.RelativePosition | null {
  const element = findBlockElement(doc, point.blockId);
  if (!element) return null;
  const own = ownContent(element);
  const texts = textsIn(scope === 'subtree' ? element : own);
  const last = texts.at(-1);

  if (typeof point.offset === 'number' && Number.isFinite(point.offset) && texts.length > 0) {
    let left = Math.max(0, Math.floor(point.offset));
    for (const text of texts) {
      if (left < text.length || text === last) {
        const index = Math.min(left, text.length);
        // At a text's end, stick to the character before (typing after it
        // does not drag the caret along).
        return Y.createRelativePositionFromTypeIndex(text, index, index === text.length ? -1 : 0);
      }
      left -= text.length;
    }
  }
  if (point.at === 'start') {
    return texts.length > 0
      ? Y.createRelativePositionFromTypeIndex(texts[0], 0, 0)
      : Y.createRelativePositionFromTypeIndex(own, 0, 0);
  }
  return last
    ? Y.createRelativePositionFromTypeIndex(last, last.length, -1)
    : Y.createRelativePositionFromTypeIndex(own, own.length, -1);
}

/**
 * The awareness `cursor` for a caret at `point`, or a selection from `point`
 * to `selectTo` (its block defaults to the point's). Null when either block
 * is gone.
 */
export function pageCursor(
  doc: Y.Doc,
  point: PageCursorPoint,
  selectTo: Partial<PageCursorPoint> | null = null,
  scope: 'own' | 'subtree' = 'own'
): AgentCursor | null {
  const anchor = pagePosition(doc, point, scope);
  if (!anchor) return null;
  let head = anchor;
  if (selectTo) {
    const to = pagePosition(
      doc,
      {
        blockId: selectTo.blockId ?? point.blockId,
        ...(selectTo.offset !== undefined ? { offset: selectTo.offset } : {}),
        ...(selectTo.at ? { at: selectTo.at } : {}),
      },
      scope
    );
    if (!to) return null;
    head = to;
  }
  return { anchor: Y.relativePositionToJSON(anchor), head: Y.relativePositionToJSON(head) };
}
