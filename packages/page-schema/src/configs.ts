import { createImageBlockConfig, defaultProps } from '@blocknote/core';

import { NAV_GRID_EMPTY_ENTRIES } from './constants.ts';

/**
 * BlockNote block CONFIGS (type, propSchema, content) for every custom block
 * the pages editor uses. One source of truth: the pages app builds its React
 * specs from these (`createReactBlockSpec(config, impl)`) and the collab
 * server and git worker build their DOM-free specs from the same objects
 * (`createPageSchema()`), so a prop cannot drift between them.
 *
 * Declared the way BlockNote infers them: `type`/`content` as literals, the
 * propSchema as a plain object (so a string default types the prop as
 * `string`, not as the literal default).
 *
 * Changing anything here changes the documents: bump SCHEMA_VERSION.
 */

const calloutPropSchema = {
  textAlignment: defaultProps.textAlignment,
  emoji: { default: '💡' },
};

export const calloutConfig = {
  type: 'callout' as const,
  propSchema: calloutPropSchema,
  content: 'inline' as const,
};

const terminalPropSchema = {
  code: { default: '' },
  title: { default: '' },
  /** Readers may copy the commands (a Copy button; select and copy). */
  copyable: { default: true },
};

export const terminalConfig = {
  type: 'terminal' as const,
  propSchema: terminalPropSchema,
  content: 'none' as const,
};

const profilePropSchema = {
  name: { default: '' },
  title: { default: '' },
  imageUrl: { default: '' },
  links: { default: '' },
};

export const profileConfig = {
  type: 'profile' as const,
  propSchema: profilePropSchema,
  content: 'none' as const,
};

export const dividerConfig = {
  type: 'divider' as const,
  propSchema: {},
  content: 'none' as const,
};

const embedPropSchema = {
  url: { default: '' },
  type: { default: '' },
};

export const embedConfig = {
  type: 'embed' as const,
  propSchema: embedPropSchema,
  content: 'none' as const,
};

const videoPropSchema = {
  url: { default: '' },
  caption: { default: '' },
};

export const videoConfig = {
  type: 'video' as const,
  propSchema: videoPropSchema,
  content: 'none' as const,
};

const pageLinkPropSchema = {
  pageId: { default: '' },
  pageTitle: { default: '' },
};

export const pageLinkConfig = {
  type: 'pageLink' as const,
  propSchema: pageLinkPropSchema,
  content: 'none' as const,
};

const navGridPropSchema = {
  /** JSON string — see apps/pages navGridShared.ts for the entry shape. */
  entries: { default: NAV_GRID_EMPTY_ENTRIES },
  columns: { default: 2, values: [1, 2] },
};

export const navGridConfig = {
  type: 'navGrid' as const,
  propSchema: navGridPropSchema,
  content: 'none' as const,
};

/**
 * The image block keeps BlockNote's own config (the app overrides only its
 * render, to add srcset/sizes). Re-exported so the app takes it from here too.
 */
export const imageConfig = createImageBlockConfig;

/**
 * Meta the image block's implementation carries. BlockNote's own values: they
 * mark it a file block (data-file-block, upload accept, drop matching).
 */
export const imageMeta = { fileBlockAccept: ['image/*'] };

/** Every app-defined block config, keyed by block type. */
export const customBlockConfigs = {
  callout: calloutConfig,
  terminal: terminalConfig,
  profile: profileConfig,
  divider: dividerConfig,
  embed: embedConfig,
  video: videoConfig,
  pageLink: pageLinkConfig,
  navGrid: navGridConfig,
} as const;

export type CustomBlockType = keyof typeof customBlockConfigs;
