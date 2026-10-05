/**
 * checkpointGuards.ts — the two checks a rendered page must pass before the
 * checkpoint worker will commit it (spec "multi-column" + W3 guards).
 *
 * 1. DROPPED BLOCKS. BlockNote's Y.Doc -> blocks conversion deletes any element
 *    its schema rejects. On a clone that loss is silent: the live document
 *    still has the block, but the committed content.json would not, and the
 *    next reseed from git would make the loss permanent. So the render must
 *    keep every block id the document holds.
 *
 *    Measured against the DOCUMENT (the snapshot's fragment), not against the
 *    last pushed content.json. Read literally, "ids in the last pushed file
 *    that the render lacks" also matches every block a teacher deleted on
 *    purpose — a page with one deletion could then never checkpoint again.
 *    What the guard exists to catch is the render dropping something, and the
 *    only witness to that is the document the render came from. Ids that were
 *    in the last pushed file and are still in the document are a subset of
 *    this check, so it refuses everything the literal reading would have
 *    refused for a real drop.
 *
 * 2. SHORT COLUMN LAYOUTS. A `columnList` with fewer than two columns bricks
 *    the page in the viewer and the editor. The collab server repairs these in
 *    the live document; the worker refuses to push one that slipped through
 *    (it does not repair: a repair here would land in git but not in the live
 *    doc, and the next checkpoint would push the broken layout back).
 *
 * Pure (yjs only), so it is unit-tested without Trigger, Prisma or git.
 */

import * as Y from 'yjs';

/** The Prosemirror nodes that are blocks (carry a block id) in BlockNote's Y.Doc. */
const BLOCK_NODES = new Set(['blockContainer', 'columnList', 'column']);

/** Every block id in `fragmentName` of `doc`, in document order. */
export function fragmentBlockIds(doc: Y.Doc, fragmentName: string): string[] {
  const ids: string[] = [];
  const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlHook) => {
    if (!(node instanceof Y.XmlElement)) return;
    if (BLOCK_NODES.has(node.nodeName)) {
      const id = node.getAttribute('id');
      if (typeof id === 'string' && id) ids.push(id);
    }
    for (const child of node.toArray()) walk(child as Y.XmlElement);
  };
  for (const child of doc.getXmlFragment(fragmentName).toArray()) walk(child as Y.XmlElement);
  return ids;
}

interface BlockLike {
  id?: unknown;
  type?: unknown;
  children?: unknown;
}

function childrenOf(block: BlockLike): BlockLike[] {
  return Array.isArray(block.children) ? (block.children as BlockLike[]) : [];
}

/** Every block id in a BlockNote block tree. */
export function renderedBlockIds(blocks: unknown[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: BlockLike[]) => {
    for (const block of list) {
      if (!block || typeof block !== 'object') continue;
      if (typeof block.id === 'string') ids.add(block.id);
      walk(childrenOf(block));
    }
  };
  walk(blocks as BlockLike[]);
  return ids;
}

/** Ids of `columnList` blocks holding fewer than two `column` children. */
export function shortColumnLists(blocks: unknown[]): string[] {
  const found: string[] = [];
  const walk = (list: BlockLike[]) => {
    for (const block of list) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'columnList') {
        const columns = childrenOf(block).filter(c => c?.type === 'column').length;
        if (columns < 2) found.push(typeof block.id === 'string' ? block.id : '(no id)');
      }
      walk(childrenOf(block));
    }
  };
  walk(blocks as BlockLike[]);
  return found;
}

export interface PageGuardResult {
  ok: boolean;
  /** Block ids the document holds and the render lost. */
  droppedIds: string[];
  /** `columnList` ids with fewer than two columns. */
  shortColumnLists: string[];
  /** Human-readable reason when `ok` is false. */
  reason?: string;
}

/**
 * Check a page render against the document it came from.
 *
 * @param doc - The snapshot document (any copy; it is only read).
 * @param fragmentName - The page fragment (`FRAGMENT`, 'document-store').
 * @param blocks - What `yDocToPageContent` rendered from that document.
 */
export function checkPageRender(
  doc: Y.Doc,
  fragmentName: string,
  blocks: unknown[]
): PageGuardResult {
  const rendered = renderedBlockIds(blocks);
  const droppedIds = [...new Set(fragmentBlockIds(doc, fragmentName))].filter(
    id => !rendered.has(id)
  );
  const shortLists = shortColumnLists(blocks);
  const reasons: string[] = [];
  if (droppedIds.length) {
    reasons.push(
      `the render dropped ${droppedIds.length} block(s) the document holds: ${droppedIds
        .slice(0, 10)
        .join(', ')}${droppedIds.length > 10 ? ', …' : ''}`
    );
  }
  if (shortLists.length) {
    reasons.push(`column layout(s) with fewer than two columns: ${shortLists.join(', ')}`);
  }
  return {
    ok: reasons.length === 0,
    droppedIds,
    shortColumnLists: shortLists,
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
  };
}
