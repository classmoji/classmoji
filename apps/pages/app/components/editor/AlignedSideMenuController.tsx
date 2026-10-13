import React, { useMemo } from 'react';
import type { Block, BlockNoteEditor } from '@blocknote/core';
import { SideMenuExtension } from '@blocknote/core/extensions';
import {
  SideMenuController,
  useBlockNoteEditor,
  useExtensionState,
  type FloatingUIOptions,
  type SideMenuProps,
} from '@blocknote/react';

// Schema-agnostic, as in BlockNote's own side menu (its extension state hands
// back an untyped block).
/* eslint-disable @typescript-eslint/no-explicit-any */
type Editor = BlockNoteEditor<any, any, any>;
type SideMenuBlock = Block<any, any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */
type Middleware = NonNullable<
  NonNullable<FloatingUIOptions['useFloatingOptions']>['middleware']
>[number];

/**
 * BlockNote's SideMenuController centers the menu on a block's first line with
 * offsets hard-coded for ITS heading scale (H1 3em, H2 2em, H3 1.3em, line
 * height 1.5): 39 / 27 / 18.5px. Pages sizes headings 30 / 24 / 20px, so those
 * constants put the handle well below an H1 and a little off on every other
 * level. This controller measures the first line of whatever block is hovered
 * instead, so the menu follows the page's own type scale, including custom
 * blocks with padding (callouts, alerts) and any future change to it.
 *
 * Passing a middleware REPLACES BlockNote's (its options are spread over the
 * controller's own), so the blocks without inline content keep BlockNote's
 * values, ported from its `getBlockOffset`, which is not exported.
 */
export function AlignedSideMenuController({ sideMenu }: { sideMenu?: React.FC<SideMenuProps> }) {
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, {
    selector: state => state?.block,
  });

  const floatingUIOptions = useMemo<Partial<FloatingUIOptions>>(
    () => ({
      useFloatingOptions: {
        middleware: [firstLineOffset(editor, block)],
      },
    }),
    [editor, block]
  );

  return <SideMenuController sideMenu={sideMenu} floatingUIOptions={floatingUIOptions} />;
}

function firstLineOffset(editor: Editor, block: SideMenuBlock | undefined): Middleware {
  return {
    name: 'firstLineOffset',
    // floating-ui decides whether the middleware changed by deep-comparing
    // these options and comparing `fn` by its SOURCE text, so without the block
    // id here every new closure looks identical and the first block's sticks.
    options: { blockId: block?.id },
    fn: ({ y, rects }) => {
      if (!block) return {};
      // The side menu's block is a snapshot from when the pointer arrived, and
      // the block can change under it (``` turns a paragraph into a code
      // block); the popover re-runs this on resize, so read the current one.
      const current = editor.getBlock(block.id) ?? block;
      // A code block's first row is its header bar (language, filename), not
      // its first line of code; the handle stays level with the header.
      const measured =
        current.type === 'codeBlock'
          ? undefined
          : measureFirstLine(editor, current.id, rects.floating.height);
      // On the "left-start" placement the cross axis is the vertical one.
      return { y: y + (measured ?? fallbackOffset(editor, current)) };
    },
  };
}

/** How far below the block's top the menu must start to sit centered on the
 *  block's first line of text, or undefined when the block has no text. */
function measureFirstLine(editor: Editor, blockId: string, menuHeight: number): number | undefined {
  const blockEl = editor.prosemirrorView?.dom.querySelector(
    `.bn-block[data-id="${CSS.escape(blockId)}"]`
  );
  // The block's own content comes before its children's, so the first match
  // is this block's, unless the block renders none and it is a child's.
  const content = blockEl?.querySelector('.bn-block-content');
  const line = content?.querySelector('.bn-inline-content');
  if (!blockEl || !line || content?.closest('.bn-block') !== blockEl) return undefined;

  const style = getComputedStyle(line);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2; // `normal`
  const lineTop =
    line.getBoundingClientRect().top +
    parseFloat(style.paddingTop) +
    parseFloat(style.borderTopWidth);
  return lineTop + lineHeight / 2 - blockEl.getBoundingClientRect().top - menuHeight / 2;
}

function fallbackOffset(editor: Editor, block: SideMenuBlock): number {
  // An empty file block renders the same "Add file" button whatever its type.
  if (
    editor.schema.blockSpecs[block.type]?.implementation.meta?.fileBlockAccept &&
    !block.props.url
  ) {
    return 12;
  }
  if (block.type === 'file') return 4;
  if (block.type === 'audio' || block.type === 'table') return 15;
  return 0;
}
