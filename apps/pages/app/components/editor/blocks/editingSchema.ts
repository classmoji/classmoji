import React from 'react';
import {
  BlockNoteSchema,
  audioParse,
  createAudioBlockConfig,
  createFileBlockConfig,
  fileParse,
} from '@blocknote/core';
import {
  AudioBlock,
  AudioToExternalHTML,
  FileBlockWrapper,
  LinkWithCaption,
  createReactBlockSpec,
} from '@blocknote/react';

import { schema } from './index.tsx';

/**
 * The schema the page EDITOR runs with: the shared one, with the `file` and
 * `audio` blocks drawn by BlockNote's React wrapper instead of its DOM one.
 *
 * ## Why
 *
 * BlockNote's default `file` and `audio` blocks render through
 * `createFileBlockWrapper` in @blocknote/core. For an empty block it listens
 * for `onUploadStart` only: it takes the "Add file" button out of the DOM and
 * puts a "Loading..." line in its place, and never listens for the end. It
 * relies on the successful upload's `updateBlock` changing the block, which
 * makes ProseMirror build the node view again. A refused or failed upload
 * changes nothing, so the block stays on "Loading..." with no button to open
 * the upload panel again until the page is reloaded.
 *
 * The React wrapper (`FileBlockWrapper`) keeps the same state in
 * `useUploadLoading`, which listens for both the start and the end, so a
 * failed upload puts the block back to its empty state. It is BlockNote's own
 * composition, the same one the image block (`ImageBlock.tsx`) and the viewer
 * (`viewerBlocks.tsx`) already use.
 *
 * ## Why editor-only
 *
 * The shared `schema` is also what the class site's static schema is built
 * from, on the server, where a React file block has no editor to render
 * against. The upload state only exists in the editor, so only the editor
 * needs these.
 *
 * `meta.fileBlockAccept` is not optional: it puts `data-file-block` on the
 * block (every file-block style is scoped under it), sets the upload tab's
 * `accept`, and decides which block a dropped or pasted file becomes. The
 * values are BlockNote's own for these two blocks. The configs and `parse`
 * are BlockNote's too, so documents read and save identically.
 *
 * No JSX: Playwright's test transform rewrites JSX in app files, and the unit
 * suite imports this module.
 */

const h = React.createElement;

type FileWrapperProps = Parameters<typeof FileBlockWrapper>[0];
type AudioProps = Parameters<typeof AudioBlock>[0];

/** BlockNote's `file` block, drawn by the React wrapper. */
export const EditorFileBlock = createReactBlockSpec(createFileBlockConfig, {
  meta: { fileBlockAccept: ['*/*'] },
  parse: fileParse(),
  render: props => h(FileBlockWrapper, props as unknown as FileWrapperProps),
  // BlockNote's own export for this block (`ReactFileBlock`).
  toExternalHTML: props => {
    const { url, name, caption } = props.block.props;
    if (!url) return h('p', null, 'Add file');
    const link = h('a', { href: url }, name || url);
    return caption ? h(LinkWithCaption, { caption, children: link }) : link;
  },
});

/** BlockNote's `audio` block, drawn by the React wrapper. */
export const EditorAudioBlock = createReactBlockSpec(createAudioBlockConfig, config => ({
  meta: { fileBlockAccept: ['audio/*'] },
  parse: audioParse(config),
  render: props => h(AudioBlock, props as unknown as AudioProps),
  toExternalHTML: AudioToExternalHTML,
  runsBefore: ['file'],
}));

type SchemaOptions = NonNullable<Parameters<typeof BlockNoteSchema.create>[0]>;

/**
 * Typed as the shared schema: the two blocks keep BlockNote's configs, so
 * the documents, block types and props are the same — only the render differs.
 */
export const editingSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...schema.blockSpecs,
    file: EditorFileBlock(),
    audio: EditorAudioBlock(),
  } as SchemaOptions['blockSpecs'],
}) as unknown as typeof schema;
