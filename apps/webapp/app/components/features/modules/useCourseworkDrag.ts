import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { dragRowClass, type DropTarget } from '~/hooks';

/**
 * Dragging for the rows on the Modules page: content (pages, slides) and
 * assignments, within a module and between modules.
 *
 * Unlike `useDragReorder`, which owns one self-contained list, this hook is
 * mounted ONCE for the whole page and hands each card its slice. A row leaving
 * one card for another is a single gesture across two lists, so one owner has
 * to see both ends of it.
 *
 * A drop always sends the TARGET module its full new ordering, the moved row
 * included; the server moves the row and reindexes both sides. Until the loader
 * agrees, the move is shown locally, so the row does not jump back to where it
 * started for the length of the round trip.
 */
export type CourseworkScope = 'content' | 'assignment';

export interface CourseworkRow {
  id: string;
}

/**
 * One module's two lists. The rows themselves are only ever identified and
 * reordered here, so `id` is all this hook needs to know about them; the card
 * renders each list with its own concrete row type.
 */
export interface CourseworkList {
  id: string;
  content: CourseworkRow[];
  assignments: CourseworkRow[];
}

export interface CourseworkMove {
  scope: CourseworkScope;
  rowId: string;
  fromModuleId: string;
  toModuleId: string;
  /** The target module's full ordering after the move, `rowId` included. */
  orderedIds: string[];
}

interface Pending extends CourseworkMove {
  /** The row itself, so the target card can render it before the loader does. */
  row: CourseworkRow;
}

/** What one card needs for one of its two lists. */
export interface CourseworkListDrag {
  items: CourseworkRow[];
  rowProps: (id: string) => Record<string, unknown> | undefined;
  handleProps: (id: string) => Record<string, unknown> | undefined;
  rowClassName: (id: string) => string;
}

export interface CourseworkCardDrag {
  content: CourseworkListDrag;
  assignments: CourseworkListDrag;
  /** Drop anywhere else on the card: the row joins the end of its own group. */
  cardProps: Record<string, unknown> | undefined;
  /** True while a row from another card is over this one. */
  isDropTarget: boolean;
}

/**
 * Merge several sets of drag handlers onto one element — a module card is both
 * a row in the page's list and a drop target for coursework. Same-name
 * handlers are chained; everything else is last-wins.
 */
