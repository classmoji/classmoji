import {
  BlockNoteSchema,
  defaultBlockSpecs,
  createCodeBlockSpec,
  type BlockNoteEditor,
} from '@blocknote/core';
import { multiColumnSchema } from '@blocknote/xl-multi-column';
import { codeBlockOptions } from '@blocknote/code-block';
import {
  IconBulb,
  IconTerminal,
  IconUserCircle,
  IconMinus,
  IconWorld,
  IconPlayerPlay,
  IconFileText,
  IconLayoutGrid,
} from '@tabler/icons-react';

import { Callout } from './CalloutBlock.tsx';
import { Terminal } from './TerminalBlock.tsx';
import { Profile } from './ProfileBlock.tsx';
import { Divider } from './DividerBlock.tsx';
import { Embed } from './EmbedBlock.tsx';
import { Video } from './VideoBlock.tsx';
import { PageLink } from './PageLinkBlock.tsx';
import { NavGrid } from './NavGridBlock.tsx';
import { ResponsiveImage } from './ImageBlock.tsx';

/**
 * BlockNote schema with all built-in + custom block specs.
 *
 * Built-in blocks (8): paragraph, heading, bulletListItem, numberedListItem,
 * checkListItem, codeBlock, table, image, file, quote
 * Excluded: audio, video (using custom video block instead)
 *
 * XL package (2): column, columnList
 *
 * Custom blocks (8): callout, terminal, profile, divider, embed, video, pageLink,
 * navGrid
 */
// Remove audio, video, codeBlock and image from default blocks. The first three
// are replaced or dropped outright; `image` is replaced by the same block with
// responsive candidates (see ImageBlock.tsx) — the attributes have to be on the
// element before it is inserted, so they have to come from the render.
const {
  audio: _audio,
  video: _defaultVideo,
  codeBlock: _defaultCodeBlock,
  image: _defaultImage,
  ...filteredDefaultBlockSpecs
} = defaultBlockSpecs;

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...filteredDefaultBlockSpecs,
    // Override default code block with syntax highlighting
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    // Same block, same wrapper, same parse — plus srcset/sizes at render time.
    image: ResponsiveImage(),
    ...multiColumnSchema.blockSpecs,
    callout: Callout(),
    terminal: Terminal(),
    profile: Profile(),
    divider: Divider(),
    embed: Embed(),
    video: Video(), // Custom video block
    pageLink: PageLink(), // Page link block (fetches pages via API)
    navGrid: NavGrid(), // Page directory — authored navigation hub (class sites)
  },
});

export type PageBlockEditor =
  typeof schema extends BlockNoteSchema<infer BSchema, infer ISchema, infer SSchema>
    ? BlockNoteEditor<BSchema, ISchema, SSchema>
    : never;

export type PageBlockInsertions = Parameters<PageBlockEditor['insertBlocks']>[0];
export type PageBlock = PageBlockInsertions[number];

// Alias for compatibility
export const createSchemaWithPages = () => schema;

/**
 * Slash menu items for custom blocks.
 * These appear when the user types "/" in the editor.
 */
export const customSlashMenuItems = [
  {
    title: 'Callout',
    subtext: 'Highlighted box with emoji',
    aliases: ['callout', 'highlight', 'tip'],
    group: 'Basic blocks',
    icon: <IconBulb size={18} />,
    onItemClick: (editor: PageBlockEditor) => {
      const currentBlock = editor.getTextCursorPosition().block;
      editor.replaceBlocks([currentBlock], [{ type: 'callout', props: { emoji: '💡' } }]);
    },
  },
  {
    title: 'Divider',
    subtext: 'Horizontal rule',
    aliases: ['divider', 'hr', 'separator'],
    group: 'Basic blocks',
    icon: <IconMinus size={18} />,
    onItemClick: (editor: PageBlockEditor) => {
      editor.insertBlocks([{ type: 'divider' }], editor.getTextCursorPosition().block, 'after');
    },
  },
  {
    title: 'Link to Page',
    subtext: 'Reference another page',
    aliases: ['page', 'link', 'reference', 'mention'],
    group: 'Basic blocks',
    icon: <IconFileText size={18} />,
    onItemClick: (editor: PageBlockEditor) => {
      const currentBlock = editor.getTextCursorPosition().block;
      const newBlock = { type: 'pageLink' } as const;

      // Replace current block and move cursor to the new block
      editor.replaceBlocks([currentBlock.id], [newBlock]);

      // Focus the new block immediately after insertion
      setTimeout(() => {
        const blocks = editor.document;
        const newBlockRef = blocks.find(
          (b: { type: string; props: Record<string, unknown> }) =>
            b.type === 'pageLink' && !b.props.pageId
        );
        if (newBlockRef) {
          editor.setTextCursorPosition(newBlockRef, 'end');
        }
      }, 0);
    },
  },
  {
    title: 'Page directory',
    subtext: 'Grid of links to pages and external sites',
    aliases: ['directory', 'nav', 'hub', 'links', 'pages'],
    group: 'Basic blocks',
    icon: <IconLayoutGrid size={18} />,
    onItemClick: (editor: PageBlockEditor) => {
      const currentBlock = editor.getTextCursorPosition().block;
      editor.replaceBlocks([currentBlock], [{ type: 'navGrid' }]);
    },
  },
  {
    title: 'Embed',
    subtext: 'Embed external content (iframe)',
    aliases: ['embed', 'iframe', 'codepen', 'codesandbox'],
    group: 'Media',
    icon: <IconWorld size={18} />,
    onItemClick: (editor: PageBlockEditor) => {
      const currentBlock = editor.getTextCursorPosition().block;
      editor.replaceBlocks([currentBlock], [{ type: 'embed' }]);
    },
  },
  {
    title: 'Video',
    subtext: 'Embed a video (YouTube, Vimeo, etc.)',
    aliases: ['video', 'youtube', 'vimeo'],
    group: 'Media',
    icon: <IconPlayerPlay size={18} />,
    onItemClick: (editor: PageBlockEditor) => {
      const currentBlock = editor.getTextCursorPosition().block;
      editor.replaceBlocks([currentBlock], [{ type: 'video' }]);
    },
  },
  {
    title: 'Terminal',
    subtext: 'Terminal/command output block',
    aliases: ['terminal', 'shell', 'command', 'cli'],
    group: 'Code',
    icon: <IconTerminal size={18} />,
    onItemClick: (editor: PageBlockEditor) => {
      editor.insertBlocks([{ type: 'terminal' }], editor.getTextCursorPosition().block, 'after');
    },
  },
  {
    title: 'Profile Card',
    subtext: 'User profile with avatar',
    aliases: ['profile', 'person', 'card', 'author'],
    group: 'Advanced',
    icon: <IconUserCircle size={18} />,
    onItemClick: (editor: PageBlockEditor) => {
      editor.insertBlocks([{ type: 'profile' }], editor.getTextCursorPosition().block, 'after');
    },
  },
];
