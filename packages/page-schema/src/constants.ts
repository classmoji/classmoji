/**
 * Bump on ANY change to a block config (type, propSchema, content) or to the
 * set of blocks in `createPageSchema()`. The collab server refuses a browser
 * whose schema version differs: a participant with a different schema deletes
 * the blocks it does not know, for everyone in the room.
 */
export const SCHEMA_VERSION = 1;

/**
 * The Y.XmlFragment the page's blocks live in. BlockNote's server-util and
 * core/yjs helpers default to "prosemirror", so this must be passed
 * everywhere (editor binding, server reads and writes, the git worker).
 */
export const FRAGMENT = 'document-store';

/** Empty `navGrid.entries` — a JSON string, block props must be primitives. */
export const NAV_GRID_EMPTY_ENTRIES = '[]';

/** The Y.Map holding page-level fields that live outside the blocks. */
export const META_MAP = 'meta';

/** Key in META_MAP for `content.json.coverImage` (absent = no cover). */
export const COVER_IMAGE_KEY = 'coverImage';
