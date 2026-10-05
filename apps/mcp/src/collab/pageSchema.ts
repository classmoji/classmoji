/**
 * Page blocks as the live document stores them: a round trip through the page
 * schema (`@classmoji/page-schema/server`: blocksToYDoc → yDocToBlocks), which
 * fills in BlockNote's default props and drops what the schema rejects. Used
 * for what the MCP caches after its own live apply, so the per-block check
 * compares like with like (the live server's snapshots are already in this
 * form).
 *
 * Loaded on first use: the server entry pulls in the BlockNote server editor
 * (jsdom), which no other MCP tool needs. `@classmoji/page-schema` is a
 * workspace package resolved from the root node_modules; apps/mcp's
 * package.json does not list it yet (adding it needs a lockfile refresh).
 */

type SchemaModule = {
  blocksToYDoc: (blocks: unknown[]) => unknown;
  yDocToBlocks: (doc: never) => unknown[];
};

let loading: Promise<SchemaModule | null> | null = null;

function loadPageSchema(): Promise<SchemaModule | null> {
  loading ??= import('@classmoji/page-schema/server').then(
    module => module as unknown as SchemaModule,
    error => {
      console.warn('[mcp] Page schema unavailable; live applies will not be cached:', error);
      return null;
    }
  );
  return loading;
}

/** Normalized blocks, or null when the schema cannot be loaded or rejects them. */
export async function normalizePageBlocks(blocks: unknown[]): Promise<unknown[] | null> {
  const schema = await loadPageSchema();
  if (!schema) return null;
  try {
    return schema.yDocToBlocks(schema.blocksToYDoc(blocks) as never);
  } catch (error) {
    console.warn('[mcp] Could not normalize blocks through the page schema:', error);
    return null;
  }
}
