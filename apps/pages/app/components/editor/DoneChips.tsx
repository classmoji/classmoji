import { useCallback, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { useSectionStats } from '~/hooks/useSectionStats.ts';
import { doneChipSlots, noDoneChipSlots, subscribeDoneChipSlots } from './blocks/doneChipSlots.ts';
import { SectionActivityChip } from './SectionActivityChip.tsx';

/**
 * The "Done by X of Y" chips on this editor's checkable headings: one React
 * chip portaled into each heading's slot (`checkableBadge.ts`). Rendered
 * inside `SectionStatsContext`; without counts (anyone but OWNER/TEACHER)
 * nothing is drawn and the slots stay empty, which hides them.
 */
export function DoneChips({ editor }: { editor: object }) {
  const { stats } = useSectionStats();
  const subscribe = useCallback(
    (listener: () => void) => subscribeDoneChipSlots(editor, listener),
    [editor]
  );
  const getSnapshot = useCallback(() => doneChipSlots(editor), [editor]);
  const slots = useSyncExternalStore(subscribe, getSnapshot, noDoneChipSlots);
  if (!stats) return null;
  return (
    <>
      {slots.map(slot =>
        createPortal(
          <SectionActivityChip kind="check" blockId={slot.blockId} className="pg-done-chip" />,
          slot.element,
          String(slot.key)
        )
      )}
    </>
  );
}
