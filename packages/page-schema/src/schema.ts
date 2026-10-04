import {
  BlockNoteSchema,
  createBlockSpec,
  createCodeBlockSpec,
  createImageBlockSpec,
  defaultBlockSpecs,
} from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import { multiColumnSchema } from '@blocknote/xl-multi-column';

import { customBlockConfigs, type CustomBlockType } from './configs.ts';

/**
 * Default BlockNote blocks the pages app REPLACES with its own spec of the
 * same type: `video` (custom block), `codeBlock` (syntax highlighting),
 * `image` (same config, responsive render).
 */
export const REPLACED_DEFAULT_BLOCKS = ['video', 'codeBlock', 'image'] as const;

/** BlockNote's default block specs minus the ones the app replaces. */
export function pageDefaultBlockSpecs() {
  const { video: _video, codeBlock: _codeBlock, image: _image, ...rest } = defaultBlockSpecs;
  return rest;
}

/** The code block every page schema uses: BlockNote's, with Shiki highlighting. */
export function createPageCodeBlockSpec() {
  return createCodeBlockSpec(codeBlockOptions);
}

/**
 * A block spec with the shared config and a render that draws nothing.
 *
 * The ProseMirror node (name, content, group, attrs) comes from the config
 * alone, which is all Yjs <-> blocks conversion needs. The render exists
 * only because BlockNote requires one; nothing on the server mounts it.
 */
function serverSpec<T extends CustomBlockType>(type: T) {
  const config = customBlockConfigs[type];
  const inline = config.content === 'inline';
  return createBlockSpec(config, {
    render: () => {
      const dom = globalThis.document?.createElement('div') as HTMLElement;
      return inline ? { dom, contentDOM: dom } : { dom };
    },
  })();
}

/**
 * The page block schema with no React, no DOM and no app aliases: BlockNote's
 * defaults (minus the replaced ones), the code block, the image block,
 * multi-column, and the app's custom blocks built from the shared configs.
 *
 * Block for block, the ProseMirror schema it produces is the pages editor's
 * (pinned by apps/pages/tests/unit/page-schema-parity.spec.ts).
 */
export function createPageSchema() {
  return BlockNoteSchema.create({
    blockSpecs: {
      ...pageDefaultBlockSpecs(),
      codeBlock: createPageCodeBlockSpec(),
      image: createImageBlockSpec(),
      ...multiColumnSchema.blockSpecs,
      callout: serverSpec('callout'),
      terminal: serverSpec('terminal'),
      profile: serverSpec('profile'),
      divider: serverSpec('divider'),
      embed: serverSpec('embed'),
      video: serverSpec('video'),
      pageLink: serverSpec('pageLink'),
      navGrid: serverSpec('navGrid'),
    },
  });
}

export type PageSchema = ReturnType<typeof createPageSchema>;
