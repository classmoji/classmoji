import { SideMenuExtension } from '@blocknote/core/extensions';
import { useBlockNoteEditor, useComponentsContext, useExtensionState } from '@blocknote/react';
import { IconSquareCheck } from '@tabler/icons-react';

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
      // BlockNote's item passes extra props through to Mantine's: the item is
      // a checkbox in the menu, not a plain command.
      {...({ role: 'menuitemcheckbox', 'aria-checked': on } as object)}
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
 * The checkable badge sits in the heading's gutter, where BlockNote's side
 * menu (add + drag handle) appears for the block under the pointer. While the
 * side menu is on a block, that block's badge steps aside.
 */
export function CheckableBadgeYield() {
  const blockId = useExtensionState(SideMenuExtension, {
    selector: state => (state?.show ? state.block.id : null),
  });
  if (!blockId || typeof CSS === 'undefined' || typeof CSS.escape !== 'function') return null;
  return (
    <style>{`.bn-block-outer[data-id="${CSS.escape(blockId)}"] > .bn-block > .bn-block-content[data-content-type="heading"][data-checkable="true"] .pg-checkable-badge { opacity: 0; pointer-events: none; }`}</style>
  );
}
