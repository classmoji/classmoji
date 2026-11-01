import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

import { findQuote } from './quoteAnchor.ts';

/**
 * Page comments on the page itself: a highlight on each open thread's quote
 * and a bubble with the open-thread count beside each block that has any.
 *
 * DECORATIONS ONLY. Nothing here ever changes the document: the document is
 * pushed to git and served to the public, and a thread lives in the database
 * (plan D1). The threads reach the plugin as a meta-only transaction
 * (`setCommentDecorations`), which tiptap does not report as an update, so
 * the editor's unsaved state, its undo history and the live (Yjs) document
 * are untouched. The same extension serves the read-only viewer and the
 * editor (git or live).
 *
 * What it found is published back (`subscribeCommentResolution`): for each
 * thread, whether its block is in the document and its quote still in the
 * block, so the panel can say "text changed" or "section removed".
 */

type PMNode = EditorState['doc'];

/** One thread, as the plugin needs it. */
export interface CommentAnchor {
  id: string;
  blockId: string;
  quote: string | null;
  occurrence: number;
  /** Open threads are drawn; resolved ones are only located. */
  open: boolean;
}

export interface CommentDecorationInput {
  anchors: CommentAnchor[];
  /** Open threads per block id: the bubble. */
  counts: Readonly<Record<string, number>>;
  /** The thread picked in the panel: its highlight is stronger. */
  activeId: string | null;
  /** A thread being written: its quote is marked until it is posted or dropped. */
  draft: { blockId: string; quote: string; occurrence: number } | null;
}

export type AnchorStatus = 'found' | 'text-changed' | 'missing';

export interface AnchorResolution {
  status: AnchorStatus;
  /** The start of the block's text (a block-level thread shows it), '' when missing. */
  excerpt: string;
}

export type CommentResolution = Readonly<Record<string, AnchorResolution>>;

interface PluginState {
  input: CommentDecorationInput;
  decorations: DecorationSet;
  resolution: CommentResolution;
}

interface CommentsPluginSpecExtras {
  listeners: Set<(resolution: CommentResolution) => void>;
}

export const commentsPluginKey = new PluginKey<PluginState>('pageComments');

const EMPTY_INPUT: CommentDecorationInput = {
  anchors: [],
  counts: {},
  activeId: null,
  draft: null,
};
const NO_RESOLUTION: CommentResolution = Object.freeze({});
const EXCERPT_MAX = 140;

/** Hard breaks count as "\n" (the stored JSON's), other inline atoms as nothing. */
const leafText = (node: PMNode) => (node.type.name === 'hardBreak' ? '\n' : '');
/** Between a table's cells (page-schema `blockText` joins them with a space). */
const CELL_SEPARATOR = ' ';
const LOCKED_SECTION = 'lockedSection';

/**
 * A block's text, by page-schema's rule (quoteAnchor.ts): its own inline
 * content, a locked section's title.
 */
export function blockContentText(content: PMNode): string {
  if (content.type.name === LOCKED_SECTION) {
    const title = content.attrs.title;
    return typeof title === 'string' ? title.trim() : '';
  }
  return content.textBetween(0, content.content.size, CELL_SEPARATOR, leafText);
}

/**
 * Text offsets ↔ document positions inside one block's content node, the
 * same walk as `textBetween` above. `contentStart` is the position just
 * inside the content node.
 */
function textSegments(content: PMNode, contentStart: number) {
  const segments: { from: number; to: number; pos: number; text: boolean }[] = [];
  let offset = 0;
  let firstTextblock = true;
  content.descendants((child, rel) => {
    if (child.isTextblock) {
      if (!firstTextblock) offset += CELL_SEPARATOR.length;
      firstTextblock = false;
      return true;
    }
    if (child.isText) {
      const length = child.text?.length ?? 0;
      segments.push({ from: offset, to: offset + length, pos: contentStart + rel, text: true });
      offset += length;
      return false;
    }
    if (child.isLeaf) {
      const length = leafText(child).length;
      if (length > 0) {
        segments.push({ from: offset, to: offset + length, pos: contentStart + rel, text: false });
        offset += length;
      }
      return false;
    }
    return true;
  });
  return segments;
}

