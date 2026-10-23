import { useEffect, useRef } from 'react';

import type { EditorFrames } from '../../utils/editorFrames.ts';
import {
  clipboardHtml,
  holdPastedMarkup,
  showPastedMarkup,
  watchInsertedNodes,
  type InsertedNodesWatch,
} from '../../utils/slideMarkup.ts';
import { htmlFileBlocksUnder } from './slideBlocks.ts';

/**
 * Input that puts markup into a slide: from elsewhere (a paste, a drop), or
 * back (an undo or redo can re-insert nodes a paste brought in as they were
 * before they were held).
 */
const BRINGS_IN_MARKUP = new Set([
  'insertFromPaste',
  'insertFromDrop',
  'insertFromPasteAsQuotation',
  'historyUndo',
  'historyRedo',
]);

/**
 * While editing, what typing does to html blocks and frames:
 *   - html blocks with a file of their own that an input takes out of a
 *     slide — delete, typing or pasting over a selection that held one —
 *     are reported to `onRemoved` (the file prompt). A cut is not: what is
 *     cut is on its way to a paste. A drag inside the deck removes and
 *     re-inserts: the check runs after both, so a moved block, still named
 *     in the deck, is not asked about;
 *   - markup pasted or dropped onto a slide (or put back by an undo or redo)
 *     is held to the slide markup lists (`holdPastedMarkup`: the inserted
 *     nodes only, as they land), then shown
 *     the editor's way (`showPastedMarkup`), as if the slide had been
 *     rendered with it; an html block copied from another deck keeps naming
 *     its file;
 *   - a copy or cut of the slides puts their authored form on the clipboard
 *     (`clipboardHtml`): never this page's display markers.
 */
export function useBlockRemovalWatch(
  enabled: boolean,
  onRemoved: (removed: Element[]) => void,
  frames: EditorFrames | null = null
): void {
  const onRemovedRef = useRef(onRemoved);
  onRemovedRef.current = onRemoved;
  const framesRef = useRef(frames);
  framesRef.current = frames;

  useEffect(() => {
    if (!enabled) return;
    return watchSlideInput(document, {
      onRemoved: removed => onRemovedRef.current(removed),
      frames: () => framesRef.current,
    });
  }, [enabled]);
}

/** {@link useBlockRemovalWatch} on `doc`, without React. Returns the cleanup. */
export function watchSlideInput(
  doc: Document,
  handlers: { onRemoved: (removed: Element[]) => void; frames: () => EditorFrames | null }
): () => void {
  let before: Element[] | null = null;
  // What a paste or drop inserts, watched from its beforeinput to its input.
  let inserting: InsertedNodesWatch | null = null;
  // A cut's own delete (below): never asked about.
  let cutting = false;

  const onBeforeInput = (event: Event) => {
    inserting?.stop();
    inserting = null;
    const target = event.target as Node | null;
    const deck = doc.querySelector('.reveal .slides');
    if (cutting || !deck || !target || !deck.contains(target)) return;
    const { inputType } = event as InputEvent;
    if (BRINGS_IN_MARKUP.has(inputType)) inserting = watchInsertedNodes(deck);
    // Only a delete, or an insert over a selection, can take a block out.
    // A cut is not asked about (see above).
    const removes =
      (inputType.startsWith('delete') && inputType !== 'deleteByCut') ||
      (inputType.startsWith('insert') && doc.getSelection()?.isCollapsed === false);
    before = removes ? htmlFileBlocksUnder(deck) : null;
  };

  const onInput = (event: Event) => {
    const { inputType } = event as InputEvent;
    const watch = inserting;
    inserting = null;
    if (watch) {
      const inserted = watch.take();
      if (BRINGS_IN_MARKUP.has(inputType)) {
        // Held before anything else looks at it, in the same task as the
        // insert: nothing inserted has loaded or run yet.
        holdPastedMarkup(inserted);
        const target = event.target as Node | null;
        const el = target?.nodeType === 1 ? (target as Element) : (target?.parentElement ?? null);
        const sections = new Set<Element>();
        for (const node of [el, ...inserted]) {
          const section = node?.isConnected ? node.closest('section') : null;
          if (section && section.closest('.reveal .slides')) sections.add(section);
        }
        for (const section of sections) showPastedMarkup(section, handlers.frames());
      }
    }
    const snapshot = before;
    before = null;
    if (!snapshot || snapshot.length === 0) return;
    setTimeout(() => {
      const gone = snapshot.filter(block => !block.isConnected);
      if (gone.length > 0) handlers.onRemoved(gone);
    }, 0);
  };

  const onCopyOrCut = (event: ClipboardEvent) => {
    const deck = doc.querySelector('.reveal .slides');
    const selection = doc.getSelection();
    if (!deck || !event.clipboardData || !selection || selection.isCollapsed) return;
    if (selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!deck.contains(range.commonAncestorContainer)) return;
    event.clipboardData.setData('text/html', clipboardHtml(range.cloneContents(), doc));
    event.clipboardData.setData('text/plain', selection.toString());
    event.preventDefault();
    if (event.type === 'cut') {
      cutting = true;
      try {
        doc.execCommand('delete');
      } finally {
        cutting = false;
      }
    }
  };

  doc.addEventListener('beforeinput', onBeforeInput, true);
  doc.addEventListener('input', onInput, true);
  doc.addEventListener('copy', onCopyOrCut, true);
  doc.addEventListener('cut', onCopyOrCut, true);
  return () => {
    inserting?.stop();
    inserting = null;
    doc.removeEventListener('beforeinput', onBeforeInput, true);
    doc.removeEventListener('input', onInput, true);
    doc.removeEventListener('copy', onCopyOrCut, true);
    doc.removeEventListener('cut', onCopyOrCut, true);
  };
}
