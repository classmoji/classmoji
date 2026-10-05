/**
 * Who changed a deck's STRUCTURE: the slides a transaction inserted, deleted
 * or moved (order, or in/out of a stack), so the server can put a person's
 * structural edits in the audit log next to the agents' deck_apply rows —
 * "who deleted slide X" is then one query over both.
 *
 * Read from the transaction's own events (an observer on the deck's `slides`
 * map), never by diffing snapshots: cheap on every keystroke (an html edit is
 * one nested-map event whose changed keys are checked and dropped).
 */
import * as Y from 'yjs';
import { F, deckSlides } from '@classmoji/collab';

export type StructuralOp =
  | { op: 'insert'; id: string }
  | { op: 'delete'; id: string }
  | { op: 'move'; id: string; parent?: string | null };

/**
 * Watch `doc`'s slides; returns a lookup of the structural ops a finished
 * transaction made (empty when it made none). The lookup is valid from the
 * doc's `afterTransaction` on (observers run before it).
 */
export function watchDeckStructure(doc: Y.Doc): {
  opsOf(tr: Y.Transaction): StructuralOp[];
  stop(): void;
} {
  const slides = deckSlides(doc) as Y.Map<unknown>;
  const byTx = new WeakMap<Y.Transaction, StructuralOp[]>();

  const observer = (events: Array<Y.YEvent<any>>, tr: Y.Transaction) => {
    const ops: StructuralOp[] = [];
    const inserted = new Set<string>();
    const moved = new Map<string, StructuralOp>();
    for (const event of events) {
      if (event.target === slides) {
        for (const [id, change] of event.changes.keys) {
          if (change.action === 'add') {
            inserted.add(id);
            ops.push({ op: 'insert', id });
          } else if (change.action === 'delete') {
            ops.push({ op: 'delete', id });
          }
        }
        continue;
      }
      // A slide's own fields: only order / parent are structure.
      if (event.path.length !== 1 || !(event.target instanceof Y.Map)) continue;
      const keys = (event as Y.YMapEvent<unknown>).keysChanged;
      if (!keys.has(F.order) && !keys.has(F.parent)) continue;
      const id = String(event.path[0]);
      const op: StructuralOp = keys.has(F.parent)
        ? { op: 'move', id, parent: (event.target.get(F.parent) as string | null) ?? null }
        : { op: 'move', id };
      moved.set(id, op);
    }
    for (const [id, op] of moved) if (!inserted.has(id)) ops.push(op);
    if (ops.length > 0) byTx.set(tr, ops);
  };
  slides.observeDeep(observer);

  return {
    opsOf: tr => byTx.get(tr) ?? [],
    stop: () => slides.unobserveDeep(observer),
  };
}

/** A short, distinct summary of a batch (`delete 2555ece5, move 8014c590`). */
export function summarizeStructure(ops: readonly StructuralOp[], max = 300): string {
  const text = ops.map(o => `${o.op} ${o.id}`).join(', ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