/** The document range for text offsets `[start, end)` of a block, or null. */
export function rangeForOffsets(
  content: PMNode,
  contentStart: number,
  start: number,
  end: number
): { from: number; to: number } | null {
  const segments = textSegments(content, contentStart);
  let from: number | null = null;
  let to: number | null = null;
  for (const segment of segments) {
    if (from === null && start >= segment.from && start < segment.to) {
      from = segment.text ? segment.pos + (start - segment.from) : segment.pos;
    }
    if (end > segment.from && end <= segment.to) {
      to = segment.text ? segment.pos + (end - segment.from) : segment.pos + 1;
    }
  }
  return from !== null && to !== null && to > from ? { from, to } : null;
}

/** The text offset of document position `pos` inside a block's content. */
export function offsetForPos(content: PMNode, contentStart: number, pos: number): number {
  return content.textBetween(0, Math.max(0, pos - contentStart), CELL_SEPARATOR, leafText).length;
}

const isBlockContent = (node: PMNode) =>
  (node.type.spec.group ?? '').split(' ').includes('blockContent');

/** The blockContainers with these ids: id → its position and node. */
function locateBlocks(doc: PMNode, ids: ReadonlySet<string>) {
  const found = new Map<string, { pos: number; node: PMNode }>();
  if (ids.size === 0) return found;
  doc.descendants((node, pos) => {
    if (found.size === ids.size) return false;
    if (node.type.name === 'blockContainer') {
      const id = node.attrs.id as string | undefined;
      if (id && ids.has(id) && !found.has(id)) found.set(id, { pos, node });
      return true;
    }
    // No block lives inside a block's own content (a table's cells included).
    return !isBlockContent(node);
  });
  return found;
}

function bubble(blockId: string, count: number) {
  return () => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pg-comment-bubble';
    button.contentEditable = 'false';
    button.dataset.commentBlock = blockId;
    button.setAttribute(
      'aria-label',
      `${count} open comment ${count === 1 ? 'thread' : 'threads'} on this block`
    );
    button.title = 'Comments on this block';
    button.innerHTML =
      '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20l1.3 -3.9a9 8 0 1 1 3.4 2.9l-4.7 1"/></svg>';
    const label = document.createElement('span');
    label.textContent = String(count);
    button.appendChild(label);
    return button;
  };
}

function build(
  doc: PMNode,
  input: CommentDecorationInput
): Pick<PluginState, 'decorations' | 'resolution'> {
  const wanted = new Set<string>();
  for (const anchor of input.anchors) wanted.add(anchor.blockId);
  for (const [blockId, count] of Object.entries(input.counts)) if (count > 0) wanted.add(blockId);
  if (input.draft) wanted.add(input.draft.blockId);
  if (wanted.size === 0) return { decorations: DecorationSet.empty, resolution: NO_RESOLUTION };

  const blocks = locateBlocks(doc, wanted);
  const decorations: Decoration[] = [];
  const resolution: Record<string, AnchorResolution> = {};
  const texts = new Map<string, string>();
  const textOf = (blockId: string, content: PMNode) => {
    let text = texts.get(blockId);
    if (text === undefined) {
      text = blockContentText(content);
      texts.set(blockId, text);
    }
    return text;
  };

  const highlight = (
    blockId: string,
    quote: string,
    occurrence: number,
    attrs: Record<string, string>
  ): boolean => {
    const block = blocks.get(blockId);
    const content = block?.node.firstChild;
    if (!block || !content) return false;
    const match = findQuote(textOf(blockId, content), quote, occurrence);
    if (!match) return false;
    // A locked section's title is drawn by its node view: found, not marked.
    if (content.type.name === LOCKED_SECTION) return true;
    const range = rangeForOffsets(content, block.pos + 2, match.start, match.end);
    if (!range) return false;
    if (attrs.class) decorations.push(Decoration.inline(range.from, range.to, attrs));
    return true;
  };

  for (const anchor of input.anchors) {
    const block = blocks.get(anchor.blockId);
    const content = block?.node.firstChild;
    if (!block || !content) {
      resolution[anchor.id] = { status: 'missing', excerpt: '' };
      continue;
    }
    const excerpt = textOf(anchor.blockId, content).slice(0, EXCERPT_MAX);
    if (!anchor.quote) {
      resolution[anchor.id] = { status: 'found', excerpt };
      continue;
    }
    const attrs: Record<string, string> = anchor.open
      ? {
          class:
            anchor.id === input.activeId ? 'pg-comment-hl pg-comment-hl-active' : 'pg-comment-hl',
          'data-comment-thread': anchor.id,
        }
      : {};
    const found = highlight(anchor.blockId, anchor.quote, anchor.occurrence, attrs);
    resolution[anchor.id] = { status: found ? 'found' : 'text-changed', excerpt };
  }

  if (input.draft) {
    highlight(input.draft.blockId, input.draft.quote, input.draft.occurrence, {
      class: 'pg-comment-hl pg-comment-hl-draft',
    });
  }

  for (const [blockId, count] of Object.entries(input.counts)) {
    const block = blocks.get(blockId);
    const content = block?.node.firstChild;
    if (!block || !content || count <= 0) continue;
    decorations.push(
      Decoration.node(block.pos, block.pos + block.node.nodeSize, {
        class: 'pg-comment-block',
        'data-comment-count': String(count),
      })
    );
    // After the block's content, before its children: `.bn-block-content`
    // stays the block's first element.
    decorations.push(
      Decoration.widget(block.pos + 1 + content.nodeSize, bubble(blockId, count), {
        side: -1,
        key: `pg-comment-bubble:${blockId}:${count}`,
        ignoreSelection: true,
        stopEvent: () => true,
      })
    );
  }

  return { decorations: DecorationSet.create(doc, decorations), resolution };
}

