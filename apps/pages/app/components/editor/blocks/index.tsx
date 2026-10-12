import type { JSX } from 'react';
import { BlockNoteSchema, type BlockNoteEditor } from '@blocknote/core';
import { insertOrUpdateBlockForSlashMenu } from '@blocknote/core/extensions';
import { multiColumnSchema } from '@blocknote/xl-multi-column';
import { createPageCodeBlockSpec, pageDefaultBlockSpecs } from '@classmoji/page-schema';
import {
  IconBulb,
  IconTerminal,
  IconUserCircle,
  IconMinus,
  IconWorld,
  IconPlayerPlay,
  IconFileText,
  IconLayoutGrid,
  IconLock,
  IconSquareCheck,
  IconUserCheck,
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
import { LockedSection, focusLockedSectionTitle } from './LockedSectionBlock.tsx';

/**
 * BlockNote schema with all built-in + custom block specs.
 *
 * Built-in blocks: paragraph, heading, bulletListItem, numberedListItem,
 * checkListItem, codeBlock, table, image, file, audio, quote
 * Excluded: video (using custom video block instead)
 *
 * XL package (2): column, columnList
 *
 * Custom blocks (9): callout, terminal, profile, divider, embed, video, pageLink,
 * navGrid, lockedSection
 *
 * `heading` is the shared page heading (BlockNote's plus `checkable`), from
 * `pageDefaultBlockSpecs()`.
 *
 * Every block's CONFIG (type, propSchema, content) comes from
 * @classmoji/page-schema; this file attaches the React renderers. The collab
 * server and the git worker build the same schema without React from the same
 * configs (`createPageSchema()`), and tests/unit/page-schema-parity.spec.ts
 * pins the two ProseMirror schemas to each other. A config change there means
 * a SCHEMA_VERSION bump.
 */
// Remove video, codeBlock and image from default blocks. The first two are
// replaced; `image` is replaced by the same block with responsive candidates
// (see ImageBlock.tsx) — the attributes have to be on the element before it is
// inserted, so they have to come from the render.
//
// `audio` is BlockNote's own, kept: it uploads through the same `uploadFile`
// as every file block, so a large recording on a Pro classroom lands in media
// and a small one stays in the repository, and it plays through
// `resolveFileUrl` like the image block's picture does.
const filteredDefaultBlockSpecs = pageDefaultBlockSpecs();

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...filteredDefaultBlockSpecs,
    // Override default code block with syntax highlighting
    codeBlock: createPageCodeBlockSpec(),
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
    lockedSection: LockedSection(), // Body hidden from a student until they unlock it
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

/** The heading levels the slash menu offers a checkable version of. */
const CHECKABLE_HEADING_LEVELS = [1, 2, 3] as const;

/**
 * Slash menu items for custom blocks.
 * These appear when the user types "/" in the editor.
 */
export const customSlashMenuItems: Array<{
  title: string;
  subtext: string;
  aliases: string[];
  group: string;
  /** Key of the item this one is listed directly after (slashMenuOrder.ts). */
  placeAfter?: string;
  icon: JSX.Element;
  onItemClick: (editor: PageBlockEditor) => void;
}> = [
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
  ...CHECKABLE_HEADING_LEVELS.map(level => ({
    title: `Checkable heading ${level}`,
    subtext: 'Students can mark the section done',
    // `h1`/`heading1` list it next to "Heading 1"; `check`/`checkable` list
    // all three.
    aliases: [
      'checkable',
      'check',
      'done',
      'step',
      'section',
      `h${level}`,
      `heading${level}`,
      `checkable${level}`,
    ],
    group: 'Headings',
    // Listed directly after the plain heading of the same level (BlockNote's
    // dictionary key for it), see slashMenuOrder.ts.
    placeAfter: level === 1 ? 'heading' : `heading_${level}`,
    icon: <IconSquareCheck size={18} />,
    onItemClick: (editor: PageBlockEditor) => {
      insertOrUpdateBlockForSlashMenu(editor, {
        type: 'heading',
        props: { level, checkable: true },
      });
    },
  })),
  {
    title: 'Student check list',
    subtext: 'Each student ticks their own',
    // `check`/`checklist`/`todo` list it next to BlockNote's "Check List".
    aliases: ['check', 'checklist', 'check list', 'student', 'personal', 'tick', 'todo', 'task'],
    group: 'Lists',
    // Directly after BlockNote's "Check List" (its dictionary key).
    placeAfter: 'check_list',
    icon: <IconUserCheck size={18} />,
    onItemClick: (editor: PageBlockEditor) => {
      insertOrUpdateBlockForSlashMenu(editor, {
        type: 'checkListItem',
        props: { personal: true },
      });
    },
  },
  {
    title: 'Locked section',
    subtext: 'Body opens with a hold',
    aliases: ['locked', 'lock', 'spoiler', 'solution', 'reveal', 'section'],
    group: 'Advanced',
    icon: <IconLock size={18} />,
    onItemClick: (editor: PageBlockEditor) => {
      const block = {
        type: 'lockedSection' as const,
        props: { title: '' },
        children: [{ type: 'paragraph' as const }],
      };
      // The slash menu replaces the line it was typed on when that line is
      // empty, children included; a line with children keeps them and the
      // section goes after it.
      const current = editor.getTextCursorPosition().block;
      const inserted =
        current.children.length > 0
          ? editor.insertBlocks([block], current, 'after')[0]
          : insertOrUpdateBlockForSlashMenu(editor, block);
      // The title is a field on the block: it takes the focus once drawn.
      if (inserted) focusLockedSectionTitle(inserted.id);
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
