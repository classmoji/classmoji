/**
 * @classmoji/page-schema — the page block schema, shared by the pages editor,
 * the collab server and the git worker. Browser- and server-safe: no React
 * renderers of its own, no DOM at import time, no app aliases (it runs under
 * `node --experimental-strip-types`). Yjs/server helpers, which pull in
 * @blocknote/server-util and jsdom, are in `@classmoji/page-schema/server`.
 */
export {
  SCHEMA_VERSION,
  FRAGMENT,
  META_MAP,
  COVER_IMAGE_KEY,
  NAV_GRID_EMPTY_ENTRIES,
} from './constants.ts';
export {
  calloutConfig,
  terminalConfig,
  profileConfig,
  dividerConfig,
  embedConfig,
  videoConfig,
  pageLinkConfig,
  navGridConfig,
  imageConfig,
  imageMeta,
  customBlockConfigs,
  type CustomBlockType,
} from './configs.ts';
export {
  REPLACED_DEFAULT_BLOCKS,
  pageDefaultBlockSpecs,
  createPageCodeBlockSpec,
  createPageSchema,
  type PageSchema,
} from './schema.ts';
export {
  serializePageContent,
  parsePageContent,
  type PageContent,
  type PageCoverImage,
} from './content.ts';
