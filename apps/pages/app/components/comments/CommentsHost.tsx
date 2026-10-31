import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { EditorView } from 'prosemirror-view';

import type { CommentsBridge } from './commentsBridge.ts';
import {
  blockContentText,
  commentResolution,
  offsetForPos,
  setCommentDecorations,
  subscribeCommentResolution,
  type CommentsEditor,
} from './commentsPlugin.ts';
import { occurrenceAt, quoteForSelection } from './quoteAnchor.ts';
import { QUOTE_MAX, type NewThreadDraft } from './types.ts';

import './comments.css';

/**
 * The comment UI that lives ON the page, in either host (the read-only
 * viewer or the editor): it feeds the decorations plugin from the bridge,
 * reports back where each thread was found, and draws three things over the
 * document without touching it:
 *
 * - "Comment" under a text selection that stays inside one block;
 * - a small comment button beside the hovered block (a block-level thread);
 * - a flash over a block the panel asked to show.
 *
 * Clicks on the plugin's bubbles and highlights are caught here too
 * (delegated from the container), and handed to the route.
 */
interface CommentsHostProps {
  editor: CommentsEditor & {
    isEditable: boolean;
    prosemirrorView?: EditorView;
    onMount: (fn: () => void) => () => void;
  };
  bridge: CommentsBridge;
  /**
   * The host's root element: pointer and selection events are read on it.
   * Render this component as its FIRST child: the overlays are positioned
   * from a zero-height anchor at its top-left corner, so the root needs no
   * positioning of its own.
   */
  container: HTMLElement | null;
}

const BLOCK_OUTER = '.bn-block-outer[data-id]';

interface SelectionTarget {
  draft: NewThreadDraft;
  /** Viewport position for the button. */
  x: number;
  y: number;
}

interface HoverTarget {
  blockId: string;
  top: number;
  left: number;
}

interface Flash {
  key: number;
  blockId: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

type PMDoc = EditorView['state']['doc'];

/** The innermost blockContainer around a resolved position: its start and node. */
function blockAround(doc: PMDoc, pos: number) {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === 'blockContainer') return { pos: $pos.before(depth), node };
  }
  return null;
}

/**
 * Room, in px, right of the editor before something cuts it off: the window
 * (less its scrollbar), any ancestor that clips its overflow (the pages
 * app's scroll pane), or the comments panel when it sits beside the page.
 */
export function roomOnTheRight(element: HTMLElement): number {
  const doc = element.ownerDocument;
  const html = doc.documentElement;
  let clip = html.clientWidth;
  for (let node = element.parentElement; node && node !== html; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowX;
    if (!overflow || overflow === 'visible') continue;
    clip = Math.min(clip, node.getBoundingClientRect().left + node.clientLeft + node.clientWidth);
  }
  const panel = doc.getElementById('page-comments-panel');
  if (panel && html.dataset.commentsPanel === 'open') {
    const rect = panel.getBoundingClientRect();
    // Beside the page (not the full-width bottom sheet).
    if (rect.left > 0) clip = Math.min(clip, rect.left);
  }
  return clip - element.getBoundingClientRect().right;
}

/** The bubble goes in the right margin only with this much room (gap + a two-digit pill + slack). */
const BUBBLE_GUTTER = 52;
/** The bubble's width inside the block's top-right corner, for the hover button. */
const INSIDE_BUTTON = 24;

/** The selection as a new thread on one block, or null when it is not one. */
export function selectionDraft(view: EditorView, range: Range): NewThreadDraft | null {
  let from: number;
  let to: number;
  try {
    from = view.posAtDOM(range.startContainer, range.startOffset);
    to = view.posAtDOM(range.endContainer, range.endOffset);
  } catch {
    return null;
  }
  if (to < from) [from, to] = [to, from];
  const doc = view.state.doc;
  const start = blockAround(doc, from);
  const end = blockAround(doc, to);
  if (!start || !end || start.pos !== end.pos) return null;
  const content = start.node.firstChild;
  const blockId = start.node.attrs.id as string | undefined;
  if (!content || !blockId) return null;
  const contentStart = start.pos + 2;
  const contentEnd = contentStart + content.content.size;
  // Both ends inside the block's own content (not in its nested children).
  if (from < contentStart || to > contentEnd) return null;
  const text = blockContentText(content);
  const picked = quoteForSelection(
    text,
    offsetForPos(content, contentStart, from),
    offsetForPos(content, contentStart, to),
    QUOTE_MAX
  );
  if (!picked) return null;
  return {
    blockId,
    quote: picked.quote,
    quoteOccurrence: occurrenceAt(text, picked.quote, picked.start),
  };
}

