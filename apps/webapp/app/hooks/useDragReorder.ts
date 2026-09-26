import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Drag-to-reorder for a vertical list, over the native HTML5 drag events (the
 * same pattern the classroom cards on the landing screen use, so no drag
 * library is pulled in for it).
 *
 * Two things make it behave on rows that are full of buttons:
 *
 *   - Dragging is *armed* by a handle. `draggable` on a row that holds links
 *     and menus swallows ordinary clicks and text selection, so a row is only
 *     draggable while the pointer is down on its grip.
 *   - The new order is held locally until the server hands it back. Without
 *     that, the row snaps to its old place for the length of the round trip.
 */
export interface DragReorderRow {
  id: string;
}

/** Where the dragged row would land: on the far side of `id` when `after`. */
export interface DropTarget {
  id: string;
  after: boolean;
}

export const useDragReorder = <T extends DragReorderRow>(
  items: T[],
  onReorder: (orderedIds: string[]) => void,
  enabled = true
) => {
  const dragId = useRef<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // The order this list was last dragged into, shown until the loader agrees.
  const [pending, setPending] = useState<string[] | null>(null);

  const ordered = useMemo(() => {
    if (!pending) return items;
    const byId = new Map(items.map(item => [item.id, item]));
    const moved = pending.map(id => byId.get(id)).filter(Boolean) as T[];
    // Anything added since the drag (or dropped by a failed save) still shows.
    const seen = new Set(pending);
    return [...moved, ...items.filter(item => !seen.has(item.id))];
  }, [items, pending]);

  // Once the server's order matches what was dragged, stop overriding it.
  useEffect(() => {
    if (!pending) return;
    const settled =
      items.length === pending.length && items.every((item, i) => item.id === pending[i]);
    if (settled) setPending(null);
  }, [items, pending]);

  const reset = useCallback(() => {
    dragId.current = null;
    setArmedId(null);
    setDraggingId(null);
    setDropTarget(null);
  }, []);

  /**
   * Props for the grip: holding it down is what makes the row draggable.
   * `undefined` while the list cannot be reordered, so the caller can tell a
   * dead handle from a live one and hide it.
   */
  const handleProps = useCallback(
    (id: string) =>
      enabled
        ? {
            draggable: false,
            onMouseDown: () => setArmedId(id),
            onMouseUp: () => setArmedId(null),
            onClick: (e: React.MouseEvent) => e.stopPropagation(),
          }
        : undefined,
    [enabled]
  );

  /** Props for the row itself. */
  const rowProps = useCallback(
    (id: string) => {
      if (!enabled) return undefined;
      return {
        draggable: armedId === id,
        onDragStart: (e: React.DragEvent) => {
          // Lists nest (rows inside a module card that is itself a row), and
          // dragstart only fires on the armed element, so the drag belongs to
          // this list alone: keep it from reaching the list around it.
          e.stopPropagation();
          dragId.current = id;
          setDraggingId(id);
          e.dataTransfer.effectAllowed = 'move';
          try {
            e.dataTransfer.setData('text/plain', id);
          } catch {
            /* Safari refuses setData outside a user gesture; the ref carries it. */
          }
        },
        onDragOver: (e: React.DragEvent) => {
          const source = dragId.current;
          // Nothing of ours is being dragged: let the list around this one
          // decide, so a card dropped on a row still lands between cards.
          if (!source || source === id) return;
          e.stopPropagation();
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const ids = ordered.map(item => item.id);
          setDropTarget({ id, after: ids.indexOf(source) < ids.indexOf(id) });
        },
        onDrop: (e: React.DragEvent) => {
          // A drop from some other list (a module card landing on a row inside
          // another card) has to keep bubbling to the list that owns it.
          const source = dragId.current;
          if (!source) return;
          e.preventDefault();
          e.stopPropagation();
          reset();
          if (source === id) return;
          const ids = ordered.map(item => item.id);
          const from = ids.indexOf(source);
          const to = ids.indexOf(id);
          if (from < 0 || to < 0) return;
          const next = ids.slice();
          next.splice(from, 1);
          next.splice(to, 0, source);
          setPending(next);
          onReorder(next);
        },
        onDragEnd: reset,
      };
    },
    [armedId, enabled, onReorder, ordered, reset]
  );

  return { ordered, draggingId, dropTarget, handleProps, rowProps };
};

/**
 * The insertion line a row shows while something is dragged over it, plus the
 * dimming of the row being dragged. Shared so every reorderable list in the
 * app reads the same way.
 */
export const dragRowClass = (
  id: string,
  draggingId: string | null,
  dropTarget: DropTarget | null
) => {
  const dragging = draggingId === id ? 'opacity-40' : '';
  if (dropTarget?.id !== id) return dragging;
  const line = dropTarget.after
    ? 'after:top-auto after:-bottom-px'
    : 'after:-top-px after:bottom-auto';
  return `${dragging} relative after:pointer-events-none after:absolute after:inset-x-0 after:h-0.5 after:rounded-full after:bg-sky-500 ${line}`;
};