function sameResolution(a: CommentResolution, b: CommentResolution): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (!y || x.status !== y.status || x.excerpt !== y.excerpt) return false;
  }
  return true;
}

const hasWork = (input: CommentDecorationInput) =>
  input.anchors.length > 0 || input.draft !== null || Object.keys(input.counts).length > 0;

function commentsPlugin() {
  const extras: CommentsPluginSpecExtras = { listeners: new Set() };
  return new Plugin<PluginState>({
    key: commentsPluginKey,
    ...extras,
    state: {
      init: () => ({
        input: EMPTY_INPUT,
        decorations: DecorationSet.empty,
        resolution: NO_RESOLUTION,
      }),
      apply(tr: Transaction, previous: PluginState, _old: EditorState, state: EditorState) {
        const meta = tr.getMeta(commentsPluginKey) as CommentDecorationInput | undefined;
        if (!meta && !(tr.docChanged && hasWork(previous.input))) {
          return tr.docChanged
            ? { ...previous, decorations: previous.decorations.map(tr.mapping, tr.doc) }
            : previous;
        }
        const input = meta ?? previous.input;
        const next = build(state.doc, input);
        return {
          input,
          decorations: next.decorations,
          resolution: sameResolution(next.resolution, previous.resolution)
            ? previous.resolution
            : next.resolution,
        };
      },
    },
    props: {
      decorations: state => commentsPluginKey.getState(state)?.decorations ?? null,
    },
    view: () => ({
      update(view, previousState) {
        const now = commentsPluginKey.getState(view.state)?.resolution;
        const before = commentsPluginKey.getState(previousState)?.resolution;
        if (now && now !== before) for (const listener of extras.listeners) listener(now);
      },
    }),
  });
}

/**
 * The extension both hosts add to `extensions` (always: with no threads it
 * draws nothing). Call it: `pageCommentsExtension()`.
 */
export const pageCommentsExtension = createExtension(() => ({
  key: 'pageComments',
  prosemirrorPlugins: [commentsPlugin()],
}));

/** The part of a BlockNote editor this module uses. */
export interface CommentsEditor {
  prosemirrorState: EditorState;
  transact: (callback: (tr: Transaction) => void) => void;
}

/** Hand the plugin the threads to draw (a meta-only transaction; the document is not touched). */
export function setCommentDecorations(editor: CommentsEditor, input: CommentDecorationInput) {
  try {
    // Only this plugin's meta: a transaction with no steps adds nothing to
    // undo. No `addToHistory: false` either: in live mode y-prosemirror
    // reads that as a cut and would split the user's undo step mid-typing.
    editor.transact(tr => {
      tr.setMeta(commentsPluginKey, input);
    });
  } catch (error) {
    console.error('[pageComments] could not draw comment highlights:', error);
  }
}

/** What the plugin found last (thread id → status), and its changes. */
export function commentResolution(editor: CommentsEditor): CommentResolution {
  try {
    return commentsPluginKey.getState(editor.prosemirrorState)?.resolution ?? NO_RESOLUTION;
  } catch {
    return NO_RESOLUTION;
  }
}

export function subscribeCommentResolution(
  editor: CommentsEditor,
  listener: (resolution: CommentResolution) => void
): () => void {
  let plugin: Plugin | undefined;
  try {
    plugin = commentsPluginKey.get(editor.prosemirrorState);
  } catch {
    plugin = undefined;
  }
  const listeners = (plugin?.spec as Partial<CommentsPluginSpecExtras> | undefined)?.listeners;
  if (!listeners) return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
