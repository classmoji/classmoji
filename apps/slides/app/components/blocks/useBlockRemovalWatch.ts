import { useEffect, useRef } from 'react';

import { adoptPastedHtmlBlocks, showFrames, type EditorFrames } from '~/utils/editorFrames';
import { clipboardHtml } from '~/utils/slideMarkup';
import { htmlFileBlocksUnder } from './slideBlocks';

/** Input that brings in markup from elsewhere. */
const INSERTS_MARKUP = new Set(['insertFromPaste', 'insertFromDrop', 'insertFromPasteAsQuotation']);

/**
 * While editing, what typing does to html blocks and frames:
 *   - html blocks with a file of their own that an input takes out of a
 *     slide — delete, typing or pasting over a selection that held one —
 *     are reported to `onRemoved` (the file prompt). A cut is not: what is
 *     cut is on its way to a paste. A drag inside the deck removes and
 *     re-inserts: the check runs after both, so a moved block, still named
 *     in the deck, is not asked about;
 *   - frames pasted or dropped onto a slide are shown the editor's way
 *     (`frames`), as if the slide had been rendered with them; an html block
 *     copied from another deck keeps naming its file (`adoptPastedHtmlBlocks`);
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
    let before: Element[] | null = null;
    // A cut's own delete (below): never asked about.
    let cutting = false;

    const onBeforeInput = (event: Event) => {
      const target = event.target as Node | null;
      const deck = document.querySelector('.reveal .slides');
      if (cutting || !deck || !target || !deck.contains(target)) return;
      const { inputType } = event as InputEvent;
      // Only a delete, or an insert over a selection, can take a block out.
      // A cut is not asked about (see above).
      const removes =
        (inputType.startsWith('delete') && inputType !== 'deleteByCut') ||
        (inputType.startsWith('insert') && document.getSelection()?.isCollapsed === false);
      before = removes ? htmlFileBlocksUnder(deck) : null;
    };

    const onInput = (event: Event) => {
      const { inputType } = event as InputEvent;
      if (INSERTS_MARKUP.has(inputType)) {
        const target = event.target as Node | null;
        const el = target instanceof Element ? target : (target?.parentElement ?? null);
        const section = el?.closest('section');
        if (section && section.closest('.reveal .slides')) {
          adoptPastedHtmlBlocks(section, framesRef.current);
          showFrames(section, framesRef.current);
        }
      }
      const snapshot = before;
      before = null;
      if (!snapshot || snapshot.length === 0) return;
      setTimeout(() => {
        const gone = snapshot.filter(block => !block.isConnected);
        if (gone.length > 0) onRemovedRef.current(gone);
      }, 0);
    };

    const onCopyOrCut = (event: ClipboardEvent) => {
      const deck = document.querySelector('.reveal .slides');
      const selection = document.getSelection();
      if (!deck || !event.clipboardData || !selection || selection.isCollapsed) return;
      if (selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!deck.contains(range.commonAncestorContainer)) return;
      event.clipboardData.setData('text/html', clipboardHtml(range.cloneContents(), document));
      event.clipboardData.setData('text/plain', selection.toString());
      event.preventDefault();
      if (event.type === 'cut') {
        cutting = true;
        try {
          document.execCommand('delete');
        } finally {
          cutting = false;
        }
      }
    };

    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('copy', onCopyOrCut, true);
    document.addEventListener('cut', onCopyOrCut, true);
    return () => {
      document.removeEventListener('beforeinput', onBeforeInput, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('copy', onCopyOrCut, true);
      document.removeEventListener('cut', onCopyOrCut, true);
    };
  }, [enabled]);
}
