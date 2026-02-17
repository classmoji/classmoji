import { SideMenuExtension } from '@blocknote/core/extensions';
import {
  useBlockNoteEditor,
  useComponentsContext,
  useExtensionState,
} from '@blocknote/react';
import { IconReplace, IconPhotoOff } from '@tabler/icons-react';

/**
 * Custom drag handle menu item that resets a video/embed block's URL,
 * returning it to the empty input state so the user can enter a new URL.
 *
 * Only renders for block types that have a `url` prop (video, embed).
 */
export function ReplaceUrlItem({ children }) {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext();

  const block = useExtensionState(SideMenuExtension, {
    selector: (state) => state?.block,
  });

  if (!block) return null;

  // Only show for blocks with a url prop that has a value
  const hasUrl = block.type === 'video' || block.type === 'embed';
  if (!hasUrl || !block.props?.url) return null;

  return (
    <Components.Generic.Menu.Item
      onClick={() => {
        editor.updateBlock(block, {
          props: { url: '' },
        });
      }}
      icon={<IconReplace size={16} />}
    >
      {children}
    </Components.Generic.Menu.Item>
  );
}

/**
 * Custom drag handle menu item that removes a profile block's image.
 *
 * Only renders for profile blocks that have an imageUrl set.
 */
export function RemoveProfileImageItem({ children }) {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext();

  const block = useExtensionState(SideMenuExtension, {
    selector: (state) => state?.block,
  });

  if (!block) return null;
  if (block.type !== 'profile' || !block.props?.imageUrl) return null;

  return (
    <Components.Generic.Menu.Item
      onClick={() => {
        editor.updateBlock(block, {
          props: { imageUrl: '' },
        });
      }}
      icon={<IconPhotoOff size={16} />}
    >
      {children}
    </Components.Generic.Menu.Item>
  );
}
