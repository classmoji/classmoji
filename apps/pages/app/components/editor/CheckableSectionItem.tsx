import { SideMenuExtension } from '@blocknote/core/extensions';
import { useBlockNoteEditor, useComponentsContext, useExtensionState } from '@blocknote/react';
import { IconSquareCheck, IconUserCheck } from '@tabler/icons-react';

import { PERSONAL_LIST_LABEL } from './blocks/checkableBadge.ts';
import { setCheckListPersonal, type PersonalListEditor } from './personalCheckList.ts';

/**
 * Drag-handle menu item for headings: "Checkable section", with a switch.
 * On, readers get a tick box on the heading and its section fades once
 * ticked. Off clears the prop to `undefined` (never `false`): the prop has no
 * default, and a heading that never had it must not gain `"checkable": false`.
 */
export function CheckableSectionItem() {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext();
  const block = useExtensionState(SideMenuExtension, {
    selector: state => state?.block,
  });

  if (!block || block.type !== 'heading' || !Components) return null;
  const on = (block.props as { checkable?: unknown }).checkable === true;

  return (
    <Components.Generic.Menu.Item
      // BlockNote's item passes extra props through to Mantine's, which sets
      // role="menuitem" after them (so aria-checked would be invalid there):
      // the switch's state is in the item's accessible name instead.
      {...({ 'aria-label': `Checkable section, ${on ? 'on' : 'off'}` } as object)}
      className="pg-checkable-item"
      onClick={() => {
        editor.updateBlock(block, {
          props: { checkable: on ? undefined : true },
        } as never);
      }}
      icon={<IconSquareCheck size={16} />}
    >
      <span className="pg-checkable-item-row">
        Checkable section
        <span className="pg-switch" data-on={on ? 'true' : 'false'} aria-hidden="true" />
      </span>
    </Components.Generic.Menu.Item>
  );
}

/**
 * Drag-handle menu item for check list items: "Students tick their own", with
 * a switch. On, the whole list (the run of adjacent check list items) becomes
 * a student check list: each reader ticks their own copy, and the author's
 * ticks are what signed-out readers and the class site show. Off clears
 * `personal` on the whole list.
 */
export function PersonalCheckListItem() {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext();
  const block = useExtensionState(SideMenuExtension, {
    selector: state => state?.block,
  });

  if (!block || block.type !== 'checkListItem' || !Components) return null;
  const on = (block.props as { personal?: unknown }).personal === true;

  return (
    <Components.Generic.Menu.Item
      // The switch's state is in the accessible name (see CheckableSectionItem).
      {...({ 'aria-label': `${PERSONAL_LIST_LABEL}, ${on ? 'on' : 'off'}` } as object)}
      className="pg-checkable-item"
      onClick={() => {
        setCheckListPersonal(editor as unknown as PersonalListEditor, block.id, !on);
      }}
      icon={<IconUserCheck size={16} />}
    >
      <span className="pg-checkable-item-row">
        {PERSONAL_LIST_LABEL}
        <span className="pg-switch" data-on={on ? 'true' : 'false'} aria-hidden="true" />
      </span>
    </Components.Generic.Menu.Item>
  );
}

/**
 * The checkable badge sits in the heading's gutter (and the student check
 * list badge in its item's), where BlockNote's side menu (add + drag handle)
 * appears for the block under the pointer. While the side menu is on a block,
 * that block's badge steps aside.
 */
export function CheckableBadgeYield() {
  const blockId = useExtensionState(SideMenuExtension, {
    selector: state => (state?.show ? state.block.id : null),
  });
  if (!blockId || typeof CSS === 'undefined' || typeof CSS.escape !== 'function') return null;
  return (
    <style>{`.bn-block-outer[data-id="${CSS.escape(blockId)}"] > .bn-block > .bn-block-content[data-content-type="heading"][data-checkable="true"] .pg-checkable-badge, .bn-block-outer[data-id="${CSS.escape(blockId)}"] > .bn-block > .bn-block-content[data-content-type="checkListItem"][data-personal="true"] > .pg-personal-badge { opacity: 0; pointer-events: none; }`}</style>
  );
}
