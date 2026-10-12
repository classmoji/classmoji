import { useCallback } from 'react';
import { SideMenuExtension, SuggestionMenu } from '@blocknote/core/extensions';
import {
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtension,
  useExtensionState,
} from '@blocknote/react';
import { IconPlus } from '@tabler/icons-react';

/**
 * The side menu's add (+) button: BlockNote's own behaviour (an empty block
 * opens the slash menu in place; otherwise a paragraph is added below and the
 * slash menu opens there), with the click handled by the BUTTON.
 *
 * BlockNote 0.55 attaches its handler to the icon inside the button, so only
 * a click that lands on the drawn plus does anything: the button's edges, its
 * enlarged hit area (blocknote-overrides.css) and Enter/Space on the focused
 * button all did nothing.
 */
export function AddBlockButton() {
  const Components = useComponentsContext();
  const dict = useDictionary();
  const editor = useBlockNoteEditor();
  const suggestionMenu = useExtension(SuggestionMenu);
  const block = useExtensionState(SideMenuExtension, {
    selector: state => state?.block,
  });

  const onClick = useCallback(() => {
    if (block === undefined) return;
    const content = block.content;
    const empty = Array.isArray(content) && content.length === 0;
    if (empty) {
      editor.setTextCursorPosition(block);
    } else {
      const inserted = editor.insertBlocks([{ type: 'paragraph' }], block, 'after')[0];
      editor.setTextCursorPosition(inserted);
    }
    suggestionMenu.openSuggestionMenu('/');
  }, [block, editor, suggestionMenu]);

  if (block === undefined || !Components) return null;

  return (
    <Components.SideMenu.Button
      className="bn-button"
      label={dict.side_menu.add_block_label}
      onClick={onClick}
      icon={
        // BlockNote's CSS fixes the icon box at 22px; tabler's plus fills less
        // of its box than BlockNote's own icon did, so draw it a little larger
        // to keep the same visual size beside the drag handle.
        <IconPlus
          size={24}
          stroke={1.5}
          style={{ transform: 'scale(1.2)' }}
          data-test="dragHandleAdd"
        />
      }
    />
  );
}