export const mergeDragProps = (
  ...sets: Array<Record<string, unknown> | undefined>
): Record<string, unknown> => {
  const merged: Record<string, unknown> = {};
  for (const set of sets) {
    if (!set) continue;
    for (const [key, value] of Object.entries(set)) {
      const previous = merged[key];
      if (typeof previous === 'function' && typeof value === 'function') {
        merged[key] = (...args: unknown[]) => {
          (previous as (...a: unknown[]) => void)(...args);
          (value as (...a: unknown[]) => void)(...args);
        };
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
};

export const useCourseworkDrag = ({
  lists,
  onMove,
  enabled = true,
}: {
  lists: CourseworkList[];
  onMove: (move: CourseworkMove) => void;
  enabled?: boolean;
}) => {
  const dragRef = useRef<{ scope: CourseworkScope; id: string; fromModuleId: string } | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [over, setOver] = useState<{
    moduleId: string;
    scope: CourseworkScope;
    rowId?: string;
    after?: boolean;
  } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  /** The order a card should render, with any unsaved move already applied. */
  const project = useCallback(
    (moduleId: string, scope: CourseworkScope, items: CourseworkRow[]): CourseworkRow[] => {
      if (!pending || pending.scope !== scope) return items;
      if (moduleId === pending.fromModuleId && moduleId !== pending.toModuleId) {
        return items.filter(item => item.id !== pending.rowId);
      }
      if (moduleId !== pending.toModuleId) return items;

      const byId = new Map(items.map(item => [item.id, item]));
      if (!byId.has(pending.rowId)) byId.set(pending.rowId, pending.row);
      const ordered = pending.orderedIds
        .map(id => byId.get(id))
        .filter((item): item is CourseworkRow => Boolean(item));
      // Anything added since the drag still shows, after the moved row.
      const seen = new Set(pending.orderedIds);
      return [...ordered, ...items.filter(item => !seen.has(item.id))];
    },
    [pending]
  );

  // Once the server's order for the target matches the drop, stop overriding.
  useEffect(() => {
    if (!pending) return;
    const target = lists.find(list => list.id === pending.toModuleId);
    const ids = (pending.scope === 'content' ? target?.content : target?.assignments) ?? [];
    const settled =
      ids.length === pending.orderedIds.length &&
      ids.every((item, i) => item.id === pending.orderedIds[i]);
    if (settled) setPending(null);
  }, [lists, pending]);

  const reset = useCallback(() => {
    dragRef.current = null;
    setArmedId(null);
    setDraggingId(null);
    setOver(null);
  }, []);

  /** The ids a module's list holds right now, as rendered. */
  const currentIds = useCallback(
    (moduleId: string, scope: CourseworkScope) => {
      const list = lists.find(entry => entry.id === moduleId);
      if (!list) return [];
      const items = scope === 'content' ? list.content : list.assignments;
      return project(moduleId, scope, items).map(item => item.id);
    },
    [lists, project]
  );

  const commit = useCallback(
    (toModuleId: string, orderedIds: string[]) => {
      const source = dragRef.current;
      if (!source) return;
      const list = lists.find(entry => entry.id === source.fromModuleId);
      const rows = source.scope === 'content' ? list?.content : list?.assignments;
      const row = rows?.find(item => item.id === source.id);
      const move: CourseworkMove = {
        scope: source.scope,
        rowId: source.id,
        fromModuleId: source.fromModuleId,
        toModuleId,
        orderedIds,
      };
      reset();
      const before = currentIds(toModuleId, move.scope);
      const unchanged =
        toModuleId === move.fromModuleId &&
        before.length === orderedIds.length &&
        before.every((id, i) => id === orderedIds[i]);
      if (unchanged) return;
      if (row) setPending({ ...move, row });
      onMove(move);
    },
    [currentIds, lists, onMove, reset]
  );

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

  const rowProps = useCallback(
    (moduleId: string, scope: CourseworkScope, id: string) => {
      if (!enabled) return undefined;
      return {
        draggable: armedId === id,
        onDragStart: (e: React.DragEvent) => {
          // The card around this row is a draggable row of its own; dragstart
          // fires only on the armed element, so keep it from arming that too.
          e.stopPropagation();
          dragRef.current = { scope, id, fromModuleId: moduleId };
          setDraggingId(id);
          e.dataTransfer.effectAllowed = 'move';
          try {
            e.dataTransfer.setData('text/plain', id);
          } catch {
            /* Safari refuses setData outside a user gesture; the ref carries it. */
          }
        },
        onDragOver: (e: React.DragEvent) => {
          const source = dragRef.current;
          // A module card being dragged, or a row of the other kind: leave it
          // to the card, which drops the row into the group it belongs to.
          if (!source || source.scope !== scope || source.id === id) return;
          e.stopPropagation();
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          // Which side of the row the pointer is on decides where it lands, so
          // the line the user sees is exactly where it goes.
          const rect = e.currentTarget.getBoundingClientRect();
          setOver({
            moduleId,
            scope,
            rowId: id,
            after: e.clientY > rect.top + rect.height / 2,
          });
        },
        onDrop: (e: React.DragEvent) => {
          const source = dragRef.current;
          if (!source || source.scope !== scope) return;
          e.stopPropagation();
          e.preventDefault();
          const after = over?.rowId === id ? Boolean(over.after) : false;
          const ids = currentIds(moduleId, scope).filter(existing => existing !== source.id);
          const at = ids.indexOf(id);
          if (at < 0) return reset();
          ids.splice(at + (after ? 1 : 0), 0, source.id);
          commit(moduleId, ids);
        },
        onDragEnd: reset,
      };
    },
    [armedId, commit, currentIds, enabled, over, reset]
  );

  const cardProps = useCallback(
    (moduleId: string) => {
      if (!enabled) return undefined;
      return {
        onDragOver: (e: React.DragEvent) => {
          const source = dragRef.current;
          if (!source) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          // No row claimed the pointer, so the drop appends to the group.
          setOver(prev =>
            prev?.moduleId === moduleId && prev.rowId ? prev : { moduleId, scope: source.scope }
          );
        },
        onDrop: (e: React.DragEvent) => {
          const source = dragRef.current;
          if (!source) return;
          e.preventDefault();
          e.stopPropagation();
          const ids = currentIds(moduleId, source.scope).filter(id => id !== source.id);
          ids.push(source.id);
          commit(moduleId, ids);
        },
      };
    },
    [commit, currentIds, enabled]
  );

  const forModule = useCallback(
    (moduleId: string): CourseworkCardDrag => {
      const list = lists.find(entry => entry.id === moduleId);
      const buildList = (scope: CourseworkScope): CourseworkListDrag => {
        const items = project(
          moduleId,
          scope,
          (scope === 'content' ? list?.content : list?.assignments) ?? []
        );
        const target: DropTarget | null =
          over?.moduleId === moduleId && over.scope === scope && over.rowId
            ? { id: over.rowId, after: Boolean(over.after) }
            : null;
        return {
          items,
          rowProps: (id: string) => rowProps(moduleId, scope, id),
          handleProps,
          rowClassName: (id: string) => dragRowClass(id, draggingId, target),
        };
      };
      return {
        content: buildList('content'),
        assignments: buildList('assignment'),
        cardProps: cardProps(moduleId),
        // Only worth calling out when the row would land somewhere new.
        isDropTarget:
          over?.moduleId === moduleId &&
          Boolean(dragRef.current) &&
          dragRef.current?.fromModuleId !== moduleId,
      };
    },
    [cardProps, draggingId, handleProps, lists, over, project, rowProps]
  );

  return useMemo(() => ({ forModule, draggingId }), [forModule, draggingId]);
};
