import { BlockNoteSchema, defaultBlockSpecs, createCodeBlockSpec } from '@blocknote/core';
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
} from '@tabler/icons-react';

import { Callout } from './CalloutBlock.jsx';
import { Terminal } from './TerminalBlock.jsx';
import { Profile } from './ProfileBlock.jsx';
import { Divider } from './DividerBlock.jsx';
import { Embed } from './EmbedBlock.jsx';
import { Video } from './VideoBlock.jsx';
import { PageLink } from './PageLinkBlock.jsx';

/**
 * BlockNote schema with all built-in + custom block specs.
 *
 * Built-in blocks (8): paragraph, heading, bulletListItem, numberedListItem,
 * checkListItem, codeBlock, table, image, file, quote
 * Excluded: audio, video (using custom video block instead)
 *
 * XL package (2): column, columnList
 *
 * Custom blocks (7): callout, terminal, profile, divider, embed, video, pageLink
 */
// Remove audio, video, and codeBlock from default blocks
const { audio, video: defaultVideo, codeBlock: defaultCodeBlock, ...filteredDefaultBlockSpecs } = defaultBlockSpecs;

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...filteredDefaultBlockSpecs,
    // Override default code block with syntax highlighting
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    ...multiColumnSchema.blockSpecs,
    callout: Callout(),
    terminal: Terminal(),
    profile: Profile(),
    divider: Divider(),
    embed: Embed(),
    video: Video(), // Custom video block
    pageLink: PageLink(), // Page link block (fetches pages via API)
  },
});

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
    onItemClick: (editor) => {
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
    onItemClick: (editor) => {
      editor.insertBlocks(
        [{ type: 'divider' }],
        editor.getTextCursorPosition().block,
        'after'
      );
    },
  },
  {
    title: 'Link to Page',
    subtext: 'Reference another page',
    aliases: ['page', 'link', 'reference', 'mention'],
    group: 'Basic blocks',
    icon: <IconFileText size={18} />,
    onItemClick: (editor) => {
      const currentBlock = editor.getTextCursorPosition().block;
      const newBlock = { type: 'pageLink' };

      // Replace current block and move cursor to the new block
      editor.replaceBlocks([currentBlock.id], [newBlock]);

      // Focus the new block immediately after insertion
      setTimeout(() => {
        const blocks = editor.document;
        const newBlockRef = blocks.find(b => b.type === 'pageLink' && !b.props.pageId);
        if (newBlockRef) {
          editor.setTextCursorPosition(newBlockRef, 'end');
        }
      }, 0);
    },
  },
  {
    title: 'Embed',
    subtext: 'Embed external content (iframe)',
    aliases: ['embed', 'iframe', 'codepen', 'codesandbox'],
    group: 'Media',
    icon: <IconWorld size={18} />,
    onItemClick: (editor) => {
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
    onItemClick: (editor) => {
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
    onItemClick: (editor) => {
      editor.insertBlocks(
        [{ type: 'terminal' }],
        editor.getTextCursorPosition().block,
        'after'
      );
    },
  },
  {
    title: 'Profile Card',
    subtext: 'User profile with avatar',
    aliases: ['profile', 'person', 'card', 'author'],
    group: 'Advanced',
    icon: <IconUserCircle size={18} />,
    onItemClick: (editor) => {
      editor.insertBlocks(
        [{ type: 'profile' }],
        editor.getTextCursorPosition().block,
        'after'
      );
    },
  },
];
