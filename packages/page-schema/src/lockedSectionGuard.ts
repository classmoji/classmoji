import { createExtension } from '@blocknote/core';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';

import { lockedSectionConfig } from './configs.ts';

/**
 * Keeps a locked section's body under its lock while the author edits.
 *
 * A `lockedSection`'s body is its children. BlockNote has edits that keep a
 * block's children but change or remove the block itself: converting it
 * (Backspace or Delete on the selected block, the formatting toolbar's block
 * type select over a selection that spans it) or deleting it from the end of
 * the block before (its children are un-nested). Any of those would leave the
 * body as ordinary blocks, which every reader is served.
 *
 * Two parts, attached to the editor's lockedSection spec:
 * - Keys. Backspace/Delete on the selected section delete it WITH its body.
 *   Delete at the end of the block before it selects it instead of merging
 *   into it (a second Delete then deletes it whole).
 * - A transaction filter. A local edit that takes a block out of a locked
 *   section it was inside (out of every lock, or out of a nested lock into the
 *   outer body) is refused, unless that block is an empty text block with no
 *   children (so Enter on an empty last line still leaves the section). This
 *   also refuses dragging a body block out; cut and paste moves it. The same
 *   filter refuses a local edit that joins text across a lock's edge (a
 *   selection from outside a lock into its body, or from its body out, then
 *   Delete, Backspace, typing, paste or cut), unless the selection takes
 *   every lock it enters whole. Changes from collaborators (Yjs) and
 *   undo/redo are never refused: refusing a remote change would split this
 *   editor from the shared document.
 */

/** `ySyncPluginKey.key` in y-prosemirror (remote changes and Yjs undo carry it). */
const Y_SYNC_META = 'y-sync$';
/** prosemirror-history's plugin key (undo/redo without collaboration). */
const HISTORY_META = 'history$';

type PMNode = EditorState['doc'];

const LOCKED = lockedSectionConfig.type;

interface Scan {
  /** Block id -> the block and the ids of the locked sections it is inside. */
  blocks: Map<string, { locks: readonly string[]; node: PMNode }>;
  /** Some locked section has a body (otherwise there is nothing to keep). */
  lockedBody: boolean;
}

// Each transaction's new document is the next one's old document.
const scans = new WeakMap<PMNode, Scan>();

function isBlock(node: PMNode): boolean {
  return Boolean(node.type.spec.group?.split(' ').includes('bnBlock'));
}

function scan(doc: PMNode): Scan {
  const cached = scans.get(doc);
  if (cached) return cached;
  const result: Scan = { blocks: new Map(), lockedBody: false };
  const visit = (node: PMNode, locks: readonly string[]) => {
    node.forEach(child => {
      if (child.isTextblock || child.isLeaf) return;
      let inner = locks;
      if (isBlock(child)) {
        const id = typeof child.attrs.id === 'string' ? child.attrs.id : '';
        if (id) result.blocks.set(id, { locks, node: child });
        if (child.firstChild?.type.name === LOCKED) {
          // A lock without an id still holds its body (it gets one on the
          // next change); it just cannot be told apart from another.
          inner = [...locks, id || '?'];
          if (child.childCount > 1) result.lockedBody = true;
        }
      }
      visit(child, inner);
    });
  };
  visit(doc, []);
  scans.set(doc, result);
  return result;
}

/** A block that leaves nothing behind outside the lock: empty text, no children. */
function isEmptyTextBlock(node: PMNode): boolean {
  const content = node.firstChild;
  return (
    node.childCount === 1 &&
    content !== null &&
    content.type.spec.content === 'inline*' &&
    content.childCount === 0
  );
}

/**
 * True when going from `before` to `after` takes a block out of a locked
 * section it was inside: out of every lock, or out of a nested lock into the
 * outer one's body, or its lock was turned into another block type. An
 * empty text block without children may leave.
 */
export function movesBlockOutOfLock(before: PMNode, after: PMNode): boolean {
  const old = scan(before);
  if (!old.lockedBody) return false;
  const next = scan(after).blocks;
  for (const [id, entry] of old.blocks) {
    if (entry.locks.length === 0) continue;
    const now = next.get(id);
    if (!now || isEmptyTextBlock(now.node)) continue;
    if (entry.locks.some(lock => !now.locks.includes(lock))) return true;
  }
  return false;
}

interface Lock {
  /** Position before the lock's block (tells locks apart within one doc). */
  start: number;
  /** End of its body's content (inside the body's blockGroup). */
  bodyEnd: number;
}

/**
 * The locked sections whose body contains `pos`, outermost first. A position
 * in a lock's block but outside its body (around the title) is not in it.
 */
function locksAt(doc: PMNode, pos: number): Lock[] {
  const $pos = doc.resolve(pos);
  const out: Lock[] = [];
  for (let depth = 2; depth <= $pos.depth; depth++) {
    const container = $pos.node(depth - 1);
    if (!isBlock(container) || container.firstChild?.type.name !== LOCKED) continue;
    // The container's children: its content node, then the body group.
    if ($pos.index(depth - 1) === 0) continue;
    out.push({ start: $pos.before(depth - 1), bodyEnd: $pos.end(depth) });
  }
  return out;
}

/** Some text or leaf node (a title, an image) between `from` and `to`. */
function hasContent(doc: PMNode, from: number, to: number): boolean {
  if (to <= from) return false;
  let found = false;
  doc.nodesBetween(from, to, node => {
    if (found) return false;
    if (node.isText || node.isLeaf) found = true;
    return !found;
  });
  return found;
}

