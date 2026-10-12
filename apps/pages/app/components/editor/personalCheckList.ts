import { checkListRun } from '@classmoji/page-schema/sections';

/** The editor calls this needs (a BlockNote editor has them all). */
export interface PersonalListEditor {
  document: unknown;
  transact<T>(fn: () => T): T;
  updateBlock(id: string, update: { props: { personal: true | undefined } }): unknown;
}

/**
 * Make the check list `blockId` belongs to a student check list, or a plain
 * one again: every item of the run of adjacent sibling check list items
 * (`checkListRun`), in ONE transaction (one undo step, one collab update).
 * Off clears the prop to `undefined`, never `false` (the prop has no default;
 * an item that never had it must not gain `"personal": false`). Returns the
 * ids it changed.
 */
export function setCheckListPersonal(
  editor: PersonalListEditor,
  blockId: string,
  personal: boolean
): string[] {
  const run = checkListRun(editor.document, blockId);
  if (run.length === 0) return [];
  editor.transact(() => {
    for (const id of run) {
      editor.updateBlock(id, { props: { personal: personal ? true : undefined } });
    }
  });
  return run;
}