export function CommentsHost({ editor, bridge, container }: CommentsHostProps) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);
  const { input, canWrite } = snapshot;

  // Route → plugin. Again after every (re)mount of the view, to be safe.
  const inputRef = useRef(input);
  inputRef.current = input;
  useEffect(() => {
    setCommentDecorations(editor, input);
    bridge.actions.setResolution(commentResolution(editor));
  }, [editor, bridge, input]);
  useEffect(() => editor.onMount(() => setCommentDecorations(editor, inputRef.current)), [editor]);

  // Plugin → route: where each thread was found.
  useEffect(() => {
    return subscribeCommentResolution(editor, resolution =>
      bridge.actions.setResolution(resolution)
    );
  }, [editor, bridge]);

  // Bubbles and highlights → the panel.
  useEffect(() => {
    if (!container) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const bubble = target?.closest?.('[data-comment-block]');
      if (bubble && container.contains(bubble)) {
        event.preventDefault();
        bridge.actions.openBlock((bubble as HTMLElement).dataset.commentBlock ?? '');
        return;
      }
      const highlight = target?.closest?.('[data-comment-thread]');
      if (highlight && container.contains(highlight)) {
        // A click, not the end of a drag that selected text; and not in the
        // editor, where a click in a highlight is placing the caret.
        if (window.getSelection()?.isCollapsed === false) return;
        if (editor.isEditable) return;
        bridge.actions.openThread((highlight as HTMLElement).dataset.commentThread ?? '');
      }
    };
    container.addEventListener('click', onClick);
    return () => container.removeEventListener('click', onClick);
  }, [container, bridge, editor]);

  // "Comment" under a selection inside one block.
  const [selection, setSelection] = useState<SelectionTarget | null>(null);
  useEffect(() => {
    if (!container || !canWrite) {
      setSelection(null);
      return;
    }
    let frame = 0;
    const read = () => {
      frame = 0;
      const selected = window.getSelection();
      const view = editor.prosemirrorView;
      if (!selected || selected.isCollapsed || selected.rangeCount === 0 || !view) {
        setSelection(null);
        return;
      }
      const range = selected.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setSelection(null);
        return;
      }
      const draft = selectionDraft(view, range);
      const rect = range.getBoundingClientRect();
      if (!draft || (rect.width === 0 && rect.height === 0)) {
        setSelection(null);
        return;
      }
      setSelection({
        draft,
        x: Math.min(Math.max(rect.left + rect.width / 2, 48), window.innerWidth - 48),
        y: Math.min(rect.bottom + 8, window.innerHeight - 40),
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    const hide = () => setSelection(null);
    document.addEventListener('selectionchange', schedule);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('selectionchange', schedule);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [container, canWrite, editor]);

  // Overlays are placed relative to this (zero-height, at the container's top-left).
  const anchorRef = useRef<HTMLDivElement | null>(null);
  // Bubbles and the block button in the right margin (room for them) or in
  // the block's top-right corner (phones, full-width pages): see `relayout`.
  const outsideRef = useRef(false);

  // The block under the pointer, for its comment button.
  const [hover, setHover] = useState<HoverTarget | null>(null);
  useEffect(() => {
    if (!container || !canWrite) {
      setHover(null);
      return;
    }
    const onMove = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.('.pg-comment-block-button')) return;
      const outer = target?.closest?.(BLOCK_OUTER) as HTMLElement | null;
      if (!outer || !container.contains(outer)) return;
      const blockId = outer.dataset.id;
      const block = outer.querySelector(':scope > .bn-block') as HTMLElement | null;
      const content = block?.querySelector(':scope > .bn-block-content') as HTMLElement | null;
      if (!blockId || !block || !content) return;
      // A block with a bubble already has its button (the bubble).
      if (outer.classList.contains('pg-comment-block')) {
        setHover(null);
        return;
      }
      const box = (anchorRef.current ?? container).getBoundingClientRect();
      const top = content.getBoundingClientRect().top - box.top;
      const right = block.getBoundingClientRect().right - box.left;
      const left = outsideRef.current ? right + 10 : right - INSIDE_BUTTON;
      setHover(previous =>
        previous && previous.blockId === blockId && previous.top === top && previous.left === left
          ? previous
          : { blockId, top, left }
      );
    };
    const onLeave = () => setHover(null);
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseleave', onLeave);
    };
  }, [container, canWrite]);

  // The panel asks: show this block.
  const [flash, setFlash] = useState<Flash | null>(null);
  const flashTimer = useRef(0);
  const blockContentEl = useCallback(
    (blockId: string) =>
      (container
        ?.querySelector(`.bn-block-outer[data-id="${CSS.escape(blockId)}"]`)
        ?.querySelector('.bn-block-content') ?? null) as HTMLElement | null,
    [container]
  );
  const flashBox = useCallback(
    (content: HTMLElement) => {
      const box = (anchorRef.current ?? container)?.getBoundingClientRect();
      const rect = content.getBoundingClientRect();
      return {
        top: rect.top - (box?.top ?? 0),
        left: rect.left - (box?.left ?? 0),
        width: rect.width,
        height: rect.height,
      };
    },
    [container]
  );
  const focusBlock = useCallback(
    (blockId: string) => {
      const content = blockContentEl(blockId);
      if (!content) return false;
      content.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlash(previous => ({
        key: (previous?.key ?? 0) + 1,
        blockId,
        ...flashBox(content),
      }));
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(null), 1800);
      return true;
    },
    [blockContentEl, flashBox]
  );
  useEffect(() => bridge.attachHost({ focusBlock }), [bridge, focusBlock]);

  // Where the bubbles go, and the page changing width or place (the comments
  // panel opening makes room for itself, a window resize, the sidebar): the
  // margin when there is room for a bubble in it, else the block's top-right
  // corner, so nothing ever runs past the window (`data-comment-bubbles` on
  // the host root, comments.css). Overlays placed from the old layout are
  // re-placed (the flash) or dropped until the next pointer move or
  // selection (the block and selection buttons).
  useEffect(() => {
    if (!container) return;
    let last = container.getBoundingClientRect();
    let frame = 0;
    const relayout = () => {
      frame = 0;
      const editorElement =
        (container.querySelector('.bn-editor') as HTMLElement | null) ?? container;
      const outside = roomOnTheRight(editorElement) >= BUBBLE_GUTTER;
      outsideRef.current = outside;
      const placement = outside ? 'outside' : 'inside';
      if (container.dataset.commentBubbles !== placement)
        container.dataset.commentBubbles = placement;
      const next = container.getBoundingClientRect();
      if (next.width === last.width && next.left === last.left) return;
      last = next;
      setHover(null);
      setSelection(null);
      setFlash(previous => {
        if (!previous) return previous;
        const content = blockContentEl(previous.blockId);
        return content ? { ...previous, ...flashBox(content) } : null;
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(relayout);
    };
    relayout();
    // The host and every ancestor (a centered column moves without resizing).
    const resize = new ResizeObserver(schedule);
    for (let node: Element | null = container; node; node = node.parentElement) {
      resize.observe(node);
    }
    window.addEventListener('resize', schedule);
    const panel = new MutationObserver(schedule);
    panel.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-comments-panel'],
    });
    // The page's padding transitions when the panel opens: again at its end.
    const settled = (event: TransitionEvent) => {
      if (event.target === document.body) schedule();
    };
    document.body.addEventListener('transitionend', settled);
    return () => {
      resize.disconnect();
      panel.disconnect();
      window.removeEventListener('resize', schedule);
      document.body.removeEventListener('transitionend', settled);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [container, blockContentEl, flashBox]);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const startFromSelection = () => {
    if (!selection) return;
    bridge.actions.startThread(selection.draft);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  return (
    <div ref={anchorRef} className="pg-comments-anchor">
      {flash && (
        <div
          key={flash.key}
          aria-hidden="true"
          className="pg-comment-flash"
          style={{ top: flash.top, left: flash.left, width: flash.width, height: flash.height }}
        />
      )}
      {hover && (
        <button
          type="button"
          className="pg-comment-block-button"
          style={{ top: hover.top, left: hover.left }}
          aria-label="Comment on this block"
          title="Comment on this block"
          onClick={() => {
            bridge.actions.startThread({ blockId: hover.blockId, quote: null, quoteOccurrence: 0 });
            setHover(null);
          }}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 20l1.3 -3.9a9 8 0 1 1 3.4 2.9l-4.7 1" />
            <path d="M12 9v4M10 11h4" />
          </svg>
        </button>
      )}
      {selection &&
        createPortal(
          <button
            type="button"
            // Keep the selection while the button is pressed.
            onMouseDown={event => event.preventDefault()}
            onClick={startFromSelection}
            className="fixed z-[60] -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-gray-900 px-3 py-1.5 text-xs font-medium text-white shadow-lg ring-1 ring-black/10 hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-white dark:text-gray-900 dark:ring-white/20 dark:hover:bg-gray-200"
            style={{ left: selection.x, top: selection.y }}
            aria-label="Comment on the selected text"
          >
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 20l1.3 -3.9a9 8 0 1 1 3.4 2.9l-4.7 1" />
            </svg>
            Comment
          </button>,
          document.body
        )}
    </div>
  );
}