/**
 * True when replacing `a..b` would join content across a lock's edge: the
 * two ends sit in different locked sections and the range does not take
 * every lock it enters whole.
 *
 * - `a` in a lock `b` is not in: always (the lock's title, before `a`, stays,
 *   so the range never holds it whole; what follows `b` would join the body).
 * - `b` in a lock `a` is not in: unless nothing of that lock follows `b`
 *   (then the range takes all of it, from its title on).
 */
export function joinsAcrossLock(doc: PMNode, a: number, b: number): boolean {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const outer = locksAt(doc, from);
  const inner = locksAt(doc, to);
  let shared = 0;
  while (
    shared < outer.length &&
    shared < inner.length &&
    outer[shared].start === inner[shared].start
  ) {
    shared++;
  }
  if (outer.length > shared) return true;
  return inner.slice(shared).some(lock => hasContent(doc, to, lock.bodyEnd));
}

interface StepJSON {
  stepType?: string;
  from?: number;
  to?: number;
  gapFrom?: number;
  structure?: boolean;
}

/**
 * True when a step of `tr` joins content across a lock's edge. Text that
 * merges across it (a selection from the block before a lock into its first
 * body line, then Delete, Backspace, typing, paste or cut) takes the rest of
 * that line out of the lock and its block id with it, which the id check
 * cannot see.
 *
 * - A replace step: its two ends.
 * - A replace-around step that may hold content (ProseMirror's join of the
 *   text after a selection into the text before it): its start and the
 *   start of the kept gap, which is the text being moved. (Its end only
 *   closes the blocks the selection ended in, sometimes past the lock.)
 * - A structural replace-around step (nesting, lifting, wrapping) only
 *   moves whole blocks: left to the id check.
 */
export function joinsTextAcrossLock(tr: Transaction): boolean {
  return tr.steps.some((step, index) => {
    const json = step.toJSON() as StepJSON;
    const doc = tr.docs[index];
    if (typeof json.from !== 'number' || typeof json.to !== 'number') return false;
    if (json.stepType === 'replace') return joinsAcrossLock(doc, json.from, json.to);
    if (json.stepType !== 'replaceAround' || json.structure) return false;
    return typeof json.gapFrom === 'number' && joinsAcrossLock(doc, json.from, json.gapFrom);
  });
}

function shouldCheck(tr: Transaction): boolean {
  return tr.docChanged && !tr.getMeta(Y_SYNC_META) && !tr.getMeta(HISTORY_META);
}

/** A local edit that would take body content out of (or join it across) a lock. */
function refused(tr: Transaction, before: PMNode): boolean {
  if (!shouldCheck(tr) || !scan(before).lockedBody) return false;
  return joinsTextAcrossLock(tr) || movesBlockOutOfLock(before, tr.doc);
}

const guardKey = new PluginKey('lockedSectionGuard');

/** The transaction filter on its own (for tests and other editors). */
export function lockedSectionGuardPlugin(): Plugin {
  return new Plugin({
    key: guardKey,
    filterTransaction: (tr, state) => !refused(tr, state.doc),
  });
}

/** The selected locked section's block id (a NodeSelection on it), or null. */
function selectedLockedSection(state: EditorState): string | null {
  const selection = state.selection;
  if (!(selection instanceof NodeSelection)) return null;
  const node = selection.node;
  if (node.type.name === LOCKED) {
    const container = selection.$from.parent;
    return isBlock(container) && typeof container.attrs.id === 'string' ? container.attrs.id : null;
  }
  if (isBlock(node) && node.firstChild?.type.name === LOCKED) {
    return typeof node.attrs.id === 'string' ? node.attrs.id : null;
  }
  return null;
}

/**
 * With the cursor at the end of a text block: the position of the locked
 * section's content node that Delete would reach (the block's first child,
 * else its next sibling), or null.
 */
function lockedSectionAfterCursor(state: EditorState): number | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$from;
  if (!$pos.parent.isTextblock || $pos.parentOffset !== $pos.parent.content.size) return null;
  const depth = $pos.depth - 1;
  if (depth < 1) return null;
  const container = $pos.node(depth);
  if (!isBlock(container)) return null;
  const start = $pos.before(depth);
  // The block's own children come first.
  const group = container.childCount > 1 ? container.child(1) : null;
  if (group && group.firstChild) {
    const first = group.firstChild;
    if (first.firstChild?.type.name === LOCKED) {
      // container start + its content node + group open + first child open
      return start + 1 + container.child(0).nodeSize + 1 + 1;
    }
    return null;
  }
  const after = $pos.after(depth);
  const next = state.doc.resolve(after).nodeAfter;
  if (next && isBlock(next) && next.firstChild?.type.name === LOCKED) return after + 1;
  return null;
}

/**
 * The BlockNote extension for the editor's lockedSection spec:
 * `createReactBlockSpec(lockedSectionConfig, impl, [lockedSectionGuard()])`.
 */
export const lockedSectionGuard = createExtension(() => ({
  key: 'lockedSectionGuard',
  prosemirrorPlugins: [lockedSectionGuardPlugin()],
  keyboardShortcuts: {
    Backspace: ({ editor }) => deleteSelectedSection(editor),
    Delete: ({ editor }) => {
      if (deleteSelectedSection(editor)) return true;
      const view = editor.prosemirrorView;
      if (!view) return false;
      const pos = lockedSectionAfterCursor(view.state);
      if (pos === null) return false;
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
      return true;
    },
  },
}));

function deleteSelectedSection(editor: {
  prosemirrorState: EditorState;
  removeBlocks: (ids: string[]) => unknown;
}): boolean {
  const id = selectedLockedSection(editor.prosemirrorState);
  if (!id) return false;
  editor.removeBlocks([id]);
  return true;
}
