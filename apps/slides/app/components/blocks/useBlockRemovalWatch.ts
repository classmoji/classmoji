import { useEffect, useRef } from 'react';

import { showFrames, type EditorFrames } from '~/utils/editorFrames';
import { htmlFileBlocksUnder } from './slideBlocks';

/** Input that brings in markup from elsewhere. */
const INSERTS_MARKUP = new Set(['insertFromPaste', 'insertFromDrop', 'insertFromPasteAsQuotation']);

/**
 * While editing, what typing does to html blocks and frames:
 *   - html blocks with a file of their own that an input takes out of a
 *     slide — cut, delete, typing or pasting over a selection that held
 *     one — are reported to `onRemoved` (the file prompt). A drag inside the
 *     deck removes and re-inserts: the check runs after both, so a moved
 *     block, still named in the deck, is not asked about;
 *   - frames pasted or dropped onto a slide are shown the editor's way
 *     (`frames`), as if the slide had been rendered with them.
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

    const onBeforeInput = (event: Event) => {
      const target = event.target as Node | null;
      const deck = document.querySelector('.reveal .slides');
      if (!deck || !target || !deck.contains(target)) return;
      const { inputType } = event as InputEvent;
      // Only a delete, or an insert over a selection, can take a block out.
      const removes =
        inputType.startsWith('delete') ||
        (inputType.startsWith('insert') && document.getSelection()?.isCollapsed === false);
      before = removes ? htmlFileBlocksUnder(deck) : null;
    };

    const onInput = (event: Event) => {
      const { inputType } = event as InputEvent;
      if (INSERTS_MARKUP.has(inputType)) {
        const target = event.target as Node | null;
        const el = target instanceof Element ? target : (target?.parentElement ?? null);
        const section = el?.closest('section');
        if (section && section.closest('.reveal .slides')) showFrames(section, framesRef.current);
      }
      const snapshot = before;
      before = null;
      if (!snapshot || snapshot.length === 0) return;
      setTimeout(() => {
        const gone = snapshot.filter(block => !block.isConnected);
        if (gone.length > 0) onRemovedRef.current(gone);
      }, 0);
    };

    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('input', onInput, true);
    return () => {
      document.removeEventListener('beforeinput', onBeforeInput, true);
      document.removeEventListener('input', onInput, true);
    };
  }, [enabled]);
}
