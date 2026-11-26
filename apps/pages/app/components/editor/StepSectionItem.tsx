import { SideMenuExtension } from '@blocknote/core/extensions';
import { useBlockNoteEditor, useComponentsContext, useExtensionState } from '@blocknote/react';
import { IconListNumbers } from '@tabler/icons-react';

import { STEP_MAX_LEVEL } from '@classmoji/page-schema/sections';

/**
 * Drag-handle menu item for H1 and H2: "Step", with a switch. On, the heading
 * is a numbered step: a circle with its number, and a line to the next step
 * (drawn from the document, utils/stepStyles.ts). Off clears the prop to
 * `undefined` (never `false`), as Checkable section does: the prop has no
 * default, and a heading that never had it must not gain `"step": false`.
 *
 * Offered only where a step can be drawn: a heading deeper than H2 gets no
 * item.
 */
export function StepSectionItem() {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext();
  const block = useExtensionState(SideMenuExtension, {
    selector: state => state?.block,
  });

  if (!block || block.type !== 'heading' || !Components) return null;
  const level = Number((block.props as { level?: unknown }).level ?? 1);
  if (!(level <= STEP_MAX_LEVEL)) return null;
  const on = (block.props as { step?: unknown }).step === true;

  return (
    <Components.Generic.Menu.Item
      // The switch's state is in the accessible name (see CheckableSectionItem).
      {...({ 'aria-label': `Step, ${on ? 'on' : 'off'}` } as object)}
      className="pg-checkable-item"
      onClick={() => {
        editor.updateBlock(block, {
          props: { step: on ? undefined : true },
        } as never);
      }}
      icon={<IconListNumbers size={16} />}
    >
      <span className="pg-checkable-item-row">
        Step
        <span className="pg-switch" data-on={on ? 'true' : 'false'} aria-hidden="true" />
      </span>
    </Components.Generic.Menu.Item>
  );
}
